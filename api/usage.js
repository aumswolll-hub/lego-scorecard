// ════════════════════════════════════════════════
// /api/usage.js — Freemium + paid monthly scan usage
//
// GET  → คืน state ปัจจุบัน
// POST → นับ scan +1 เมื่อ scan สำเร็จเท่านั้น
//
// Plan limits:
// free = 3 scans
// scanner_paid = 100 scans/month
// lego_method = 300 scans/month
// admin = unlimited
// ════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMIT = parseInt(process.env.FREE_SCAN_LIMIT || "3", 10);
const SCANNER_PAID_LIMIT = parseInt(process.env.SCANNER_PAID_SCAN_LIMIT || "100", 10);
const LEGO_METHOD_LIMIT = parseInt(process.env.LEGO_METHOD_SCAN_LIMIT || "300", 10);
const ADMIN_LIMIT = 999999;

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

async function getOrCreateUsage(email) {
  const res = await sb(
    `scanner_user_usage?email=eq.${encodeURIComponent(email)}&select=*`
  );

  if (res.ok) {
    const rows = await res.json();
    if (rows.length) return rows[0];
  }

  const ins = await sb("scanner_user_usage", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      email,
      scans_used: 0,
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
    free_scan_limit: FREE_LIMIT,
    monthly_scan_limit: FREE_LIMIT,
    is_paid: false,
    is_lego_method_student: false,
    is_admin: false,
    plan: "free",
  };
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
      paid: c.is_paid === true || c.active === true,
      method: c.has_method === true,
    };
  } catch {
    return { paid: false, method: false };
  }
}

function getPlanLimit(plan, isPaid, isStudent, isAdmin, usageLimit) {
  if (isAdmin || plan === "admin") return ADMIN_LIMIT;

  if (isStudent || plan === "lego_method") {
    return Number(usageLimit || LEGO_METHOD_LIMIT);
  }

  if (isPaid || plan === "scanner_paid") {
    return Number(usageLimit || SCANNER_PAID_LIMIT);
  }

  return FREE_LIMIT;
}

function computeState(usage, customerPaid) {
  const planFromDb = usage.plan || "free";

  const isAdmin = usage.is_admin === true || planFromDb === "admin";

  const isStudent =
    usage.is_lego_method_student === true ||
    customerPaid.method === true ||
    planFromDb === "lego_method";

  const isPaid =
    usage.is_paid === true ||
    customerPaid.paid === true ||
    isStudent ||
    isAdmin ||
    planFromDb === "scanner_paid";

  let plan = "free";

  if (isAdmin) plan = "admin";
  else if (isStudent) plan = "lego_method";
  else if (isPaid) plan = "scanner_paid";

  const limit = getPlanLimit(
    plan,
    isPaid,
    isStudent,
    isAdmin,
    usage.monthly_scan_limit || usage.free_scan_limit
  );

  const used = Number(usage.scans_used || 0);
  const scansLeft = Math.max(0, limit - used);

  let state;

  if (isAdmin) state = "admin";
  else if (isStudent) state = "lego_method_student";
  else if (isPaid) state = "paid_scanner";
  else if (used >= limit) state = "free_limit_reached";
  else state = "logged_in_free";

  return {
    email: usage.email,
    scans_used: used,
    free_scan_limit: limit,
    monthly_scan_limit: limit,
    scans_left: scansLeft,
    is_paid: isPaid,
    is_lego_method_student: isStudent,
    is_admin: isAdmin,
    plan,
    state,
    can_scan: isAdmin || used < limit,
  };
}

async function syncEntitlementIfNeeded(usage, customerPaid) {
  let target = null;

  if (customerPaid.method && usage.plan !== "lego_method") {
    target = {
      plan: "lego_method",
      is_paid: true,
      is_lego_method_student: true,
      monthly_scan_limit: LEGO_METHOD_LIMIT,
      free_scan_limit: LEGO_METHOD_LIMIT,
      updated_at: new Date().toISOString(),
    };
  } else if (
    customerPaid.paid &&
    !customerPaid.method &&
    usage.plan !== "scanner_paid"
  ) {
    target = {
      plan: "scanner_paid",
      is_paid: true,
      is_lego_method_student: false,
      monthly_scan_limit: SCANNER_PAID_LIMIT,
      free_scan_limit: SCANNER_PAID_LIMIT,
      updated_at: new Date().toISOString(),
    };
  }

  if (!target) return usage;

  await sb(`scanner_user_usage?email=eq.${encodeURIComponent(usage.email)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(target),
  });

  return { ...usage, ...target };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
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
    const customerPaid = await checkCustomerPaid(email);

    usage = await syncEntitlementIfNeeded(usage, customerPaid);

    if (req.method === "GET") {
      return res.status(200).json(computeState(usage, customerPaid));
    }

    if (req.method === "POST") {
      const state = computeState(usage, customerPaid);

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
        { ...usage, scans_used: newCount },
        customerPaid
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
    return res.status(500).json({
      error: "server_error",
      message: String(err),
    });
  }
}
