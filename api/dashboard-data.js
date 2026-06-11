// ════════════════════════════════════════════════
// /api/dashboard-data.js
// Returns the current user's dashboard payload:
//   { summary, action_groups, products, opportunity_leaks }
//
// Source of truth:
//   - product_scans       → scanner data (read-only here)
//   - user_product_tracker → per-product action layer (status/notes/etc.)
//
// Merges scans → tracker rows by product_key. Computes
// recommended_action per the priority ladder spec.
// ════════════════════════════════════════════════

import {
  sbRest,
  resolveSessionIdentity,
  getSessionToken,
  configMissing,
} from "./_auth-helpers.js";

// ── Decision buckets ────────────────────────────────────────────
const STRONG = new Set(["PICK", "VALIDATED", "SCALE"]);
const MIDDLE = new Set(["WAIT", "TEST", "RISKY"]);
const WEAK   = new Set(["DROP", "DEAD"]);

// ── product_key normalization ───────────────────────────────────
function normalizePart(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "");
}

export function buildProductKey(scan) {
  const pid = scan && scan.product_id ? String(scan.product_id).trim() : "";
  if (pid) return `id:${pid}`;
  const name = normalizePart(scan && scan.product_name);
  const shop = normalizePart(scan && scan.shop_name);
  if (!name && !shop) return null;
  return `nm:${name}|${shop}`;
}

// ── Recommended-action ladder ───────────────────────────────────
function daysSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

function isIncomplete(scan) {
  if (!scan) return true;
  return (
    scan.score_total === null || scan.score_total === undefined ||
    !scan.decision
  );
}

function computeRecommendedAction(scan, tracker) {
  const decision = scan && scan.decision ? String(scan.decision).toUpperCase() : "";
  const score    = Number(scan && scan.score_total);
  const status   = (tracker && tracker.user_status) || "Not Tested";

  const strong = STRONG.has(decision);
  const middle = MIDDLE.has(decision);
  const weak   = WEAK.has(decision);

  // 1. SCALE
  if (strong && (status === "Got Order" || status === "Scaling")) return "SCALE";

  // 2. TEST_NOW
  if (Number.isFinite(score) && score >= 14 && strong &&
      (!status || status === "Not Tested")) return "TEST_NOW";

  // 3. RESCAN_NEEDED
  if (daysSince(scan && scan.created_at) > 7) return "RESCAN_NEEDED";
  if (isIncomplete(scan)) return "RESCAN_NEEDED";
  if (decision === "WAIT" || decision === "RISKY") return "RESCAN_NEEDED";

  // 4. WATCHLIST
  if (Number.isFinite(score) && score >= 10 && score <= 13) return "WATCHLIST";
  if (middle) return "WATCHLIST";

  // 5. DROP
  if ((Number.isFinite(score) && score <= 9) || weak) return "DROP";

  return "WATCHLIST";
}

// ── Helpers ─────────────────────────────────────────────────────
function latestPerKey(scans) {
  // scans assumed ordered desc by created_at — keep first per key.
  const map = new Map();
  for (const s of scans) {
    const key = buildProductKey(s);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { ...s, product_key: key });
  }
  return map;
}

function bucketLabel(decision) {
  if (STRONG.has(decision)) return "strong";
  if (MIDDLE.has(decision)) return "middle";
  if (WEAK.has(decision))   return "weak";
  return "unknown";
}

