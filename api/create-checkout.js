// /api/create-checkout.js — Create a Stripe Checkout Session for the
// LEGO SCANNER monthly subscription (recurring).
//
// POST  (Authorization: Bearer <supabase access token>  OR  body.token)
// Returns { url } → frontend redirects the user to Stripe Checkout.
//
// The recurring price itself lives in Stripe. Set its id in env:
//   STRIPE_SCANNER_SUB_PRICE_ID = price_xxx   (a recurring/monthly price)
// On success Stripe fires checkout.session.completed (mode=subscription) and,
// every month, invoice.payment_succeeded — both already handled by
// /api/stripe-webhook.js, which keeps the customer's entitlement active.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCANNER_SUB_PRICE_ID = process.env.STRIPE_SCANNER_SUB_PRICE_ID || "";
const APP_URL = process.env.APP_URL || "https://legoscanner.app";

function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : null;
}

// Verify a Supabase access token → email (no customer-record requirement,
// because free users are not in the customers table yet).
async function emailFromToken(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return normalizeEmail(user && user.email);
  } catch (err) {
    console.error("[create-checkout] token verify error:", err);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "config_error", message: "Missing STRIPE_SECRET_KEY" });
  }

  if (!SCANNER_SUB_PRICE_ID) {
    return res.status(500).json({
      error: "config_error",
      message: "Missing STRIPE_SCANNER_SUB_PRICE_ID (create a recurring price in Stripe and set the env var)",
    });
  }

  const body =
    typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

  const authHeader = req.headers["authorization"] || "";
  const token =
    authHeader.replace(/^Bearer\s+/i, "") ||
    body.token ||
    req.headers["x-session-token"] ||
    "";

  // Prefer the verified email from the token; fall back to a body email.
  const email = (await emailFromToken(token)) || normalizeEmail(body.email);

  if (!email) {
    return res.status(401).json({
      error: "unauthorized",
      message: "ต้องเข้าสู่ระบบก่อนสมัครสมาชิก",
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: SCANNER_SUB_PRICE_ID, quantity: 1 }],
      customer_email: email,
      client_reference_id: email,
      allow_promotion_codes: true,
      // Tag the session AND the resulting subscription so the webhook always
      // resolves the correct plan (renewal invoices inherit this metadata).
      metadata: { plan: "scanner_paid", product: "lego_scanner_subscription", email },
      subscription_data: {
        metadata: { plan: "scanner_paid", product: "lego_scanner_subscription", email },
      },
      success_url: `${APP_URL}/?sub=success`,
      cancel_url: `${APP_URL}/?sub=cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-checkout] stripe error:", err);
    return res.status(500).json({
      error: "checkout_failed",
      message: String(err && err.message ? err.message : err),
    });
  }
}
