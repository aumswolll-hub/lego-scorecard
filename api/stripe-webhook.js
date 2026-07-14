// /api/stripe-webhook.js — Receive Stripe webhooks
// POST from Stripe → update Supabase customers entitlement when payment succeeds
//
// Supports:
// - Scanner paid = 100 scans/month
// - LEGO METHOD = 300 scans/month
// - Refund = deactivate customer
//
// IMPORTANT:
// This endpoint disables body parsing because Stripe requires RAW request body
// to verify the signature.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import {
  recordStripeEvent,
  grantScannerPass,
  grantMethodAccess,
  isScannerToMethodUpgradeEligible,
  refundScannerPassByPaymentIntent,
  getPlan,
  listOfferPlans,
  flagStripeEventForReview,
} from "./_entitlements.mjs";
import { resolveOffer, buildPriceIndex } from "./_offer-resolve.mjs";

// Phase 2 (PR-2.2): strict, price_id-authoritative grant resolution. OFF by
// default — a deploy changes nothing until the founder maps real Stripe price
// ids onto scanner_plans and flips this flag. When ON, an ambiguous payment is
// NEVER auto-granted (it is flagged for founder review instead) and recognized
// offers grant via the new entitlement layer (never the legacy customers table).
const OFFER_RESOLVE_STRICT = /^(1|true|yes|on)$/i.test(String(process.env.OFFER_RESOLVE_STRICT || ""));

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── LEGO SCANNER FOUNDING PASS (one-time, 12 months) ──
// Price ID is the source of truth; metadata.plan_code is the primary signal
// from our own Checkout. New paid Scanner access flows to user_entitlements,
// NOT to the legacy customers table.
const FOUNDING_PRICE_ID = process.env.STRIPE_SCANNER_FOUNDING_PRICE_ID || "";
const FOUNDING_PLAN_CODE = "lego_scanner_founding";

// Optional env for exact Payment Link matching
// Put Stripe payment_link IDs here if you have them, e.g. plink_xxx
const SCANNER_PAYMENT_LINK_ID = process.env.STRIPE_SCANNER_PAYMENT_LINK_ID || "";
const METHOD_PAYMENT_LINK_ID = process.env.STRIPE_METHOD_PAYMENT_LINK_ID || "";

// Limits
const SCANNER_LIMIT = parseInt(process.env.SCANNER_PAID_SCAN_LIMIT || "100", 10);
const METHOD_LIMIT = parseInt(process.env.LEGO_METHOD_SCAN_LIMIT || "300", 10);

// Fallback amount detection
// Use this only as backup. Best detection is metadata or payment_link.
// For THB, Stripe amount_total may be in smallest unit depending on account/currency.
// So we compare both direct amount and x100 just in case.
const SCANNER_PRICE_THB = parseInt(process.env.SCANNER_PRICE_THB || "1990", 10);
const METHOD_PRICE_THB = parseInt(process.env.METHOD_PRICE_THB || "8990", 10);
const METHOD_CREDIT_PRICE_THB = parseInt(process.env.METHOD_CREDIT_PRICE_THB || "7000", 10);

// Helper to read raw body for Stripe signature
async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

function amountMatches(amountTotal, thb) {
  if (!amountTotal || !thb) return false;

  return (
    Number(amountTotal) === Number(thb) ||
    Number(amountTotal) === Number(thb) * 100
  );
}

function normalizePlanText(value) {
  return String(value || "").trim().toLowerCase();
}

function resolvePlanFromText(text) {
  const t = normalizePlanText(text);

  if (!t) return null;

  if (
    t.includes("method") ||
    t.includes("lego method") ||
    t.includes("lego_method")
  ) {
    return "lego_method";
  }

  if (
    t.includes("scanner") ||
    t.includes("lego scanner") ||
    t.includes("lego_scanner")
  ) {
    return "scanner_paid";
  }

  return null;
}

async function getCheckoutLineItems(sessionId) {
  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 10,
      expand: ["data.price.product"],
    });

    return lineItems.data || [];
  } catch (err) {
    console.warn("Could not retrieve line items:", err.message);
    return [];
  }
}

