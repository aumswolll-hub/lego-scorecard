// ════════════════════════════════════════════════
// /api/scans-history.js — Return the current user's own scan history.
// GET ?decision=&sort=&limit= with x-session-token header.
// Enforces user_email = current session email at the API layer.
// ════════════════════════════════════════════════

import {
  sbRest,
  resolveSessionIdentity,
  getSessionToken,
  configMissing,
} from "./_auth-helpers.js";

const ALLOWED_DECISIONS = new Set([
  "PICK", "TEST", "WAIT", "DROP", "SCALE",
  "VALIDATED", "RISKY", "DEAD",
]);

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

  const decisionRaw = String(req.query.decision || "").toUpperCase();
  const sort = String(req.query.sort || "latest");
  const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10) || 100, 1), 500);

  const orderBy = sort === "score"
    ? "score_total.desc.nullslast"
    : "created_at.desc";

  let path =
    `product_scans?user_email=eq.${encodeURIComponent(identity.email)}` +
    `&select=id,product_name,category,score_total,score_max,score_pct,decision,mode,strengths,weaknesses,created_at` +
    `&order=${orderBy}&limit=${limit}`;

  if (decisionRaw && decisionRaw !== "ALL" && ALLOWED_DECISIONS.has(decisionRaw)) {
    path += `&decision=eq.${encodeURIComponent(decisionRaw)}`;
  }

  try {
    const r = await sbRest(path);
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[scans-history] query failed:", r.status, detail.slice(0, 500));
      return res.status(500).json({ error: "query_failed" });
    }
    const rows = await r.json();
    return res.status(200).json({ ok: true, scans: rows });
  } catch (err) {
    console.error("[scans-history] exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
