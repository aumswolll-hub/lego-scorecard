// ════════════════════════════════════════════════
// /api/usage.js — Freemium usage tracking + user state
//
// GET  → คืน state ปัจจุบัน { scans_used, limit, is_paid, is_student, state }
// POST → นับ scan +1 (เรียกเมื่อ scan สำเร็จเท่านั้น) คืน state ใหม่
//
// วาง: api/usage.js
// env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (มีอยู่แล้ว)
// ════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FREE_LIMIT = parseInt(process.env.FREE_SCAN_LIMIT || "3", 10);

async function sb(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function getEmailFromSession(token) {
  if (!token) return null;
  const res = await sb(`sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;
  return rows[0].email;
}

// ดึง usage row (สร้างใหม่ถ้ายังไม่มี)
async function getOrCreateUsage(email) {
  const res = await sb(`scanner_user_usage?email=eq.${encodeURIComponent(email)}&select=*`);
  if (res.ok) {
    const rows = await res.json();
    if (rows.length) return rows[0];
  }
  // สร้างใหม่
  const ins = await sb(`scanner_user_usage`, {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({ email, scans_used: 0, free_scan_limit: FREE_LIMIT, is_paid: false, plan: "free" }),
  });
  if (ins.ok) {
    const rows = await ins.json();
    if (rows.length) return rows[0];
  }
  return { email, scans_used: 0, free_scan_limit: FREE_LIMIT, is_paid: false, is_lego_method_student: false, plan: "free" };
}

// ตรวจ customers table ด้วย (เผื่อซื้อผ่าน Stripe webhook)
async function checkCustomerPaid(email) {
  try {
    const res = await sb(`customers?email=eq.${encodeURIComponent(email)}&select=is_paid,has_method,active`);
    if (!res.ok) return { paid: false, method: false };
    const rows = await res.json();
    if (!rows.length) return { paid: false, method: false };
    const c = rows[0];
    return { paid: c.is_paid === true || c.active === true, method: c.has_method === true };
  } catch { return { paid: false, method: false }; }
}

// คำนวณ user state
function computeState(usage, customerPaid) {
  const isStudent = usage.is_lego_method_student === true || customerPaid.method;
  const isPaid = usage.is_paid === true || customerPaid.paid || isStudent;
  const limit = usage.free_scan_limit || FREE_LIMIT;
  const used = usage.scans_used || 0;

  let state;
  if (isStudent) state = "lego_method_student";
  else if (isPaid) state = "paid_scanner";
  else if (used >= limit) state = "free_limit_reached";
  else state = "logged_in_free";

  return {
    email: usage.email,
    scans_used: used,
    free_scan_limit: limit,
    scans_left: Math.max(0, limit - used),
    is_paid: isPaid,
    is_lego_method_student: isStudent,
    plan: usage.plan || "free",
    state,
    can_scan: isPaid || used < limit,
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const sessionToken =
      req.headers["x-session-token"] ||
      (req.body && req.body.sessionToken) ||
      (req.query && req.query.sessionToken);

    const email = await getEmailFromSession(sessionToken);
    if (!email) {
      return res.status(401).json({ error: "unauthorized", message: "Session หมดอายุ" });
    }

    const usage = await getOrCreateUsage(email);
    const customerPaid = await checkCustomerPaid(email);

    // ─── GET: คืน state ปัจจุบัน ───
    if (req.method === "GET") {
      return res.status(200).json(computeState(usage, customerPaid));
    }

    // ─── POST: นับ scan +1 (เฉพาะ scan สำเร็จ) ───
    if (req.method === "POST") {
      const state = computeState(usage, customerPaid);

      // paid/student → ไม่ต้องนับ (unlimited)
      if (state.is_paid) {
        return res.status(200).json({ ...state, counted: false });
      }

      // ครบ limit → block
      if (state.scans_used >= state.free_scan_limit) {
        return res.status(403).json({ ...state, counted: false, blocked: true });
      }

      // นับ +1
      const newCount = (usage.scans_used || 0) + 1;
      await sb(`scanner_user_usage?email=eq.${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ scans_used: newCount, updated_at: new Date().toISOString() }),
      });

      const newState = computeState({ ...usage, scans_used: newCount }, customerPaid);
      return res.status(200).json({ ...newState, counted: true });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
}
