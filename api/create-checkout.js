// /api/create-checkout.js — Create a Stripe Checkout Session for the
// LEGO SCANNER FOUNDING PASS (one-time, 12-month access).
//
// POST  (Authorization: Bearer <supabase access token>  OR  body.token)
// Returns { url } → frontend redirects the user to Stripe Checkout.
//
// One-time payment (mode=payment). The price lives in Stripe; set its id in env:
//   STRIPE_SCANNER_FOUNDING_PRICE_ID = price_xxx   (one-time, 5,900 THB)
// On success Stripe fires checkout.session.completed + payment_intent.succeeded,
// both handled by /api/stripe-webhook.js, which grants a 12-month entitlement.
//
// The session carries user_id + email in metadata (session AND payment_intent),
// so the webhook links the Stripe payment to the Supabase user without relying
// on email matching.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDING_PRICE_ID = process.env.STRIPE_SCANNER_FOUNDING_PRICE_ID || "";
const APP_URL = process.env.APP_URL || "https://legoscanner.app";
const FOUNDING_PLAN_CODE = "lego_scanner_founding";

function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : null;
}

// Verify a Supabase access token → { email, userId } (no customer-record
// requirement; free users are not in the customers table yet).
async function identityFromToken(token) {
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
    const email = normalizeEmail(user && user.email);
    if (!email) return null;
    return { email, userId: user.id || null };
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

  if (!FOUNDING_PRICE_ID) {
    return res.status(500).json({
      error: "config_error",
      message: "Missing STRIPE_SCANNER_FOUNDING_PRICE_ID (create the one-time price in Stripe and set the env var)",
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

  const identity = await identityFromToken(token);
  const email = (identity && identity.email) || normalizeEmail(body.email);
  const userId = (identity && identity.userId) || null;

  if (!email) {
    return res.status(401).json({
      error: "unauthorized",
      message: "ต้องเข้าสู่ระบบก่อนซื้อ Founding Pass",
    });
  }

  const meta = {
    plan_code: FOUNDING_PLAN_CODE,
    product: "lego_scanner_founding",
    user_id: userId || "",
    email,
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment", // one-time
      line_items: [{ price: FOUNDING_PRICE_ID, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId || email,
      allow_promotion_codes: true,
      metadata: meta,
      payment_intent_data: { metadata: meta }, // so payment_intent.succeeded carries the link
      success_url: `${APP_URL}/?pass=success`,
      cancel_url: `${APP_URL}/?pass=cancel`,
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
