// Unit tests for the entitlement grant/resolve layer (Phase 2 additions).
// Run: `npm test` (node --test). Uses a stubbed global.fetch — no real network.
//
// Env must be set BEFORE importing the module (it reads SUPABASE_URL/KEY at load),
// so the module is loaded via dynamic import after env is in place.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const ent = await import("./_entitlements.mjs");

// ── tiny fetch stub harness ──────────────────────────────────────
function res(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}
// route(handlerByMatch): array of [substringMatch, responder(url, opts)]
function installFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [needle, responder] of routes) {
      if (String(url).includes(needle)) return responder(String(url), opts);
    }
    return res([], { ok: true, status: 200 });
  };
  return calls;
}

test("grantMethodAccess: writes lego_method_access, open-ended, upgrade stamp", async () => {
  const calls = installFetch([
    ["user_entitlements", () => res([{ id: "ent_1" }], { status: 201 })],
  ]);
  const out = await ent.grantMethodAccess({
    email: "Buyer@Example.com",
    planCode: "lego_method",
    accessDurationDays: null,
    stripePaymentIntentId: "pi_123",
    upgradedFrom: "scanner",
  });
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, false);
  const posted = calls.find((c) => c.url.includes("user_entitlements") && c.opts.method === "POST");
  assert.equal(posted.body.entitlement_type, "lego_method_access");
  assert.equal(posted.body.source, "lego_method_purchase");
  assert.equal(posted.body.email, "buyer@example.com"); // normalized
  assert.equal(posted.body.ends_at, null); // open-ended
  assert.deepEqual(posted.body.metadata, { upgraded_from: "scanner" });
});

test("grantMethodAccess: 409 (duplicate payment_intent) → idempotent no-op", async () => {
  installFetch([["user_entitlements", () => res({}, { ok: false, status: 409 })]]);
  const out = await ent.grantMethodAccess({ email: "a@b.com", stripePaymentIntentId: "pi_dup" });
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, true);
});

test("grantMethodAccess: missing email throws (never grants anonymously)", async () => {
  installFetch([]);
  await assert.rejects(() => ent.grantMethodAccess({ email: "" }), /missing email/);
});

test("resolveUserEntitlements: a lego_method_access row → method + paid", async () => {
  installFetch([
    ["customers", () => res([])], // no legacy customer
    ["entitlement_type=eq.scanner_access", () => res([])], // no scanner pass
    [
      "entitlement_type=eq.lego_method_access",
      () => res([{ plan_code: "lego_method", source: "lego_method_purchase", ends_at: null, scanner_plans: { included_scans_per_month: 300 } }]),
    ],
  ]);
  const r = await ent.resolveUserEntitlements("student@x.com");
  assert.equal(r.has_method_access, true);
  assert.equal(r.is_paid_scanner, true);
  assert.equal(r.has_scanner_access, true); // Method implies scanner
  assert.equal(r.monthly_scan_limit >= 300, true);
});

test("isScannerToMethodUpgradeEligible: paid scanner & no method → true", async () => {
  installFetch([
    ["customers", () => res([])],
    [
      "entitlement_type=eq.scanner_access",
      () => res([{ plan_code: "lego_scanner", source: "stripe_one_time", ends_at: null, starts_at: null, scanner_plans: { included_scans_per_month: 100, billing_type: "one_time" } }]),
    ],
    ["entitlement_type=eq.lego_method_access", () => res([])],
  ]);
  assert.equal(await ent.isScannerToMethodUpgradeEligible("up@x.com"), true);
});

test("isScannerToMethodUpgradeEligible: already has method → false", async () => {
  installFetch([
    ["customers", () => res([])],
    ["entitlement_type=eq.scanner_access", () => res([])],
    ["entitlement_type=eq.lego_method_access", () => res([{ plan_code: "lego_method", ends_at: null, scanner_plans: { included_scans_per_month: 300 } }])],
  ]);
  assert.equal(await ent.isScannerToMethodUpgradeEligible("hasmethod@x.com"), false);
});

test("buildPriceIndex (via resolver) + grant routing stay decoupled", async () => {
  // sanity: listOfferPlans tolerates a non-ok response without throwing
  installFetch([["scanner_plans", () => res({}, { ok: false, status: 500 })]]);
  const plans = await ent.listOfferPlans();
  assert.deepEqual(plans, []);
});
