// ════════════════════════════════════════════════
// /api/tracker.js — Tracker sync endpoint (Supabase)
// รองรับทั้ง Magic Session เดิม + Supabase Password Login ใหม่
//
// ใช้ session token ตรวจสอบ user → get/save/delete tracker items
//
// ต้องมี env:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// ════════════════════════════════════════════════

import { hasActiveAccess } from "./_entitlements.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// เรียก Supabase REST API ด้วย service role
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  return res;
}

// ตรวจสอบ Supabase access_token จากระบบ login ใหม่
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

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn("[tracker auth] Supabase token invalid:", res.status, detail.slice(0, 300));
      return null;
    }

    const user = await res.json();

    if (!user || !user.email) return null;

    return String(user.email).trim().toLowerCase();
  } catch (err) {
    console.error("[tracker auth] Supabase token verify error:", err);
    return null;
  }
}

// ตรวจสอบ magic session token เดิม
async function getEmailFromMagicSession(sessionToken) {
  if (!sessionToken) return null;

  try {
    const res = await sb(
      `sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=email,expires_at`,
      { method: "GET" }
    );

    if (!res.ok) return null;

    const rows = await res.json();

    if (!rows.length) return null;

    const session = rows[0];

    if (new Date(session.expires_at) < new Date()) return null;

    return String(session.email).trim().toLowerCase();
  } catch (err) {
    console.error("[tracker auth] Magic session error:", err);
    return null;
  }
}

// เช็กสิทธิ์: customers เดิม หรือ user_entitlements ใหม่ (สอง layer เสมอ)
async function customerHasAccess(email) {
  if (!email) return false;

  try {
    return await hasActiveAccess(email);
  } catch (err) {
    console.error("[tracker auth] customer access error:", err);
    return false;
  }
}

// Main resolver:
// 1) ลอง magic token เดิม
// 2) ถ้าไม่ผ่าน ลอง Supabase access_token ใหม่
// 3) ต้องผ่าน customers.active ด้วย
async function getEmailFromSession(sessionToken) {
  if (!sessionToken) return null;

  let email = await getEmailFromMagicSession(sessionToken);

  if (!email) {
    email = await getEmailFromSupabaseAccessToken(sessionToken);
  }

  if (!email) return null;

  const allowed = await customerHasAccess(email);

  if (!allowed) {
    console.warn("[tracker auth] email found but no customer access:", email);
    return null;
  }

  return email;
}

function getSessionToken(req) {
  return (
    req.headers["x-session-token"] ||
    (req.body && req.body.sessionToken) ||
    (req.query && req.query.sessionToken) ||
    null
  );
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item) => item && item.id !== undefined && item.id !== null)
    .map((item) => ({
      ...item,
      id: item.id,
    }));
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: "config_error",
      message: "ยังไม่ได้ตั้ง SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    req.body = body;

    const sessionToken = getSessionToken(req);

    const email = await getEmailFromSession(sessionToken);

    if (!email) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Session ไม่ถูกต้องหรือหมดอายุ",
      });
    }

    // ─────────── GET: ดึง tracker ทั้งหมดของ user ───────────
    if (req.method === "GET") {
      const r = await sb(
        `tracker_items?email=eq.${encodeURIComponent(email)}&select=id,data&order=id.desc`,
        { method: "GET" }
      );

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return res.status(500).json({
          error: "db_error",
          detail: txt,
        });
      }

      const rows = await r.json();

      const items = rows
        .map((row) => row.data)
        .filter(Boolean)
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

      return res.status(200).json({
        ok: true,
        email,
        items,
      });
    }

    // ─────────── POST: บันทึก/อัปเดต tracker items ───────────
    if (req.method === "POST") {
      const items = normalizeItems(body.items || []);

      if (!Array.isArray(body.items)) {
        return res.status(400).json({
          error: "bad_request",
          message: "items ต้องเป็น array",
        });
      }

      if (items.length === 0) {
        return res.status(200).json({
          ok: true,
          email,
          synced: 0,
        });
      }

      const now = new Date().toISOString();

      const rows = items.map((item) => ({
        id: item.id,
        email,
        data: item,
        updated_at: now,
      }));

      const r = await sb(`tracker_items?on_conflict=email,id`, {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(rows),
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return res.status(500).json({
          error: "db_error",
          detail: txt,
        });
      }

      return res.status(200).json({
        ok: true,
        email,
        synced: rows.length,
      });
    }

    // ─────────── DELETE: ลบ record เดียว หรือทั้งหมด ───────────
    if (req.method === "DELETE") {
      const id = body && body.id;

      if (id === "all") {
        const r = await sb(
          `tracker_items?email=eq.${encodeURIComponent(email)}`,
          {
            method: "DELETE",
            headers: {
              Prefer: "return=minimal",
            },
          }
        );

        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          return res.status(500).json({
            error: "db_error",
            detail: txt,
          });
        }

        return res.status(200).json({
          ok: true,
          email,
          deleted: "all",
        });
      }

      if (id === undefined || id === null || id === "") {
        return res.status(400).json({
          error: "bad_request",
          message: "ต้องระบุ id",
        });
      }

      const r = await sb(
        `tracker_items?email=eq.${encodeURIComponent(email)}&id=eq.${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            Prefer: "return=minimal",
          },
        }
      );

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return res.status(500).json({
          error: "db_error",
          detail: txt,
        });
      }

      return res.status(200).json({
        ok: true,
        email,
        deleted: id,
      });
    }

    return res.status(405).json({
      error: "method_not_allowed",
    });
  } catch (err) {
    console.error("[tracker] server error:", err);

    return res.status(500).json({
      error: "server_error",
      message: String(err),
    });
  }
}
