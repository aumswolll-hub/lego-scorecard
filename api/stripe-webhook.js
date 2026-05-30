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

  console.log("Customer deactivated from refund:", email);

  return {
    ok: true,
    email,
    refunded: true,
  };
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

  try {
    let result = {
      ok: true,
      ignored: true,
      type: event.type,
    };

    if (event.type === "checkout.session.completed") {
      result = await handleCheckoutSessionCompleted(event);
    }

    else if (event.type === "payment_intent.succeeded") {
      result = await handlePaymentIntentSucceeded(event);
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
