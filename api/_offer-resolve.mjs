// ════════════════════════════════════════════════════════════════
// api/_offer-resolve.mjs — authoritative, pure offer resolution (Phase 2).
//
// Maps a Stripe payment to ONE offer (plan_code) for entitlement granting,
// using ONLY trustworthy signals, highest-trust first:
//   1) stripe_price_id  (the source of truth — see scanner_plans.stripe_price_id)
//   2) metadata.plan_code (our own Checkout sets this)
//   3) → NOTHING. Ambiguous payment must NEVER auto-grant access (CLAUDE.md §10).
//
// `amountTotalThb` is advisory ONLY: it can set `mismatch=true` to flag a
// price/amount disagreement for founder review, but it can never SELECT a grant.
// This closes the existing webhook's default-grant-`scanner_paid` risk (R11/R12).
//
// Pure & side-effect free → unit-testable without Stripe or a database.
// .mjs so it (and its tests) run under plain Node and can be imported by api/*.js.
// ════════════════════════════════════════════════════════════════

// Known offers and what each grants. `grants:false` means "recognized, but NEVER
// granted on payment" (Private Sprint is application-only + founder-approved).
// Legacy plan_codes are intentionally absent — they resolve via the legacy path,
// not this strict resolver.
export const OFFERS = {
  lego_scanner_founding: { entitlement_type: "scanner_access", grants: true, access_duration_days: 365, expected_thb: 5900 },
  lego_scanner: { entitlement_type: "scanner_access", grants: true, access_duration_days: 365, expected_thb: 5900 },
  lego_method: { entitlement_type: "lego_method_access", grants: true, access_duration_days: null, expected_thb: 14900 },
  lego_private_sprint: { entitlement_type: "none", grants: false, access_duration_days: null, expected_thb: 59900 },
};

/**
 * Build a stripe_price_id → plan_code index from scanner_plans rows.
 * ONLY active rows with a price_id are indexed: an inactive offer or one whose
 * price_id is not yet set is deliberately non-resolvable (no grant path).
 * @param {Array<{plan_code:string, stripe_price_id?:string, is_active?:boolean}>} plans
 * @returns {Record<string,string>}
 */
export function buildPriceIndex(plans) {
  const index = {};
  if (!Array.isArray(plans)) return index;
  for (const p of plans) {
    if (p && p.is_active !== false && p.stripe_price_id && p.plan_code) {
      index[String(p.stripe_price_id)] = String(p.plan_code);
    }
  }
  return index;
}

/**
 * @typedef {Object} OfferResolution
 * @property {(string|null)} plan_code
 * @property {(string|null)} entitlement_type   scanner_access | lego_method_access | none | null
 * @property {boolean} grants                    true only if this offer may be granted on payment
 * @property {('price_id'|'metadata'|'none')} confidence
 * @property {boolean} mismatch                  amount disagreed with the resolved offer (advisory)
 */

/**
 * Resolve a Stripe payment to an offer. Deterministic; never grants on ambiguity.
 * @param {{priceId?:string, metadataPlanCode?:string, amountTotalThb?:number}} signals
 * @param {Record<string,string>} priceIndex  stripe_price_id → plan_code (see buildPriceIndex)
 * @returns {OfferResolution}
 */
export function resolveOffer(signals, priceIndex = {}) {
  const s = signals && typeof signals === "object" ? signals : {};
  const none = { plan_code: null, entitlement_type: null, grants: false, confidence: "none", mismatch: false };

  let plan_code = null;
  let confidence = "none";

  // 1) price_id — authoritative
  const priceId = typeof s.priceId === "string" ? s.priceId : null;
  if (priceId && priceIndex && priceIndex[priceId]) {
    plan_code = priceIndex[priceId];
    confidence = "price_id";
  }

  // 2) metadata.plan_code — our own Checkout signal, only if it names a known offer
  if (!plan_code) {
    const mpc = typeof s.metadataPlanCode === "string" ? s.metadataPlanCode.trim() : "";
    if (mpc && Object.prototype.hasOwnProperty.call(OFFERS, mpc)) {
      plan_code = mpc;
      confidence = "metadata";
    }
  }

  // 3) nothing trustworthy → no grant
  if (!plan_code) return none;

  const offer = OFFERS[plan_code];
  if (!offer) return none; // resolved a code we don't recognize → refuse to grant

  // Advisory amount check (never selects/blocks a grant on its own).
  let mismatch = false;
  const amt = Number(s.amountTotalThb);
  if (Number.isFinite(amt) && amt > 0 && offer.expected_thb && amt !== offer.expected_thb) {
    mismatch = true;
  }

  return {
    plan_code,
    entitlement_type: offer.entitlement_type,
    grants: offer.grants === true,
    access_duration_days: offer.access_duration_days ?? null,
    confidence,
    mismatch,
  };
}
