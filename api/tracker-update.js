// ════════════════════════════════════════════════
// /api/tracker-update.js
// Upsert one row in user_product_tracker for the current user.
//
// POST JSON: {
//   product_key,          // required
//   latest_scan_id?,
//   user_status?,         // one of the allowed labels
//   notes?, angle_idea?, hook_idea?,
//   posted_count?, got_order?, order_count?, revenue_estimate?,
//   is_watchlisted?, is_archived?
// }
//
// Auth: x-session-token header (same pattern as scans-history).
// Scoping: user_email is ALWAYS taken from the resolved session —
// the client cannot specify it. Conflict target is
// (user_email, product_key), so a user can never overwrite another
// user's row.
// ════════════════════════════════════════════════

import {
  sbRest,
  resolveSessionIdentity,
  getSessionToken,
  configMissing,
} from "./_auth-helpers.js";

const ALLOWED_STATUS = new Set([
  "Not Tested", "Testing", "Posted", "Got Order",
  "No Order", "Scaling", "Dropped",
]);

function cleanString(v, max = 4000) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function cleanInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function cleanNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function isUuid(v) {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (configMissing()) {
    return res.status(500).json({ error: "config_error" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    return res.status(400).json({ error: "bad_json" });
  }
  req.body = body;

  const token = getSessionToken(req);
  const identity = await resolveSessionIdentity(token);
  if (!identity) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const product_key = cleanString(body.product_key, 400);
  if (!product_key) {
    return res.status(400).json({ error: "product_key_required" });
  }

  const user_status = body.user_status === undefined
    ? undefined
    : cleanString(body.user_status, 32);
  if (user_status !== undefined && user_status !== null &&
      !ALLOWED_STATUS.has(user_status)) {
    return res.status(400).json({ error: "invalid_user_status" });
  }

  const row = {
    user_email:  identity.email,
    user_id:     identity.userId || null,
    product_key,
    last_action_at: new Date().toISOString(),
  };

  if (body.latest_scan_id !== undefined) {
    row.latest_scan_id = isUuid(body.latest_scan_id) ? body.latest_scan_id : null;
  }
  if (user_status !== undefined) {
    row.user_status = user_status || "Not Tested";
  }
  if (body.notes !== undefined)        row.notes        = cleanString(body.notes, 4000) || "";
  if (body.angle_idea !== undefined)   row.angle_idea   = cleanString(body.angle_idea, 2000) || "";
  if (body.hook_idea !== undefined)    row.hook_idea    = cleanString(body.hook_idea, 2000) || "";
  if (body.posted_count !== undefined) row.posted_count = cleanInt(body.posted_count) ?? 0;
  if (body.order_count !== undefined)  row.order_count  = cleanInt(body.order_count) ?? 0;
  if (body.revenue_estimate !== undefined) row.revenue_estimate = cleanNumber(body.revenue_estimate) ?? 0;
  if (body.got_order !== undefined)      row.got_order      = !!body.got_order;
  if (body.is_watchlisted !== undefined) row.is_watchlisted = !!body.is_watchlisted;
  if (body.is_archived !== undefined)    row.is_archived    = !!body.is_archived;

  try {
    const path = `user_product_tracker?on_conflict=user_email,product_key`;
    const r = await sbRest(path, {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[tracker-update] upsert failed:", r.status, detail.slice(0, 500));
      return res.status(500).json({ error: "upsert_failed" });
    }

    const out = await r.json().catch(() => []);
    return res.status(200).json({ ok: true, row: Array.isArray(out) ? out[0] : out });
  } catch (err) {
    console.error("[tracker-update] exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