async function resolveCheckoutPlan(session) {
  /*
    Priority:
    1. session.metadata.plan / product / offer
    2. payment_link ID
    3. line item product name / description
    4. amount_total fallback
  */

  const metadata = session.metadata || {};

  const metadataCandidates = [
    metadata.plan,
    metadata.product,
    metadata.offer,
    metadata.type,
    metadata.package,
    session.client_reference_id,
  ];

  for (const item of metadataCandidates) {
    const plan = resolvePlanFromText(item);
    if (plan) return plan;
  }

  if (
    METHOD_PAYMENT_LINK_ID &&
    session.payment_link &&
    String(session.payment_link) === METHOD_PAYMENT_LINK_ID
  ) {
    return "lego_method";
  }

  if (
    SCANNER_PAYMENT_LINK_ID &&
    session.payment_link &&
    String(session.payment_link) === SCANNER_PAYMENT_LINK_ID
  ) {
    return "scanner_paid";
  }

  const lineItems = await getCheckoutLineItems(session.id);

  for (const item of lineItems) {
    const product = item.price?.product;
    const productName =
      typeof product === "object" && product
        ? product.name
        : "";

    const candidates = [
      item.description,
      productName,
      item.price?.nickname,
    ];

    for (const c of candidates) {
      const plan = resolvePlanFromText(c);
      if (plan) return plan;
    }
  }

  const amount = Number(session.amount_total || 0);

  if (
    amountMatches(amount, METHOD_PRICE_THB) ||
    amountMatches(amount, METHOD_CREDIT_PRICE_THB)
  ) {
    return "lego_method";
  }

  if (amountMatches(amount, SCANNER_PRICE_THB)) {
    return "scanner_paid";
  }

  return "scanner_paid";
}

function entitlementForPlan(plan) {
  if (plan === "lego_method") {
    return {
      plan: "lego_method",
      monthly_scan_limit: METHOD_LIMIT,
      legacy_unlimited: false,
      is_paid: true,
      has_method: true,
    };
  }

  return {
    plan: "scanner_paid",
    monthly_scan_limit: SCANNER_LIMIT,
    legacy_unlimited: false,
    is_paid: true,
    has_method: false,
  };
}

async function upsertCustomerEntitlement({
  email,
  eventId,
  plan,
  stripeCustomerId,
  stripeCheckoutSessionId,
  stripePaymentIntentId,
}) {
  const entitlement = entitlementForPlan(plan);

  const payload = {
    email,
    active: true,

    is_paid: entitlement.is_paid,
    has_method: entitlement.has_method,
    plan: entitlement.plan,
    monthly_scan_limit: entitlement.monthly_scan_limit,
    legacy_unlimited: entitlement.legacy_unlimited,
    plan_started_at: new Date().toISOString(),

    stripe_event_id: eventId,
    stripe_customer_id: stripeCustomerId || null,
    stripe_checkout_session_id: stripeCheckoutSessionId || null,
    stripe_payment_intent_id: stripePaymentIntentId || null,

    last_payment_at: new Date().toISOString(),
    deactivated_at: null,
  };

  const { error } = await supabase
    .from("customers")
    .upsert(payload, { onConflict: "email" });

  if (error) {
    throw error;
  }

  return payload;
}

async function syncUsageEntitlement(email, plan) {
  const entitlement = entitlementForPlan(plan);

  const now = new Date();
  const usageMonth = now.toISOString().slice(0, 7);

  const payload = {
    email,
    usage_month: usageMonth,
    free_scan_limit: entitlement.monthly_scan_limit,
    monthly_scan_limit: entitlement.monthly_scan_limit,
    is_paid: entitlement.is_paid,
    is_lego_method_student: entitlement.has_method,
    is_admin: false,
    plan: entitlement.plan,
  };

  const { error } = await supabase
    .from("scanner_user_usage")
    .upsert(
      {
        ...payload,
        scans_used: 0,
      },
      { onConflict: "email" }
    );

  if (error) {
    console.warn("Usage sync warning:", error);
  }
}

