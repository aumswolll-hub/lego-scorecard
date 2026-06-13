// ════════════════════════════════════════════════
// /api/usage.js — Freemium + paid monthly scan usage
// รองรับทั้ง Magic Session เดิม + Supabase Password Login ใหม่
//
// Source of truth:
// customers.plan
// customers.monthly_scan_limit
// customers.legacy_unlimited
//
// Plans:
// free = 3 scans/month
// scanner_paid = 100 scans/month
// lego_method = 300 scans/month
// legacy_scanner = unlimited / 999999
// legacy_method = unlimited / 999999
// admin = unlimited / 999999
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

// ───────────────────────────────────────────────
// AUTH: Magic Session เดิม
// ───────────────────────────────────────────────

async function getEmailFromMagicSession(token) {
  if (!token) return null;

  try {
    const res = await sb(
      `sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`
    );

    if (!res.ok) return null;

    const rows = await res.json();

    if (!rows.length) return null;

    if (new Date(rows[0].expires_at) < new Date()) return null;

    return String(rows[0].email).trim().toLowerCase();
  } catch (err) {
    console.error("[usage auth] magic session error:", err);
    return null;
  }
}

// ───────────────────────────────────────────────
// AUTH: Supabase Password Login ใหม่
// ───────────────────────────────────────────────

async function getEmailFromSupabaseAccessToken(token) {
  if (!token) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn("[usage auth] Supabase token invalid:", res.status, detail.slice(0, 300));
      return null;
    }

    const user = await res.json();

    if (!user || !user.email) return null;

    return String(user.email).trim().toLowerCase();
  } catch (err) {
    console.error("[usage auth] Supabase token verify error:", err);
    return null;
  }
}

async function getEmailFromSession(token) {
  if (!token) return null;

  let email = await getEmailFromMagicSession(token);

  if (!email) {
    email = await getEmailFromSupabaseAccessToken(token);
  }

  return email;
}

function getSessionToken(req) {
  return (
    req.headers["x-session-token"] ||
    (req.body && req.body.sessionToken) ||
    (req.query && req.query.sessionToken) ||
    null
  );
}

// ───────────────────────────────────────────────
// CUSTOMER ENTITLEMENT
// ───────────────────────────────────────────────

async function getCustomer(email) {
  if (!email) return null;

  try {
    const res = await sb(
      `customers?email=eq.${encodeURIComponent(email)}&select=email,active,is_paid,has_method,plan,monthly_scan_limit,legacy_unlimited,deactivated_at`
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[usage] customer query failed:", detail);
      return null;
    }

    const rows = await res.json();

    if (!rows.length) return null;

    const c = rows[0];

    if (c.active !== true) return null;
    if (c.deactivated_at !== null && c.deactivated_at !== undefined) return null;

    return c;
  } catch (err) {
    console.error("[usage] customer error:", err);
    return null;
  }
}

function resolveEntitlement(customer) {
  if (!customer) {
    return {
      plan: "free",
      limit: FREE_LIMIT,
      isAdmin: false,
      isStudent: false,
      isPaid: false,
      legacyUnlimited: false,
    };
  }

  const rawPlan = String(customer.plan || "").trim().toLowerCase();

  const legacyUnlimited = customer.legacy_unlimited === true;

  const hasMethod = customer.has_method === true;
  const isPaidCustomer = customer.is_paid === true;

  let plan = rawPlan || "free";
  let limit = Number(customer.monthly_scan_limit || 0);

  // ถ้า limit ใน database ยังไม่ดี ให้ fallback ตาม plan
  if (!limit || limit < 0) {
    if (plan === "admin") limit = ADMIN_LIMIT;
    else if (plan === "legacy_scanner" || plan === "legacy_method") limit = ADMIN_LIMIT;
    else if (plan === "lego_method") limit = LEGO_METHOD_LIMIT;
    else if (plan === "scanner_paid") limit = SCANNER_PAID_LIMIT;
    else if (hasMethod) limit = LEGO_METHOD_LIMIT;
    else if (isPaidCustomer) limit = SCANNER_PAID_LIMIT;
    else limit = FREE_LIMIT;
  }

  // legacy/admin = effectively unlimited
  if (
    legacyUnlimited ||
    plan === "legacy_scanner" ||
    plan === "legacy_method" ||
    plan === "admin"
  ) {
    limit = ADMIN_LIMIT;
  }

  // ถ้า plan ยังว่าง แต่ customer flags มีข้อมูล ให้ resolve ให้
  if (!rawPlan || rawPlan === "empty") {
    if (hasMethod) plan = "lego_method";
    else if (isPaidCustomer) plan = "scanner_paid";
    else plan = "free";
  }

  const isAdmin = plan === "admin";
  const isStudent =
    plan === "lego_method" ||
    plan === "legacy_method" ||
    isAdmin ||
    hasMethod === true;

  const isPaid =
    isAdmin ||
    isStudent ||
    plan === "scanner_paid" ||
    plan === "legacy_scanner" ||
    isPaidCustomer === true;

  return {
    plan,
    limit,
    isAdmin,
    isStudent,
    isPaid,
    legacyUnlimited:
      legacyUnlimited ||
      plan === "legacy_scanner" ||
      plan === "legacy_method" ||
      plan === "admin",
  };
}

// ───────────────────────────────────────────────
// NEW ENTITLEMENT LAYER (12-month Founding Pass)
// Read-only overlay: looks up an active, non-expired scanner pass in
// user_entitlements and GRANTS it on top of the legacy entitlement.
// It can only raise the limit / mark paid — never reduce legacy access.
// ───────────────────────────────────────────────

