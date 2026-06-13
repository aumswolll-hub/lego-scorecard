// ════════════════════════════════════════════════════════════════
// Entitlement resolver + writer (Phase 1).
//
// The single place that answers "what access does this user have?".
// It reads the UNION of two sources and is GRANT-ONLY across them:
//
//   1. Legacy `customers` (read-only, sovereign) — existing 225 users,
//      including the 120 founding `legacy_scanner` and the LEGO METHOD
//      students. Never written here.
//   2. New `user_entitlements` — per-source rows (the 12-month pass, and
//      future sources). A refunded/expired pass flips ONLY its own row.
//
// Because access is the OR of all sources, a cancelled/refunded/expired
// Scanner pass can never remove access granted by METHOD, admin, legacy,
// or promotion. (Constraints #1, #2, #5, #7.)
// ════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMIT = parseInt(process.env.FREE_SCAN_LIMIT || "3", 10);
const UNLIMITED = 999999;

// Legacy customer plans that count as PAID scanner access.
const PAID_LEGACY_PLANS = new Set([
  "scanner_paid",
  "legacy_scanner",
  "lego_method",
  "legacy_method",
  "admin",
  "lego_sprint",
]);

function sbRest(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : "";
}

// ── Resolver ─────────────────────────────────────────────────────
// Returns a stable shape every page/endpoint can rely on.
export async function resolveUserEntitlements(email, userId = null) {
  email = normalizeEmail(email);

  const result = {
    email,
    user_id: userId,
    has_scanner_access: false, // can use the scanner at all (free included)
    is_paid_scanner: false, // has a PAID scanner source (pass / legacy paid / method)
    has_method_access: false,
    effective_scanner_plan: "free",
    monthly_scan_limit: FREE_LIMIT,
    scanner_access_ends_at: null, // expiry of the pass, when that is the source
    entitlement_sources: [],
    subscription_status: null, // reserved for future recurring
    billing_interval: null,
  };

  if (!email || !SUPABASE_URL || !SERVICE_KEY) return result;

  // 1) Legacy customers (sovereign, read-only)
  try {
    const res = await sbRest(
      `customers?email=eq.${encodeURIComponent(email)}&active=eq.true&deactivated_at=is.null` +
        `&select=plan,has_method,legacy_unlimited,monthly_scan_limit`
    );
    if (res.ok) {
      const rows = await res.json();
      for (const c of rows) {
        result.has_scanner_access = true;
        const isPaid = PAID_LEGACY_PLANS.has(c.plan);
        if (isPaid) result.is_paid_scanner = true;
        if (c.has_method) result.has_method_access = true;

        const limit = c.legacy_unlimited
          ? UNLIMITED
          : Number(c.monthly_scan_limit || 0) || (isPaid ? UNLIMITED : FREE_LIMIT);
        if (limit > result.monthly_scan_limit) result.monthly_scan_limit = limit;

        if (isPaid && result.effective_scanner_plan === "free") {
          result.effective_scanner_plan = c.plan;
        }
        result.entitlement_sources.push({ source: "legacy_customer", plan: c.plan, paid: isPaid });
      }
    }
  } catch (err) {
    console.error("[entitlements] legacy read error:", err);
  }

  // 2) New entitlements (active, not expired). Embed plan config for the limit.
  try {
    const nowIso = new Date().toISOString();
    const res = await sbRest(
      `user_entitlements?email=eq.${encodeURIComponent(email)}` +
        `&entitlement_type=eq.scanner_access&status=eq.active` +
        `&select=plan_code,source,ends_at,starts_at,scanner_plans(included_scans_per_month,billing_type)`
    );
    if (res.ok) {
      const rows = await res.json();
      for (const e of rows) {
        // Skip expired passes (ends_at in the past).
        if (e.ends_at && new Date(e.ends_at) <= new Date(nowIso)) continue;

        result.has_scanner_access = true;
        result.is_paid_scanner = true;

        const planCfg = e.scanner_plans || {};
        const limit = Number(planCfg.included_scans_per_month || 0) || UNLIMITED;
        if (limit > result.monthly_scan_limit) result.monthly_scan_limit = limit;

        if (e.plan_code) result.effective_scanner_plan = e.plan_code;

        // Track the furthest pass expiry (for the access-status page).
        if (e.ends_at) {
          if (!result.scanner_access_ends_at || new Date(e.ends_at) > new Date(result.scanner_access_ends_at)) {
            result.scanner_access_ends_at = e.ends_at;
          }
        }
        result.entitlement_sources.push({ source: e.source, plan: e.plan_code, ends_at: e.ends_at });
      }
    }
  } catch (err) {
    console.error("[entitlements] new read error:", err);
  }

  return result;
}

