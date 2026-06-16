// Unit tests for the authoritative offer resolver (Phase 2, PR-2.1).
// Run: `npm test` (node --test). Pure function → no Stripe, no DB.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveOffer, buildPriceIndex, OFFERS } from "./_offer-resolve.mjs";

// A catalog as it would come from scanner_plans (only active + priced rows resolve).
const plans = [
  { plan_code: "lego_scanner", stripe_price_id: "price_scanner", is_active: true },
  { plan_code: "lego_method", stripe_price_id: "price_method", is_active: true },
  { plan_code: "lego_private_sprint", stripe_price_id: "price_sprint", is_active: true },
  { plan_code: "lego_scanner_founding", stripe_price_id: "price_founding", is_active: true },
  // inactive / unpriced rows must NOT resolve:
  { plan_code: "inactive_offer", stripe_price_id: "price_inactive", is_active: false },
  { plan_code: "unpriced_offer", stripe_price_id: null, is_active: true },
];
const index = buildPriceIndex(plans);

test("buildPriceIndex: only active + priced rows are indexed", () => {
  assert.equal(index["price_scanner"], "lego_scanner");
  assert.equal(index["price_method"], "lego_method");
  assert.equal(index["price_inactive"], undefined); // is_active=false
  assert.equal(Object.values(index).includes("unpriced_offer"), false); // no price_id
});

test("price_id is authoritative → resolves Scanner", () => {
  const r = resolveOffer({ priceId: "price_scanner" }, index);
  assert.equal(r.plan_code, "lego_scanner");
  assert.equal(r.entitlement_type, "scanner_access");
  assert.equal(r.grants, true);
  assert.equal(r.confidence, "price_id");
  assert.equal(r.mismatch, false);
});

test("price_id resolves Method (open-ended access)", () => {
  const r = resolveOffer({ priceId: "price_method" }, index);
  assert.equal(r.plan_code, "lego_method");
  assert.equal(r.entitlement_type, "lego_method_access");
  assert.equal(r.grants, true);
});

test("metadata.plan_code resolves only when no price_id, and only for known offers", () => {
  const r = resolveOffer({ metadataPlanCode: "lego_method" }, index);
  assert.equal(r.plan_code, "lego_method");
  assert.equal(r.confidence, "metadata");

  const unknown = resolveOffer({ metadataPlanCode: "totally_made_up" }, index);
  assert.equal(unknown.plan_code, null);
  assert.equal(unknown.confidence, "none");
  assert.equal(unknown.grants, false);
});

test("price_id wins over metadata when both present", () => {
  const r = resolveOffer({ priceId: "price_scanner", metadataPlanCode: "lego_method" }, index);
  assert.equal(r.plan_code, "lego_scanner");
  assert.equal(r.confidence, "price_id");
});

test("AMBIGUOUS payment → grants NOTHING (the core safety rule)", () => {
  for (const sig of [
    {},
    { priceId: "price_not_in_catalog" },
    { amountTotalThb: 5900 }, // amount alone never grants
    { metadataPlanCode: "" },
    { priceId: "price_inactive" }, // inactive offer
  ]) {
    const r = resolveOffer(sig, index);
    assert.equal(r.plan_code, null, `should not resolve: ${JSON.stringify(sig)}`);
    assert.equal(r.grants, false);
    assert.equal(r.confidence, "none");
  }
});

test("Private Sprint is recognized but NEVER granted on payment", () => {
  const r = resolveOffer({ priceId: "price_sprint" }, index);
  assert.equal(r.plan_code, "lego_private_sprint");
  assert.equal(r.entitlement_type, "none");
  assert.equal(r.grants, false); // application-only + founder-approved
});

test("amount disagreement sets mismatch=true but still resolves by price_id", () => {
  const r = resolveOffer({ priceId: "price_scanner", amountTotalThb: 1990 }, index);
  assert.equal(r.plan_code, "lego_scanner"); // price_id still authoritative
  assert.equal(r.mismatch, true); // 1990 (deprecated price) != 5900 → flagged
});

test("matching amount → no mismatch", () => {
  const r = resolveOffer({ priceId: "price_method", amountTotalThb: 14900 }, index);
  assert.equal(r.mismatch, false);
});

test("non-object / garbage signals never throw → none", () => {
  assert.equal(resolveOffer(null, index).plan_code, null);
  assert.equal(resolveOffer(undefined).plan_code, null);
  assert.equal(resolveOffer("nope", index).grants, false);
});

test("OFFERS sanity: grant flags are correct", () => {
  assert.equal(OFFERS.lego_scanner.grants, true);
  assert.equal(OFFERS.lego_method.grants, true);
  assert.equal(OFFERS.lego_private_sprint.grants, false);
});
