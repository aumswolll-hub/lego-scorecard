// ════════════════════════════════════════════════════════════════
// /api/private-application.js — LEGO Private Sprint application intake (PR-2.5).
//
// POST the application → validate → store with status FORCED to 'submitted'.
// This endpoint can NEVER approve: approval is a separate, admin-only, human
// action (api/admin-private-application.js). No Sprint access is granted here
// and none is ever granted on payment (CLAUDE.md §2/§3/§10).
//
// Identity is optional (a Path-D lead may apply before logging in). The client
// cannot set status, decided_by, or any decision field.
// ════════════════════════════════════════════════════════════════
import { sbRest, resolveSessionIdentity, getSessionToken, configMissing } from "./_auth-helpers.js";
import { validateApplication } from "./_private-application.mjs";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (configMissing()) return res.status(500).json({ error: "config_error" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "bad_json" });
  }

  const { ok, errors, value } = validateApplication(body);
  if (!ok) return res.status(400).json({ error: "invalid_input", fields: errors });

  // Optional identity attach — never block an anonymous applicant.
  let userId = null;
  let email = value.email;
  try {
    const token = getSessionToken(req);
    if (token) {
      const identity = await resolveSessionIdentity(token);
      if (identity) {
        userId = identity.userId || null;
        email = identity.email || email;
      }
    }
  } catch (e) {
    console.warn("[private-application] identity resolve failed:", e?.message);
  }

  const row = {
    submission_id: value.submission_id,
    user_id: userId,
    email,
    tiktok_handle: value.tiktok_handle,
    preferred_contact: value.preferred_contact,
    contact_value: value.contact_value,
    notes: value.notes,
    intake: value.intake,
    status: "submitted", // FORCED — capture path can never set any other status
  };

  try {
    const r = await sbRest("private_applications", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[private-application] insert failed:", r.status, detail.slice(0, 400));
      return res.status(500).json({ error: "application_failed" });
    }
    const rows = await r.json().catch(() => []);
    const app = Array.isArray(rows) ? rows[0] : rows;
    if (!app || !app.id) return res.status(500).json({ error: "application_missing_id" });

    return res.status(200).json({ application_id: app.id, status: "submitted" });
  } catch (err) {
    console.error("[private-application] exception:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
