// ════════════════════════════════════════════════
// /api/tracker.js — Tracker sync endpoint (Supabase)
// ใช้ session token ตรวจสอบ user → get/save/delete tracker items
//
// วาง: api/tracker.js ใน repo
// ต้องมี env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (มีอยู่แล้ว)
// ════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// เรียก Supabase REST API
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res;
}

// ตรวจสอบ session token → คืน email ถ้า valid
async function getEmailFromSession(sessionToken) {
  if (!sessionToken) return null;
  const res = await sb(
    `sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=email,expires_at`,
    { method: "GET" }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  const session = rows[0];
  // เช็ค expiry
  if (new Date(session.expires_at) < new Date()) return null;
  return session.email;
}

export default async function handler(req, res) {
  // CORS (ถ้า frontend อยู่คนละ domain — ปกติไม่ต้อง แต่กันไว้)
  res.setHeader("Content-Type", "application/json");

  try {
    // อ่าน session token จาก header หรือ body
    const sessionToken =
      req.headers["x-session-token"] ||
      (req.body && req.body.sessionToken) ||
      (req.query && req.query.sessionToken);

    const email = await getEmailFromSession(sessionToken);
    if (!email) {
      return res.status(401).json({ error: "unauthorized", message: "Session ไม่ถูกต้องหรือหมดอายุ" });
    }

    // ─────────── GET: ดึง tracker ทั้งหมดของ user ───────────
    if (req.method === "GET") {
      const r = await sb(
        `tracker_items?email=eq.${encodeURIComponent(email)}&select=id,data&order=id.desc`,
        { method: "GET" }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(500).json({ error: "db_error", detail: txt });
      }
      const rows = await r.json();
      // คืนเป็น array ของ data (record เต็ม)
      const items = rows.map((row) => row.data);
      return res.status(200).json({ items });
    }

    // ─────────── POST: บันทึก/อัปเดต tracker items (upsert) ───────────
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const items = body.items || [];

      if (!Array.isArray(items)) {
        return res.status(400).json({ error: "bad_request", message: "items ต้องเป็น array" });
      }

      if (items.length === 0) {
        return res.status(200).json({ ok: true, synced: 0 });
      }

      // แปลงเป็น rows สำหรับ upsert
      const rows = items.map((item) => ({
        id: item.id,
        email: email,
        data: item,
        updated_at: new Date().toISOString(),
      }));

      // Upsert (on conflict email+id → update)
      const r = await sb(`tracker_items?on_conflict=email,id`, {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });

      if (!r.ok) {
        const txt = await r.text();
        return res.status(500).json({ error: "db_error", detail: txt });
      }
      return res.status(200).json({ ok: true, synced: rows.length });
    }

    // ─────────── DELETE: ลบ record เดียว หรือทั้งหมด ───────────
    if (req.method === "DELETE") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const id = body && body.id;

      if (id === "all") {
        // ลบทั้งหมดของ user
        const r = await sb(
          `tracker_items?email=eq.${encodeURIComponent(email)}`,
          { method: "DELETE", headers: { "Prefer": "return=minimal" } }
        );
        if (!r.ok) {
          const txt = await r.text();
          return res.status(500).json({ error: "db_error", detail: txt });
        }
        return res.status(200).json({ ok: true, deleted: "all" });
      }

      if (!id) {
        return res.status(400).json({ error: "bad_request", message: "ต้องระบุ id" });
      }

      // ลบ record เดียว
      const r = await sb(
        `tracker_items?email=eq.${encodeURIComponent(email)}&id=eq.${id}`,
        { method: "DELETE", headers: { "Prefer": "return=minimal" } }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(500).json({ error: "db_error", detail: txt });
      }
      return res.status(200).json({ ok: true, deleted: id });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
}
