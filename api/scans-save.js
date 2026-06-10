// ════════════════════════════════════════════════
// /api/scans-save.js — Save a completed scan to product_scans.
// POST { record, screenshotPath? } with x-session-token header.
// Never blocks the UI: errors return non-2xx but client should swallow.
// Dedupes via unique (user_email, client_record_id).
// ════════════════════════════════════════════════

import {
  sbRest,
  resolveSessionIdentity,
  getSessionToken,
  configMissing,
} from "./_auth-helpers.js";

function pickNumber(...candidates) {
  for (const v of candidates) {
    if (v === null || v === undefined || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickInt(...candidates) {
  const n = pickNumber(...candidates);
  if (n === null) return null;
  return Math.round(n);
}

function pickString(...candidates) {
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickStringArray(value) {
  if (!Array.isArray(value)) return null;
  const arr = value
    .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
    .filter(Boolean);
  return arr.length ? arr : null;
}

// Map the browser tracker record (or any scanner result JSON) into
// product_scans columns. Flexible on field names per the spec.
function mapRecordToRow(record, identity, screenshotPath) {
  const r = record || {};

  const mode = r.mode === "discovery" ? "discovery" : "validation";

  const score_total = pickNumber(r.score_total, r.total_score, r.total, r.score);
  const score_max   = pickNumber(r.score_max, r.max);
  const score_pct   = pickNumber(r.score_pct, r.pct);

  return {
    user_email: identity.email,
    user_id: identity.userId || null,
    client_record_id:
      r.id !== undefined && r.id !== null && Number.isFinite(Number(r.id))
        ? Math.trunc(Number(r.id))
        : null,

    mode,

    product_name: pickString(r.product_name, r.productName, r.product, r.name),
    product_id:   pickString(r.product_id, r.productId),
    shop_name:    pickString(r.shop_name, r.shopName, r.seller_name),
    category:     pickString(r.category, r.product_category),

    commission_rate: pickNumber(
      r.commission_rate, r.commissionRate, r.commission,
      r.v_commission
    ),
    orders_7d:  pickInt(r.orders_7d, r.orders7d, r.orders_7_days, r.orders7, r.v_orders7, r.gmv7),
    orders_30d: pickInt(r.orders_30d, r.orders30d, r.orders_30_days, r.orders30, r.v_orders30, r.gmv30),
    ctr:        pickNumber(r.ctr, r.click_through_rate, r.v_ctr),
    atc_7d:     pickInt(r.atc_7d, r.atc7d, r.add_to_cart_7d, r.atc7, r.v_atc7),
    atc_30d:    pickInt(r.atc_30d, r.atc30d, r.add_to_cart_30d, r.atc30, r.v_atc30),
    stock:      pickInt(r.stock, r.inventory, r.v_stock),
    reviews_count: pickInt(r.reviews_count, r.reviews, r.review_count),
    rating:     pickNumber(r.rating, r.review_rating),

    score_total,
    score_max,
    score_pct: score_pct ?? (score_total !== null && score_max ? score_total / score_max : null),

    decision: pickString(r.decision, r.verdict, r.recommendation),

    strengths:  pickStringArray(r.strengths || r.pros),
    weaknesses: pickStringArray(r.weaknesses || r.cons || r.risks),
    ai_summary: pickString(r.ai_summary, r.summary, r.analysis),

    raw_scan_result: r,
    screenshot_path: typeof screenshotPath === "string" && screenshotPath.trim()
      ? screenshotPath.trim()
      : null,
  };
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

  const record = body.record || body.scanResult || body;
  if (!record || typeof record !== "object") {
    return res.status(400).json({ error: "no_record" });
  }

  // Don't save empty / failed scans.
  const hasAnyData =
    record.decision ||
    record.product_name || record.productName || record.product ||
    record.score_total !== undefined || record.total !== undefined ||
    record.raw_scan_result;
  if (!hasAnyData) {
    return res.status(400).json({ error: "empty_record" });
  }

  const row = mapRecordToRow(record, identity, body.screenshotPath || body.screenshot_path);

  try {
    // Upsert on (user_email, client_record_id) so re-renders don't duplicate.
    const useUpsert = row.client_record_id !== null;
    const path = useUpsert
      ? `product_scans?on_conflict=user_email,client_record_id`
      : `product_scans`;

    const insertRes = await sbRest(path, {
      method: "POST",
      headers: {
        Prefer: useUpsert
          ? "resolution=merge-duplicates,return=representation"
          : "return=representation",
      },
      body: JSON.stringify(row),
    });

    if (!insertRes.ok) {
      const detail = await insertRes.text().catch(() => "");
      console.error("[scans-save] insert failed:", insertRes.status, detail.slice(0, 500));
      return res.status(500).json({ error: "insert_failed" });
    }

    const inserted = await insertRes.json().catch(() => []);
    return res.status(200).json({ ok: true, row: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (err) {
    console.error("[scans-save] exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
