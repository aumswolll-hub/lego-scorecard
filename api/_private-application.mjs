// ════════════════════════════════════════════════════════════════
// api/_private-application.mjs — pure helpers for the LEGO Private Sprint
// application (Phase 2, PR-2.5). Validation + the status-transition rules that
// guarantee software NEVER auto-approves (CLAUDE.md §2/§3/§10).
//
// Pure & unit-testable. .mjs so it runs under plain Node and api/*.js can import it.
// ════════════════════════════════════════════════════════════════

export const APP_STATUSES = ["submitted", "under_review", "approved", "declined"];

// The ONLY status a freshly-captured application may have. Approval/decline is a
// separate, admin-only, human action — never the capture path, never automatic.
export const INITIAL_STATUS = "submitted";

// Decisions an admin endpoint may record (the founder's out-of-band call).
export const ADMIN_DECISIONS = ["under_review", "approved", "declined"];

// Monthly capacity — SURFACED to the founder, never used to silently auto-decline.
export const MONTHLY_CAPACITY = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFERRED = ["line", "phone", "email"];

const str = (v, n = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/**
 * Validate + normalize a Private Sprint application body. Never throws.
 * @param {unknown} body
 * @returns {{ ok: boolean, errors: string[], value: object }}
 */
export function validateApplication(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const errors = [];

  const email = (str(b.email, 200) || "").toLowerCase() || null;
  if (!email || !EMAIL_RE.test(email)) errors.push("email");

  const tiktok_handle = str(b.tiktok_handle, 120);
  if (!tiktok_handle) errors.push("tiktok_handle");

  let preferred_contact = str(b.preferred_contact, 20);
  if (preferred_contact && !PREFERRED.includes(preferred_contact.toLowerCase())) {
    errors.push("preferred_contact");
    preferred_contact = null;
  } else if (preferred_contact) {
    preferred_contact = preferred_contact.toLowerCase();
  }

  let submission_id = str(b.submission_id, 60);
  if (submission_id && !UUID_RE.test(submission_id)) {
    errors.push("submission_id");
    submission_id = null;
  }

  const value = {
    email,
    tiktok_handle,
    preferred_contact,
    contact_value: str(b.contact_value, 200),
    notes: str(b.notes, 2000),
    submission_id,
    intake: b.intake && typeof b.intake === "object" && !Array.isArray(b.intake) ? b.intake : {},
    // status is NOT taken from the client — always forced to INITIAL_STATUS.
    status: INITIAL_STATUS,
  };

  return { ok: errors.length === 0, errors, value };
}

/**
 * Is `next` a status an admin may record? (Capture path never goes through here.)
 * @param {string} next
 * @returns {boolean}
 */
export function isValidAdminDecision(next) {
  return typeof next === "string" && ADMIN_DECISIONS.includes(next);
}