// ── Handler ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (configMissing()) {
    return res.status(500).json({ error: "config_error" });
  }

  const token = getSessionToken(req);
  const identity = await resolveSessionIdentity(token);
  if (!identity) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const email = identity.email;
  const enc = encodeURIComponent(email);

  try {
    // Pull this user's scans + tracker action layer + LEGACY tracker_items in parallel.
    // tracker_items = original in-page Tracker tab (pre product_scans). We pull it
    // so historical records that were never re-saved through scans-save still appear
    // on the dashboard.
    const [scansRes, trackerRes, legacyRes] = await Promise.all([
      sbRest(
        `product_scans?user_email=eq.${enc}` +
        `&select=id,client_record_id,product_name,product_id,shop_name,category,` +
        `commission_rate,orders_7d,orders_30d,ctr,atc_7d,atc_30d,stock,` +
        `score_total,score_max,score_pct,decision,strengths,weaknesses,created_at` +
        `&order=created_at.desc&limit=1000`
      ),
      sbRest(
        `user_product_tracker?user_email=eq.${enc}` +
        `&select=product_key,latest_scan_id,user_status,recommended_action,` +
        `is_watchlisted,is_archived,notes,angle_idea,hook_idea,` +
        `posted_count,got_order,order_count,revenue_estimate,last_action_at,updated_at` +
        `&limit=2000`
      ),
      sbRest(
        `tracker_items?email=eq.${enc}&select=id,data&order=id.desc&limit=2000`
      ),
    ]);

    if (!scansRes.ok) {
      const t = await scansRes.text().catch(() => "");
      console.error("[dashboard-data] scans query failed:", scansRes.status, t.slice(0, 400));
      return res.status(500).json({ error: "query_failed" });
    }
    if (!trackerRes.ok) {
      const t = await trackerRes.text().catch(() => "");
      console.error("[dashboard-data] tracker query failed:", trackerRes.status, t.slice(0, 400));
      return res.status(500).json({ error: "query_failed" });
    }
    // legacyRes is best-effort — if the table doesn't exist on a fresh install,
    // we still want the dashboard to load.
    let legacyRows = [];
    if (legacyRes.ok) {
      legacyRows = await legacyRes.json().catch(() => []);
    } else {
      console.warn("[dashboard-data] tracker_items unavailable:", legacyRes.status);
    }

    const scans   = await scansRes.json();
    const tracker = await trackerRes.json();

    // ── Merge legacy tracker_items → pseudo-scans ──
    // Skip any legacy item whose id is already represented in product_scans
    // (client_record_id is the same Date.now() value the browser used).
    const knownClientIds = new Set();
    for (const s of scans) {
      if (s.client_record_id !== null && s.client_record_id !== undefined) {
        knownClientIds.add(String(s.client_record_id));
      }
    }
    for (const row of legacyRows) {
      const d = row && row.data;
      if (!d || typeof d !== "object") continue;
      if (d.id !== undefined && d.id !== null && knownClientIds.has(String(d.id))) continue;

      // Coerce the legacy JSON blob into the same shape as a product_scans row.
      const pseudo = {
        id: null,                                 // no uuid — pseudo scan
        client_record_id: d.id ?? null,
        product_name: d.product || d.product_name || null,
        product_id:   d.product_id || null,       // legacy has none
        shop_name:    d.shop_name || null,        // legacy has none
        category:     d.category  || null,        // legacy has none
        commission_rate: d.v_commission ?? d.commission ?? null,
        orders_7d:    d.v_orders7  ?? d.gmv7  ?? null,
        orders_30d:   d.v_orders30 ?? d.gmv30 ?? null,
        ctr:          d.v_ctr      ?? null,
        atc_7d:       d.v_atc7     ?? null,
        atc_30d:      d.v_atc30    ?? null,
        stock:        d.v_stock    ?? null,
        score_total:  d.total      ?? null,
        score_max:    d.max        ?? null,
        score_pct:    d.pct        ?? null,
        decision:     d.decision   ?? null,
        strengths:    null,
        weaknesses:   null,
        created_at:   d.timestamp || (typeof d.id === "number" ? new Date(d.id).toISOString() : null),
        _legacy:      true,
      };
      scans.push(pseudo);
    }
    // Re-sort merged list by created_at desc so latestPerKey picks the latest.
    scans.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });

    const trackerByKey = new Map();
    for (const t of tracker) trackerByKey.set(t.product_key, t);

    const latest = latestPerKey(scans);

    // Build product rows (one per latest scan per product_key).
    const products = [];
    for (const [key, scan] of latest) {
      const t = trackerByKey.get(key) || null;
      if (t && t.is_archived) continue;
      const recommended_action = computeRecommendedAction(scan, t);
      products.push({
        product_key: key,
        latest_scan_id: scan.id,
        product_name: scan.product_name,
        product_id: scan.product_id,
        shop_name: scan.shop_name,
        category: scan.category,
        commission_rate: scan.commission_rate,
        orders_7d: scan.orders_7d,
        orders_30d: scan.orders_30d,
        ctr: scan.ctr,
        atc_7d: scan.atc_7d,
        atc_30d: scan.atc_30d,
        stock: scan.stock,
        score_total: scan.score_total,
        score_max: scan.score_max,
        score_pct: scan.score_pct,
        decision: scan.decision,
        last_scanned_at: scan.created_at,
        recommended_action,
        // tracker (action-layer) fields
        user_status: (t && t.user_status) || "Not Tested",
        is_watchlisted: !!(t && t.is_watchlisted),
        notes: (t && t.notes) || "",
        angle_idea: (t && t.angle_idea) || "",
        hook_idea: (t && t.hook_idea) || "",
        posted_count: (t && t.posted_count) || 0,
        got_order: !!(t && t.got_order),
        order_count: (t && t.order_count) || 0,
        revenue_estimate: (t && t.revenue_estimate) || 0,
        last_action_at: t && t.last_action_at,
      });
    }

    // ── Summary counts ─────────────────────────────────────────
    let pick = 0, wait = 0, drop = 0, rescan = 0, gap = 0;
    for (const p of products) {
      const bucket = bucketLabel(String(p.decision || "").toUpperCase());
      if (bucket === "strong") pick++;
      else if (bucket === "middle") wait++;
      else if (bucket === "weak") drop++;
      if (p.recommended_action === "RESCAN_NEEDED") rescan++;
      // action_gap: scanner says strong PICK but user hasn't tested
      if (bucket === "strong" && (p.user_status === "Not Tested" || !p.user_status)) gap++;
    }

    const summary = {
      total_scans: scans.length,
      pick_count: pick,
      wait_count: wait,
      drop_count: drop,
      rescan_needed_count: rescan,
      action_gap_count: gap,
    };

    // ── Action groups ──────────────────────────────────────────
    const action_groups = {
      TEST_NOW:       products.filter(p => p.recommended_action === "TEST_NOW"),
      SCALE:          products.filter(p => p.recommended_action === "SCALE"),
      WATCHLIST:      products.filter(p => p.recommended_action === "WATCHLIST"),
      DROP:           products.filter(p => p.recommended_action === "DROP"),
      RESCAN_NEEDED:  products.filter(p => p.recommended_action === "RESCAN_NEEDED"),
    };

    // ── Opportunity leaks (Thai) ───────────────────────────────
    const leaks = [];

    if (gap > 0) {
      leaks.push(`คุณมี ${gap} สินค้าที่ระบบให้ PICK แต่ยังไม่ได้ Test`);
    }
    if (rescan > 0) {
      leaks.push(`คุณมี ${rescan} สินค้าที่ควรสแกนใหม่ก่อนทำคลิป`);
    }
    const postedNoResult = products.filter(
      p => p.user_status === "Posted" && !p.got_order && (p.order_count || 0) === 0
    ).length;
    if (postedNoResult > 0) {
      leaks.push(`คุณมี ${postedNoResult} สินค้าที่โพสต์แล้วแต่ยังไม่ได้อัปเดตผลลัพธ์`);
    }

    // Category insights
    const catStats = new Map(); // cat → { total, pick, drop }
    for (const p of products) {
      const c = (p.category || "ไม่ระบุหมวด").trim() || "ไม่ระบุหมวด";
      if (!catStats.has(c)) catStats.set(c, { total: 0, pick: 0, drop: 0 });
      const s = catStats.get(c);
      s.total++;
      const b = bucketLabel(String(p.decision || "").toUpperCase());
      if (b === "strong") s.pick++;
      if (b === "weak")   s.drop++;
    }
    let worstCat = null;
    let bestCat = null;
    for (const [c, s] of catStats) {
      if (s.total < 2) continue;
      if (!worstCat || s.drop > worstCat.drop) worstCat = { cat: c, ...s };
      const pickRate = s.pick / s.total;
      if (!bestCat || pickRate > bestCat.pickRate) bestCat = { cat: c, pickRate, ...s };
    }
    if (worstCat && worstCat.drop > 0) {
      leaks.push(`หมวดที่คุณ scan แล้ว DROP เยอะสุดคือ ${worstCat.cat}`);
    }
    if (bestCat && bestCat.pick > 0) {
      leaks.push(`หมวดที่มี PICK rate ดีสุดคือ ${bestCat.cat}`);
    }

    return res.status(200).json({
      ok: true,
      summary,
      action_groups,
      products,
      opportunity_leaks: leaks,
    });
  } catch (err) {
    console.error("[dashboard-data] exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