async function getActiveScannerPass(email) {
  if (!email) return null;
  try {
    const res = await sb(
      `user_entitlements?email=eq.${encodeURIComponent(email)}` +
        `&entitlement_type=eq.scanner_access&status=eq.active` +
        `&select=plan_code,ends_at,scanner_plans(included_scans_per_month)`
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const now = new Date();
    let best = null;
    for (const e of rows) {
      if (e.ends_at && new Date(e.ends_at) <= now) continue; // expired → does not grant
      const lim =
        Number((e.scanner_plans && e.scanner_plans.included_scans_per_month) || 0) ||
        SCANNER_PAID_LIMIT;
      if (!best || lim > best.limit) {
        best = { plan: e.plan_code || "scanner_pass", limit: lim, endsAt: e.ends_at || null };
      }
    }
    return best;
  } catch (err) {
    console.error("[usage] scanner pass lookup error:", err);
    return null;
  }
}

function mergePassEntitlement(entitlement, pass) {
  if (!pass) return entitlement;
  const limit = Math.max(Number(entitlement.limit || 0), Number(pass.limit || 0));
  const keepLegacyLabel = entitlement.isPaid && Number(entitlement.limit || 0) >= Number(pass.limit || 0);
  return {
    ...entitlement,
    plan: keepLegacyLabel ? entitlement.plan : pass.plan,
    limit,
    isPaid: true,
    scannerEndsAt: pass.endsAt || entitlement.scannerEndsAt || null,
  };
}

// ───────────────────────────────────────────────
// USAGE TABLE
// ───────────────────────────────────────────────

async function getOrCreateUsage(email, entitlement) {
  const res = await sb(
    `scanner_user_usage?email=eq.${encodeURIComponent(email)}&select=*`
  );

  if (res.ok) {
    const rows = await res.json();
    if (rows.length) return rows[0];
  }

  const month = currentMonth();

  const insertPayload = {
    email,
    scans_used: 0,
    usage_month: month,
    free_scan_limit: entitlement.limit,
    monthly_scan_limit: entitlement.limit,
    is_paid: entitlement.isPaid,
    is_lego_method_student: entitlement.isStudent,
    is_admin: entitlement.isAdmin,
    plan: entitlement.plan,
    updated_at: new Date().toISOString(),
  };

  const ins = await sb("scanner_user_usage", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(insertPayload),
  });

  if (ins.ok) {
    const rows = await ins.json();
    if (rows.length) return rows[0];
  }

  return insertPayload;
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
    headers: {
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });

  return {
    ...usage,
    ...patch,
  };
}

async function syncUsageEntitlement(usage, entitlement) {
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
    Number(usage.monthly_scan_limit || 0) !== Number(desired.monthly_scan_limit || 0) ||
    Number(usage.free_scan_limit || 0) !== Number(desired.free_scan_limit || 0);

  if (!needsPatch) return usage;

  const patch = {
    ...desired,
    updated_at: new Date().toISOString(),
  };

  await sb(`scanner_user_usage?email=eq.${encodeURIComponent(usage.email)}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });

  return {
    ...usage,
    ...patch,
  };
}

// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────

function computeState(usage, entitlement) {
  const used = Number(usage.scans_used || 0);
  const limit = Number(entitlement.limit || FREE_LIMIT);
  const scansLeft = Math.max(0, limit - used);

  let state = "logged_in_free";

  if (entitlement.isAdmin) {
    state = "admin";
  } else if (entitlement.legacyUnlimited) {
    state = entitlement.plan === "legacy_method" ? "legacy_method" : "legacy_scanner";
  } else if (entitlement.isStudent) {
    state = "lego_method_student";
  } else if (entitlement.isPaid) {
    state = "paid_scanner";
  } else if (used >= limit) {
    state = "free_limit_reached";
  }

  const canScan =
    entitlement.isAdmin ||
    entitlement.legacyUnlimited ||
    used < limit;

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
    legacy_unlimited: entitlement.legacyUnlimited,

    plan: entitlement.plan,
    state,
    can_scan: canScan,
    scanner_access_ends_at: entitlement.scannerEndsAt || null,
  };
}

// ───────────────────────────────────────────────
// HANDLER
// ───────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        error: "config_error",
        message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    req.body = body;

    const sessionToken = getSessionToken(req);

    const email = await getEmailFromSession(sessionToken);

    if (!email) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Session หมดอายุ",
      });
    }

    const customer = await getCustomer(email);

    // Free signups and pass holders have no customers row — they are NOT blocked.
    // Legacy customers resolve exactly as before; an active 12-month pass is
    // overlaid grant-only on top (can only raise the limit / mark paid).
    let entitlement = resolveEntitlement(customer); // free tier when no customer
    const scannerPass = await getActiveScannerPass(email);
    entitlement = mergePassEntitlement(entitlement, scannerPass);

    let usage = await getOrCreateUsage(email, entitlement);
    usage = await resetMonthIfNeeded(usage);
    usage = await syncUsageEntitlement(usage, entitlement);

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

      // admin/legacy ไม่ต้องนับแบบ block แต่ยังคืน state ให้ frontend
      if (state.is_admin || state.legacy_unlimited) {
        return res.status(200).json({
          ...state,
          counted: false,
          unlimited: true,
        });
      }

      const newCount = Number(usage.scans_used || 0) + 1;

      await sb(`scanner_user_usage?email=eq.${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal",
        },
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