async function getEmailFromStripeCustomer(customerId) {
  if (!customerId) return null;

  try {
    const customer = await stripe.customers.retrieve(customerId);

    if (customer && !customer.deleted && customer.email) {
      return normalizeEmail(customer.email);
    }

    return null;
  } catch (err) {
    console.warn("Could not retrieve Stripe customer:", err.message);
    return null;
  }
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;

  // PromptPay / delayed payment methods: checkout.session.completed fires with
  // payment_status='unpaid' BEFORE the money moves. Never grant here — the
  // grant happens on checkout.session.async_payment_succeeded (same handler,
  // payment_status will be 'paid'). 'no_payment_required' (free/trial) passes.
  if (session.payment_status && session.payment_status === "unpaid") {
    console.log("Checkout completed but unpaid (async payment pending):", {
      eventId: event.id,
      sessionId: session.id,
    });
    return {
      ok: true,
      deferred: "awaiting_async_payment",
    };
  }

  const email = normalizeEmail(
    session.customer_email ||
      session.customer_details?.email ||
      (await getEmailFromStripeCustomer(session.customer))
  );

  if (!email) {
    console.warn("No email found in checkout.session.completed:", event.id);
    return {
      ok: true,
      warning: "no_email",
    };
  }

  // Founding Pass → new entitlement layer (does NOT write the legacy customers table).
  if (metadataSaysFounding(session) || (await sessionHasFoundingPrice(session))) {
    return await grantFoundingPass({
      obj: session,
      email,
      stripeCustomerId: session.customer || null,
      checkoutSessionId: session.id,
      paymentIntentId: session.payment_intent || null,
      priceId: FOUNDING_PRICE_ID || null,
    });
  }

  // Phase 2 strict path (flag-gated): price_id-authoritative grant, no defaulting.
  if (OFFER_RESOLVE_STRICT) {
    return await handleStrictGrant(event, { session, email });
  }

  const plan = await resolveCheckoutPlan(session);

  const payload = await upsertCustomerEntitlement({
    email,
    eventId: event.id,
    plan,
    stripeCustomerId: session.customer || null,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
  });

  await syncUsageEntitlement(email, plan);

  console.log("Customer entitlement updated:", {
    email,
    plan,
    limit: payload.monthly_scan_limit,
    eventId: event.id,
  });

  return {
    ok: true,
    email,
    plan,
  };
}

async function handlePaymentIntentSucceeded(event) {
  const intent = event.data.object;

  let email = normalizeEmail(intent.receipt_email);

  if (!email && intent.customer) {
    email = await getEmailFromStripeCustomer(intent.customer);
  }

  if (!email) {
    console.warn("No email found in payment_intent.succeeded:", event.id);
    return {
      ok: true,
      warning: "no_email",
    };
  }

  // Founding Pass → new entitlement layer (idempotent via unique payment_intent).
  if (metadataSaysFounding(intent)) {
    return await grantFoundingPass({
      obj: intent,
      email,
      stripeCustomerId: intent.customer || null,
      checkoutSessionId: null,
      paymentIntentId: intent.id,
      priceId: FOUNDING_PRICE_ID || null,
    });
  }

  // Phase 2 strict path (flag-gated): price_id/metadata-authoritative grant.
  if (OFFER_RESOLVE_STRICT) {
    return await handleStrictGrant(event, { intent, email });
  }

  const metadata = intent.metadata || {};
  let plan =
    resolvePlanFromText(metadata.plan) ||
    resolvePlanFromText(metadata.product) ||
    resolvePlanFromText(metadata.offer);

  if (!plan) {
    if (
      amountMatches(intent.amount_received, METHOD_PRICE_THB) ||
      amountMatches(intent.amount_received, METHOD_CREDIT_PRICE_THB)
    ) {
      plan = "lego_method";
    } else {
      plan = "scanner_paid";
    }
  }

  const payload = await upsertCustomerEntitlement({
    email,
    eventId: event.id,
    plan,
    stripeCustomerId: intent.customer || null,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: intent.id,
  });

  await syncUsageEntitlement(email, plan);

  console.log("Customer entitlement updated from payment intent:", {
    email,
    plan,
    limit: payload.monthly_scan_limit,
    eventId: event.id,
  });

  return {
    ok: true,
    email,
    plan,
  };
}

async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data.object;

  let email = normalizeEmail(invoice.customer_email);

  if (!email && invoice.customer) {
    email = await getEmailFromStripeCustomer(invoice.customer);
  }

  if (!email) {
    console.warn("No email found in invoice.payment_succeeded:", event.id);
    return {
      ok: true,
      warning: "no_email",
    };
  }

  const metadata = invoice.metadata || {};

  const plan =
    resolvePlanFromText(metadata.plan) ||
    resolvePlanFromText(metadata.product) ||
    "scanner_paid";

  const payload = await upsertCustomerEntitlement({
    email,
    eventId: event.id,
    plan,
    stripeCustomerId: invoice.customer || null,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: invoice.payment_intent || null,
  });

  await syncUsageEntitlement(email, plan);

  console.log("Customer entitlement updated from invoice:", {
    email,
    plan,
    limit: payload.monthly_scan_limit,
    eventId: event.id,
  });

  return {
    ok: true,
    email,
    plan,
  };
}

