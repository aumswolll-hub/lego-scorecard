// ════════════════════════════════════════════════════════════════
// /api/admin-private-application.js — admin review + decision for Private Sprint
// applications (PR-2.5). Admin-gated (admin_users), like /api/admin-scorecard.
//
// GET                → list applications (?status= filter) + this month's
//                      approved count vs MONTHLY_CAPACITY (surfaced, not enforced).
// POST {application_id, decision, decision_note}
//                    → records the FOUNDER's human decision (under_review/approved/
//                      declined), stamping decided_by + decided_at.
//
// Software NEVER auto-approves: the only way to 'approved' is this endpoint, and
// only an authenticated admin can call it. Approval here does NOT grant access or
// take payment — fulfilment stays out-of-band with the founder (CLAUDE.md §10).
// ════════════════════════════════════════════════════════════════
import { sbRest, resolveSessionIdentity, getSessionToken, isAdmin, configMissing } from "./_auth-helpers.js";
import { isValidAdminDecision, APP_STATUSES, MONTHLY_CAPACITY } from "./_private-application.mjs";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (configMissing()) return res.status(500).json({ error: "config_error" });

  const token = getSessionToken(req);
  const identity = await resolveSessionIdentity(token);
  if (!identity) return res.status(401).json({ error: "unauthorized" });
  if (!(await isAdmin(identity.email))) return res.status(403).json({ error: "forbidden" });

  if (req.method === "GET") return listApplications(req, res);
  return recordDecision(req, res, identity.email);
}

async function listApplications(req, res) {
  const status = req.query && typeof req.query.status === "string" ? req.query.status : null;
  try {
    let path = "private_applications?select=*&order=created_at.desc&limit=200";
    if (status && APP_STATUSES.includes(status)) path += `&status=eq.${encodeURIComponent(status)}`;

    const r = await sbRest(path);
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[admin-private-application] list failed:", r.status, detail.slice(0, 300));
      return res.status(500).json({ error: "query_failed" });
    }
    const rows = await r.json();

    // Capacity: count rows APPROVED in the current calendar month (surfaced only).
    const month = new Date().toISOString().slice(0, 7);
    const approvedThisMonth = rows.filter(
      (x) => x.status === "approved" && typeof x.decided_at === "string" && x.decided_at.slice(0, 7) === month
    ).length;

    return res.status(200).json({
      ok: true,
      count: rows.length,
      capacity: { monthly: MONTHLY_CAPACITY, approved_this_month: approvedThisMonth, remaining: Math.max(0, MONTHLY_CAPACITY - approvedThisMonth) },
      rows,
    });
  } catch (err) {
    console.error("[admin-private-application] list exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}

async function recordDecision(req, res, adminEmail) {
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "bad_json" });
  }

  const applicationId = typeof body.application_id === "string" ? body.application_id : "";
  const decision = body.decision;
  if (!applicationId) return res.status(400).json({ error: "missing_application_id" });
  if (!isValidAdminDecision(decision)) return res.status(400).json({ error: "invalid_decision" });

  const patch = {
    status: decision,
    decided_by: adminEmail, // who recorded the founder's decision
    decided_at: new Date().toISOString(),
    decision_note: typeof body.decision_note === "string" ? body.decision_note.slice(0, 2000) : null,
  };

  try {
    const r = await sbRest(
      `private_applications?id=eq.${encodeURIComponent(applicationId)}`,
      { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[admin-private-application] patch failed:", r.status, detail.slice(0, 300));
      return res.status(500).json({ error: "update_failed" });
    }
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return res.status(404).json({ error: "not_found" });

    return res.status(200).json({ ok: true, application_id: applicationId, status: decision, decided_by: adminEmail });
  } catch (err) {
    console.error("[admin-private-application] decision exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
