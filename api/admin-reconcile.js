// /api/admin-reconcile.js — Admin: reconcile Stripe payments vs entitlements.
//
// GET  (x-session-token, admin only):
//   Cross-checks recent Founding-Pass payments in Stripe against
//   user_entitlements and flags any PAID payment with no entitlement
//   ("unmatched" → needs a manual grant). Also returns recent entitlements
//   and webhook events for visibility.
//
// POST (admin only) { email, payment_intent?, days? }:
//   Manually grant a 12-month pass (reconciliation action).
//
// Auth mirrors /api/admin-scans.js: resolveSessionIdentity + isAdmin.

import Stripe from "stripe";
import { resolveSessionIdentity, getSessionToken, isAdmin } from "./_auth-helpers.js";
import { grantScannerPass } from "./_entitlements.mjs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDING_PRICE_ID = process.env.STRIPE_SCANNER_FOUNDING_PRICE_ID || "";
const FOUNDING_PLAN_CODE = "lego_scanner_founding";

function sb(path, options = {}) {
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

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  // ── Admin auth ──
  const token = getSessionToken(req);
  const identity = await resolveSessionIdentity(token);
  if (!identity || !identity.email) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!(await isAdmin(identity.email))) {
    return res.status(403).json({ error: "forbidden", message: "admin only" });
  }

  // ── POST: manual grant (reconciliation) ──
  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const targetEmail = String(body.email || "").trim().toLowerCase();
    if (!targetEmail) return res.status(400).json({ error: "missing_email" });
    try {
      const granted = await grantScannerPass({
        email: targetEmail,
        planCode: FOUNDING_PLAN_CODE,
        accessDurationDays: Number(body.days || 365),
        stripePaymentIntentId: body.payment_intent || null,
        stripePriceId: FOUNDING_PRICE_ID || null,
      });
      return res.status(200).json({ ok: true, granted_for: targetEmail, granted });
    } catch (err) {
      return res.status(500).json({ error: "grant_failed", message: String(err && err.message ? err.message : err) });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  // ── GET: reconcile ──
  // 1) Recent Founding-Pass payments from Stripe (succeeded, our plan_code).
  let payments = [];
  let stripeError = null;
  try {
    const pis = await stripe.paymentIntents.list({ limit: 100 });
    payments = pis.data.filter(
      (pi) => pi.status === "succeeded" && (pi.metadata && pi.metadata.plan_code) === FOUNDING_PLAN_CODE
    );
  } catch (err) {
    stripeError = String(err && err.message ? err.message : err);
  }

  // 2) Our one-time entitlements, indexed by payment_intent.
  const entRes = await sb(
    `user_entitlements?source=eq.stripe_one_time&select=email,status,ends_at,stripe_payment_intent_id,created_at&order=created_at.desc&limit=300`
  );
  const ents = entRes.ok ? await entRes.json() : [];
  const entByPI = new Map(ents.filter((e) => e.stripe_payment_intent_id).map((e) => [e.stripe_payment_intent_id, e]));

  const matched = [];
  const unmatched = [];
  for (const pi of payments) {
    const row = {
      payment_intent: pi.id,
      email: (pi.metadata && pi.metadata.email) || pi.receipt_email || null,
      amount: pi.amount,
      currency: pi.currency,
      created: new Date(pi.created * 1000).toISOString(),
    };
    const ent = entByPI.get(pi.id);
    if (ent) matched.push({ ...row, entitlement_status: ent.status, ends_at: ent.ends_at });
    else unmatched.push(row); // paid in Stripe but no entitlement → needs manual grant
  }

  // 3) Recent webhook events (idempotency log) for visibility.
  const evRes = await sb(
    `stripe_events?select=stripe_event_id,event_type,status,processed_at&order=processed_at.desc&limit=20`
  );
  const events = evRes.ok ? await evRes.json() : [];

  return res.status(200).json({
    summary: {
      stripe_founding_payments: payments.length,
      entitlements_total: ents.length,
      matched: matched.length,
      unmatched: unmatched.length,
      stripe_error: stripeError,
    },
    unmatched, // ← action items
    matched,
    recent_entitlements: ents.slice(0, 20),
    recent_events: events,
  });
}