async function handleRefund(event) {
  const charge = event.data.object;
  const paymentIntentId = charge.payment_intent || null;

  // 1) If this refund maps to a Founding Pass, revoke ONLY that entitlement row.
  //    Never touch customers → LEGO METHOD / admin / legacy access is preserved.
  if (paymentIntentId) {
    const r = await refundScannerPassByPaymentIntent(paymentIntentId);
    if (r.matched) {
      console.log("Founding pass refunded (entitlement only):", paymentIntentId);
      return { ok: true, refunded: true, scope: "scanner_pass" };
    }
  }

  // 2) Otherwise this is a legacy one-time purchase (scanner_paid / method) that
  //    lives in customers — keep the existing behavior for those.
  const email = normalizeEmail(
    charge.billing_details?.email ||
      charge.receipt_email
  );

  if (!email) {
    console.warn("No email found in refund event:", event.id);
    return {
      ok: true,
      warning: "no_email",
    };
  }

  const { error } = await supabase
    .from("customers")
    .update({
      active: false,
      deactivated_at: new Date().toISOString(),
      stripe_event_id: event.id,
    })
    .eq("email", email);

  if (error) {
    throw error;
  }

  console.log("Customer deactivated from refund (legacy):", email);

  return {
    ok: true,
    email,
    refunded: true,
    scope: "legacy_customer",
  };
}

// ── LEGO SCANNER FOUNDING PASS (one-time) ───────────────────────

// Is this object (session or payment_intent) a Founding Pass purchase?
// Price ID is the source of truth; metadata.plan_code is the primary signal
// from our own Checkout. We never identify the pass by amount.
function metadataSaysFounding(obj) {
  const m = (obj && obj.metadata) || {};
  const code = String(m.plan_code || m.plan || "").toLowerCase();
  return code === FOUNDING_PLAN_CODE || code.includes("scanner_founding");
}

async function sessionHasFoundingPrice(session) {
  if (!FOUNDING_PRICE_ID) return false;
  const items = await getCheckoutLineItems(session.id);
  return items.some((it) => it.price && it.price.id === FOUNDING_PRICE_ID);
}

// Safe user matching: metadata.user_id → client_reference_id → email fallback.
function resolveGrantIdentity(obj, email) {
  const m = (obj && obj.metadata) || {};
  const userId = m.user_id || obj.client_reference_id || null;
  return { userId: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null, email };
}

async function grantFoundingPass({ obj, email, stripeCustomerId, checkoutSessionId, paymentIntentId, priceId }) {
  const plan = (await getPlan(FOUNDING_PLAN_CODE)) || {};
  const { userId } = resolveGrantIdentity(obj, email);

  const result = await grantScannerPass({
    email,
    userId,
    planCode: FOUNDING_PLAN_CODE,
    accessDurationDays: Number(plan.access_duration_days || 365),
    stripeCustomerId: stripeCustomerId || null,
    stripeCheckoutSessionId: checkoutSessionId || null,
    stripePaymentIntentId: paymentIntentId || null,
    stripePriceId: priceId || FOUNDING_PRICE_ID || null,
  });

  return { ok: true, pass: true, email, endsAt: result.endsAt, duplicate: result.duplicate };
}