// ── Idempotency ──────────────────────────────────────────────────
// Insert the event id; PK conflict means we've already processed it.
// Returns { alreadyProcessed: boolean }.
export async function recordStripeEvent(eventId, eventType, payloadRef = null) {
  if (!eventId) return { alreadyProcessed: false };
  try {
    const res = await sbRest(`stripe_events`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        stripe_event_id: eventId,
        event_type: eventType || null,
        status: "processed",
        payload_reference: payloadRef,
      }),
    });
    if (res.status === 409) return { alreadyProcessed: true }; // duplicate PK
    if (!res.ok) {
      const t = await res.text();
      console.warn("[entitlements] stripe_events insert non-ok:", res.status, t.slice(0, 200));
      return { alreadyProcessed: false };
    }
    return { alreadyProcessed: false };
  } catch (err) {
    console.error("[entitlements] recordStripeEvent error:", err);
    return { alreadyProcessed: false };
  }
}

// ── Grant a one-time Scanner pass ───────────────────────────────
// Idempotent: the unique index on stripe_payment_intent_id rejects a second
// grant for the same payment (409 → treated as success).
export async function grantScannerPass({
  email,
  userId = null,
  planCode = "lego_scanner_founding",
  accessDurationDays = 365,
  stripeCustomerId = null,
  stripeCheckoutSessionId = null,
  stripePaymentIntentId = null,
  stripePriceId = null,
}) {
  email = normalizeEmail(email);
  if (!email) throw new Error("grantScannerPass: missing email");

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + accessDurationDays * 24 * 60 * 60 * 1000);

  const payload = {
    user_id: userId,
    email,
    entitlement_type: "scanner_access",
    product_code: planCode,
    plan_code: planCode,
    source: "stripe_one_time",
    source_reference_id: stripePaymentIntentId || stripeCheckoutSessionId,
    status: "active",
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    stripe_customer_id: stripeCustomerId,
    stripe_checkout_session_id: stripeCheckoutSessionId,
    stripe_payment_intent_id: stripePaymentIntentId,
    stripe_price_id: stripePriceId,
  };

  const res = await sbRest(`user_entitlements`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });

  if (res.status === 409) {
    // Unique payment_intent → already granted. Safe no-op.
    console.log("[entitlements] pass already granted for payment_intent:", stripePaymentIntentId);
    return { ok: true, duplicate: true, email, endsAt: endsAt.toISOString() };
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`grantScannerPass insert failed: ${res.status} ${t.slice(0, 300)}`);
  }

  console.log("[entitlements] granted scanner pass:", { email, planCode, endsAt: endsAt.toISOString() });
  return { ok: true, duplicate: false, email, endsAt: endsAt.toISOString() };
}

// ── Refund: revoke only the matching Stripe entitlement row ──────
export async function refundScannerPassByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return { ok: true, matched: false };
  const res = await sbRest(
    `user_entitlements?stripe_payment_intent_id=eq.${encodeURIComponent(paymentIntentId)}&source=eq.stripe_one_time`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "refunded", updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) {
    const t = await res.text();
    console.warn("[entitlements] refund patch non-ok:", res.status, t.slice(0, 200));
    return { ok: false, matched: false };
  }
  const rows = await res.json().catch(() => []);
  const matched = Array.isArray(rows) && rows.length > 0;
  if (matched) console.log("[entitlements] refunded pass for payment_intent:", paymentIntentId);
  return { ok: true, matched };
}

// Look up the active plan config (used by checkout + webhook).
export async function getPlan(planCode) {
  try {
    const res = await sbRest(
      `scanner_plans?plan_code=eq.${encodeURIComponent(planCode)}&select=*`
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch (err) {
    console.error("[entitlements] getPlan error:", err);
    return null;
  }
}
