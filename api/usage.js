// ════════════════════════════════════════════════
// /api/usage.js — Freemium + paid monthly scan usage
//
// free = 3 scans/month
// scanner_paid = 100 scans/month
// lego_method = 300 scans/month
// admin = unlimited
//
// IMPORTANT:
// customers.active = login/account status only
// customers.is_paid = paid Scanner
// customers.has_method = LEGO METHOD
// ════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMIT = parseInt(process.env.FREE_SCAN_LIMIT || "3", 10);
const SCANNER_PAID_LIMIT = parseInt(process.env.SCANNER_PAID_SCAN_LIMIT || "100", 10);
const LEGO_METHOD_LIMIT = parseInt(process.env.LEGO_METHOD_SCAN_LIMIT || "300", 10);
const ADMIN_LIMIT = 999999;

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function sb(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function getEmailFromSession(token) {
  if (!token) return null;

  const res = await sb(
    `sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`
  );

  if (!res.ok) return null;

  const rows = await res.json();

  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;

  return rows[0].email;
}

async function checkCustomerPaid(email) {
  try {
    const res = await sb(
      `customers?email=eq.${encodeURIComponent(email)}&select=is_paid,has_method,active`
    );

    if (!res.ok) return { paid: false, method: false };

    const rows = await res.json();

    if (!rows.length) return { paid: false, method: false };

    const c = rows[0];

    return {
      paid: c.is_paid === true,
      method: c.has_method === true,
    };
  } catch {
    return { paid: false, method: false };
  }
}

function resolveEntitlement(usage, customerPaid) {
  const planFromDb = usage.plan || "free";

  const isAdmin = usage.is_admin === true || planFromDb === "admin";

  const isStudent =
    usage.is_lego_method_student === true ||
    customerPaid.method === true ||
    planFromDb === "lego_method";

  const isPaid =
    usage.is_paid === true ||
    customerPaid.paid === true ||
    planFromDb === "scanner_paid" ||
    isStudent ||
    isAdmin;

  let plan = "free";
  let limit = FREE_LIMIT;

  if (isAdmin) {
    plan = "admin";
    limit = ADMIN_LIMIT;
  } else if (isStudent) {
    plan = "lego_method";
    limit = LEGO_METHOD_LIMIT;
  } else if (isPaid) {
    plan = "scanner_paid";
    limit = SCANNER_PAID_LIMIT;
  }

  return {
    plan,
    limit,
    isAdmin,
    isStudent,
    isPaid,
  };
}

async function getOrCreateUsage(email) {
  const res = await sb(
    `scanner_user_usage?email=eq.${encodeURIComponent(email)}&select=*`
  );

  if (res.ok) {
    const rows = await res.json();
    if (rows.length) return rows[0];
  }

  const month = currentMonth();

  const ins = await sb("scanner_user_usage", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      email,
      scans_used: 0,
      usage_month: month,
      free_scan_limit: FREE_LIMIT,
      monthly_scan_limit: FREE_LIMIT,
      is_paid: false,
      is_lego_method_student: false,
      is_admin: false,
      plan: "free",
    }),
  });

  if (ins.ok) {
    const rows = await ins.json();
    if (rows.length) return rows[0];
  }

  return {
    email,
    scans_used: 0,
    usage_month: month,
    free_scan_limit: FREE_LIMIT,
    monthly_scan_limit: FREE_LIMIT,
    is_paid: false,
    is_lego_method_student: false,
    is_admin: false,
    plan: "free",
  };
}

async function resetMonthIfNeeded(usage) {
  const month = currentMonth();

  if (usage.usage_month === month) return usage;

  const patch = {
    scans_used: 0,
    usage_month: month,
    updated_at: new Date().toISOString(),
  };

  await sb(`scanner_user_usage?email=eq.${encodeURIComponent(usage.email)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });

  return {
    ...usage,
    ...patch,
  };
}

async function syncEntitlement(usage, entitlement) {
  const desired = {
    plan: entitlement.plan,
    is_paid: entitlement.isPaid,
    is_lego_method_student: entitlement.isStudent,
    is_admin: entitlement.isAdmin,
    monthly_scan_limit: entitlement.limit,
    free_scan_limit: entitlement.limit,
  };

  const needsPatch =
    usage.plan !== desired.plan ||
    usage.is_paid !== desired.is_paid ||
    usage.is_lego_method_student !== desired.is_lego_method_student ||
    usage.is_admin !== desired.is_admin ||
    Number(usage.monthly_scan_limit || 0) !== desired.monthly_scan_limit ||
    Number(usage.free_scan_limit || 0) !== desired.free_scan_limit;

  if (!needsPatch) return usage;

  const patch = {
    ...desired,
    updated_at: new Date().toISOString(),
  };

  await sb(`scanner_user_usage?email=eq.${encodeURIComponent(usage.email)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });

  return {
    ...usage,
    ...patch,
  };
}

function computeState(usage, entitlement) {
  const used = Number(usage.scans_used || 0);
  const limit = entitlement.limit;
  const scansLeft = Math.max(0, limit - used);

  let state = "logged_in_free";

  if (entitlement.isAdmin) state = "admin";
  else if (entitlement.isStudent) state = "lego_method_student";
  else if (entitlement.isPaid) state = "paid_scanner";
  else if (used >= limit) state = "free_limit_reached";

  return {
    email: usage.email,
    usage_month: usage.usage_month || currentMonth(),
    scans_used: used,
    monthly_scan_limit: limit,
    free_scan_limit: limit,
    scans_left: scansLeft,
    is_paid: entitlement.isPaid,
    is_lego_method_student: entitlement.isStudent,
    is_admin: entitlement.isAdmin,
    plan: entitlement.plan,
    state,
    can_scan: entitlement.isAdmin || used < limit,
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        error: "config_error",
        message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    const sessionToken =
      req.headers["x-session-token"] ||
      (req.body && req.body.sessionToken) ||
      (req.query && req.query.sessionToken);

    const email = await getEmailFromSession(sessionToken);

    if (!email) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Session หมดอายุ",
      });
    }

    let usage = await getOrCreateUsage(email);
    usage = await resetMonthIfNeeded(usage);

    const customerPaid = await checkCustomerPaid(email);
    const entitlement = resolveEntitlement(usage, customerPaid);

    usage = await syncEntitlement(usage, entitlement);

    if (req.method === "GET") {
      return res.status(200).json(computeState(usage, entitlement));
    }

    if (req.method === "POST") {
      const state = computeState(usage, entitlement);

      if (!state.can_scan) {
        return res.status(403).json({
          ...state,
          counted: false,
          blocked: true,
        });
      }

      if (state.is_admin) {
        return res.status(200).json({
          ...state,
          counted: false,
          unlimited: true,
        });
      }

      const newCount = Number(usage.scans_used || 0) + 1;

      await sb(`scanner_user_usage?email=eq.${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          scans_used: newCount,
          updated_at: new Date().toISOString(),
        }),
      });

      const newState = computeState(
        {
          ...usage,
          scans_used: newCount,
        },
        entitlement
      );

      return res.status(200).json({
        ...newState,
        counted: true,
      });
    }

    return res.status(405).json({
      error: "method_not_allowed",
    });
  } catch (err) {
    console.error("[usage] server error:", err);

    return res.status(500).json({
      error: "server_error",
      message: String(err),
    });
  }
}