// ── STRICT grant (Phase 2, PR-2.2, flag-gated by OFFER_RESOLVE_STRICT) ──
// Resolves the offer from price_id (authoritative) → metadata.plan_code, then
// grants via the NEW entitlement layer only. Ambiguous / unrecognized / non-
// granting (incl. Private Sprint) → NO grant + founder review. Never defaults
// to scanner_paid and never reads an amount to choose a grant (R11/R12).
async function handleStrictGrant(event, { session = null, intent = null, email }) {
  const obj = session || intent;
  const metadata = (obj && obj.metadata) || {};
  const metadataPlanCode = metadata.plan_code || metadata.plan || null;

  let priceId = null;
  if (session) {
    const items = await getCheckoutLineItems(session.id);
    priceId = (items[0] && items[0].price && items[0].price.id) || null;
  } else if (intent && intent.metadata) {
    priceId = intent.metadata.price_id || null; // our checkout may stamp it
  }

  const amountRaw = Number(session ? session.amount_total : (intent && (intent.amount_received || intent.amount)) || 0);
  // THB is zero-decimal, but some Stripe setups report x100 — normalize for the
  // advisory mismatch check only (it never selects a grant).
  const amountTotalThb = amountRaw > 100000 ? Math.round(amountRaw / 100) : amountRaw;

  const index = buildPriceIndex(await listOfferPlans());
  const r = resolveOffer({ priceId, metadataPlanCode, amountTotalThb }, index);

  // Ambiguous / non-granting → never auto-grant; flag for the founder.
  if (!r.plan_code || !r.grants) {
    await flagStripeEventForReview(event.id, `strict_no_grant confidence=${r.confidence} plan=${r.plan_code || "none"}`);
    console.warn("[stripe-webhook] STRICT no-grant → founder_intervention_required:", {
      eventId: event.id, email, priceId, metadataPlanCode, plan_code: r.plan_code, confidence: r.confidence,
    });
    return { ok: true, granted: false, founder_intervention_required: true, plan_code: r.plan_code || null };
  }

  if (r.mismatch) {
    await flagStripeEventForReview(event.id, `amount mismatch for ${r.plan_code} (granted by price_id)`);
    console.warn("[stripe-webhook] STRICT amount mismatch (granted by price_id):", { eventId: event.id, plan_code: r.plan_code });
  }

  const common = {
    email,
    userId: resolveGrantIdentity(obj, email).userId,
    planCode: r.plan_code,
    stripeCustomerId: (obj && obj.customer) || null,
    stripeCheckoutSessionId: session ? session.id : null,
    stripePaymentIntentId: session ? session.payment_intent || null : intent.id,
    stripePriceId: priceId,
  };

  if (r.entitlement_type === "scanner_access") {
    const result = await grantScannerPass({ ...common, accessDurationDays: Number(r.access_duration_days || 365) });
    return { ok: true, granted: true, offer: r.plan_code, scope: "scanner_access", duplicate: result.duplicate };
  }

  if (r.entitlement_type === "lego_method_access") {
    const upgraded = (await isScannerToMethodUpgradeEligible(email, common.userId)) ? "scanner" : null;
    const result = await grantMethodAccess({ ...common, accessDurationDays: r.access_duration_days, upgradedFrom: upgraded });
    return { ok: true, granted: true, offer: r.plan_code, scope: "lego_method_access", upgraded_from: upgraded, duplicate: result.duplicate };
  }

  await flagStripeEventForReview(event.id, `unknown entitlement_type for ${r.plan_code}`);
  return { ok: true, granted: false, founder_intervention_required: true };
}

// One-time payment failed — log a recoverable state, never grant.
async function handlePaymentIntentFailed(event) {
  const intent = event.data.object;
  let email = normalizeEmail(intent.receipt_email);
  if (!email && intent.customer) email = await getEmailFromStripeCustomer(intent.customer);
  console.warn("One-time payment failed:", { email: email || "unknown", eventId: event.id });
  return { ok: true, email, payment_failed: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(500).json({
      error: "Missing STRIPE_WEBHOOK_SECRET",
    });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);

    return res.status(400).json({
      error: `Webhook Error: ${err.message}`,
    });
  }

  // Idempotency: if we've already recorded this event id, skip re-processing.
  const seen = await recordStripeEvent(event.id, event.type);
  if (seen.alreadyProcessed) {
    return res.status(200).json({ received: true, type: event.type, duplicate: true });
  }

  try {
    let result = {
      ok: true,
      ignored: true,
      type: event.type,
    };

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      result = await handleCheckoutSessionCompleted(event);
    }

    else if (event.type === "checkout.session.async_payment_failed") {
      const s = event.data.object;
      console.warn("Async payment failed (no grant):", {
        eventId: event.id,
        sessionId: s.id,
        email: normalizeEmail(s.customer_email || s.customer_details?.email) || "unknown",
      });
      result = { ok: true, payment_failed: true };
    }

    else if (event.type === "payment_intent.succeeded") {
      result = await handlePaymentIntentSucceeded(event);
    }

    else if (event.type === "payment_intent.payment_failed") {
      result = await handlePaymentIntentFailed(event);
    }

    else if (event.type === "invoice.payment_succeeded") {
      result = await handleInvoicePaymentSucceeded(event);
    }

    else if (
      event.type === "charge.refunded" ||
      event.type === "charge.refund.updated"
    ) {
      result = await handleRefund(event);
    }

    return res.status(200).json({
      received: true,
      type: event.type,
      result,
    });
  } catch (err) {
    console.error("Webhook handler error:", err);

    return res.status(500).json({
      error: "Internal error",
      message: String(err),
    });
  }
}
