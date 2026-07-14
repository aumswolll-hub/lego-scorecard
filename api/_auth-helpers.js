// ════════════════════════════════════════════════
// Shared auth helpers for scan-history endpoints.
// Mirrors the hybrid pattern used in /api/tracker.js and
// /api/analyze-image.js: accept either a legacy magic-link
// session_token OR a Supabase Auth access_token, resolve to
// a lowercased email, then verify the email has customer access.
// ════════════════════════════════════════════════

import { hasActiveAccess } from "./_entitlements.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function sbRest(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function getEmailFromSupabaseAccessToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.email) return null;
    return { email: String(user.email).trim().toLowerCase(), userId: user.id || null };
  } catch (err) {
    console.error("[scans auth] supabase token verify error:", err);
    return null;
  }
}

async function getEmailFromMagicSession(token) {
  if (!token) return null;
  try {
    const res = await sbRest(
      `sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;
    if (new Date(rows[0].expires_at) < new Date()) return null;
    return { email: String(rows[0].email).trim().toLowerCase(), userId: null };
  } catch (err) {
    console.error("[scans auth] magic session error:", err);
    return null;
  }
}

// Access = legacy customers row OR active user_entitlements row.
// (Buyers granted via the new entitlement layer have NO customers row.)
async function customerHasAccess(email) {
  if (!email) return false;
  try {
    return await hasActiveAccess(email);
  } catch (err) {
    console.error("[scans auth] customer access error:", err);
    return false;
  }
}

// Returns { email, userId } or null.
export async function resolveSessionIdentity(token) {
  if (!token) return null;
  let id = await getEmailFromMagicSession(token);
  if (!id) id = await getEmailFromSupabaseAccessToken(token);
  if (!id || !id.email) return null;
  const allowed = await customerHasAccess(id.email);
  if (!allowed) return null;
  return id;
}

export function getSessionToken(req) {
  return (
    req.headers["x-session-token"] ||
    (req.body && req.body.sessionToken) ||
    (req.query && req.query.sessionToken) ||
    null
  );
}

export async function isAdmin(email) {
  if (!email) return false;
  try {
    const res = await sbRest(
      `admin_users?email=eq.${encodeURIComponent(email)}&select=email`
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return rows.length > 0;
  } catch (err) {
    console.error("[scans auth] admin check error:", err);
    return false;
  }
}

export function configMissing() {
  return !SUPABASE_URL || !SUPABASE_KEY;
}
