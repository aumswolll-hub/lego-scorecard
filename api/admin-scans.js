// ════════════════════════════════════════════════
// /api/admin-scans.js — Aggregate stats for /admin/scans dashboard.
// GET with x-session-token. Requires the session email to be in admin_users.
// Never exposes service role to the browser.
// ════════════════════════════════════════════════

import {
  sbRest,
  resolveSessionIdentity,
  getSessionToken,
  isAdmin,
  configMissing,
} from "./_auth-helpers.js";

function maskEmail(email) {
  if (!email || typeof email !== "string") return null;
  const [user, domain] = email.split("@");
  if (!user || !domain) return null;
  const head = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${head}***@${domain}`;
}

function countBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined || k === "") continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

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

  const admin = await isAdmin(identity.email);
  if (!admin) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    // Pull a recent window. Keep this simple for v1.
    // 5000 row cap is plenty until volume grows.
    const path =
      `product_scans?select=id,user_email,product_name,category,decision,score_total,score_max,score_pct,weaknesses,created_at` +
      `&order=created_at.desc&limit=5000`;

    const r = await sbRest(path);
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[admin-scans] query failed:", r.status, detail.slice(0, 500));
      return res.status(500).json({ error: "query_failed" });
    }
    const rows = await r.json();

    const totalScans = rows.length;

    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const scansToday = rows.filter(
      (x) => new Date(x.created_at) >= startOfTodayUtc
    ).length;

    const userSet = new Set();
    for (const x of rows) if (x.user_email) userSet.add(x.user_email);
    const activeUsers = userSet.size;

    const scoreVals = rows
      .map((x) => Number(x.score_total))
      .filter((v) => Number.isFinite(v));
    const avgScore = scoreVals.length
      ? scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length
      : null;

    const topCategories = countBy(rows, "category").slice(0, 10);
    const decisionDistribution = countBy(rows, "decision");

    // Most common weaknesses — flatten text[].
    const weaknessCounts = new Map();
    for (const x of rows) {
      const arr = Array.isArray(x.weaknesses) ? x.weaknesses : [];
      for (const w of arr) {
        const k = String(w || "").trim();
        if (!k) continue;
        weaknessCounts.set(k, (weaknessCounts.get(k) || 0) + 1);
      }
    }
    const mostCommonWeaknesses = [...weaknessCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const recentScans = rows.slice(0, 30).map((x) => ({
      product_name: x.product_name,
      category: x.category,
      decision: x.decision,
      score_total: x.score_total,
      score_max: x.score_max,
      score_pct: x.score_pct,
      created_at: x.created_at,
      user_masked: maskEmail(x.user_email),
    }));

    return res.status(200).json({
      ok: true,
      stats: {
        total_scans: totalScans,
        scans_today: scansToday,
        active_users: activeUsers,
        average_score: avgScore,
        window: "last_5000_scans",
      },
      top_categories: topCategories,
      decision_distribution: decisionDistribution,
      most_common_weaknesses: mostCommonWeaknesses,
      recent_scans: recentScans,
    });
  } catch (err) {
    console.error("[admin-scans] exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
