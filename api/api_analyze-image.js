// ════════════════════════════════════════════════
// /api/analyze-image.js — อ่านภาพ TikTok Promotion info → คืนตัวเลข
// ใช้ Claude Haiku 4.5 vision
//
// วาง: api/analyze-image.js ใน repo
// ต้องมี env:
//   ANTHROPIC_API_KEY        (เอาจาก console.anthropic.com)
//   SUPABASE_URL             (มีอยู่แล้ว)
//   SUPABASE_SERVICE_ROLE_KEY (มีอยู่แล้ว)
//
// Optional env:
//   AUTOFILL_MONTHLY_LIMIT   (default 30) — จำนวนครั้ง/เดือน/คน
// ════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MONTHLY_LIMIT = parseInt(process.env.AUTOFILL_MONTHLY_LIMIT || "30", 10);

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

// ตรวจ session → email
async function getEmailFromSession(token) {
  if (!token) return null;
  const res = await sb(`sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;
  return rows[0].email;
}

// เช็คว่า user ซื้อ METHOD แล้วมั้ย (unlimited)
async function hasMethodAccess(email) {
  try {
    const res = await sb(`customers?email=eq.${encodeURIComponent(email)}&select=has_method`);
    if (!res.ok) return false;
    const rows = await res.json();
    return rows.length > 0 && rows[0].has_method === true;
  } catch { return false; }
}

// เช็ค + เพิ่ม usage count สำหรับเดือนนี้ → คืน { allowed, used, limit }
async function checkAndIncrementUsage(email) {
  const month = new Date().toISOString().slice(0, 7); // "2026-05"

  // ดึง count ปัจจุบัน
  const getRes = await sb(`autofill_usage?email=eq.${encodeURIComponent(email)}&month=eq.${month}&select=count`);
  let used = 0;
  if (getRes.ok) {
    const rows = await getRes.json();
    if (rows.length) used = rows[0].count;
  }

  if (used >= MONTHLY_LIMIT) {
    return { allowed: false, used, limit: MONTHLY_LIMIT };
  }

  // upsert count + 1
  await sb(`autofill_usage?on_conflict=email,month`, {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ email, month, count: used + 1, updated_at: new Date().toISOString() }),
  });

  return { allowed: true, used: used + 1, limit: MONTHLY_LIMIT };
}

// ─────────── Prompt สำหรับอ่านภาพ ───────────
const EXTRACTION_PROMPT = `คุณคือระบบอ่านข้อมูลจากภาพหน้าจอ TikTok Shop "Promotion info" ของ affiliate

อ่านค่าต่อไปนี้จากภาพ (ถ้าเห็น) แล้วคืนเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:

{
  "commission": <ตัวเลข % จาก "X% commission rate" หรือ null>,
  "orders7": <Orders ช่วง Last 7 days หรือ null>,
  "orders30": <Orders ช่วง Last 30 days หรือ null>,
  "ctr": <ตัวเลข % จาก CTR หรือ null>,
  "atc7": <Add-to-cart users 7 วัน หรือ null>,
  "atc30": <Add-to-cart users 30 วัน หรือ null>,
  "creators7": <Number of creators 7 วัน หรือ null>,
  "creators30": <Number of creators 30 วัน หรือ null>,
  "stock": <จำนวน In stock หรือ null>,
  "period": <"7d" ถ้าภาพแสดง Last 7 days, "30d" ถ้า Last 30 days, หรือ null>,
  "productName": <ชื่อสินค้า ถ้าเห็น หรือ null>
}

กฎสำคัญ:
- ภาพ TikTok แสดงข้อมูลได้ทีละช่วง (7 วัน หรือ 30 วัน) ดังนั้นภาพเดียวมักมีแค่ orders/atc/creators ของช่วงเดียว
- ถ้าภาพแสดง "Last 7 days" → ใส่ค่าใน orders7/atc7/creators7 และ orders30/atc30/creators30 = null
- ถ้าภาพแสดง "Last 30 days" → ใส่ค่าใน orders30/atc30/creators30 และ 7 วัน = null
- commission และ stock เหมือนกันทั้ง 2 ช่วง — ใส่ได้เสมอถ้าเห็น
- ตัวเลขให้เอาเฉพาะค่าหลัก ไม่เอาเครื่องหมาย +/- ที่เป็น trend indicator (เช่น "30 ▲1" → เอา 30)
- ถ้าอ่านไม่ออกหรือไม่เห็น → null
- คืน JSON อย่างเดียว ไม่มี markdown ไม่มี \`\`\``;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "config_error", message: "ยังไม่ได้ตั้ง ANTHROPIC_API_KEY" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const sessionToken = req.headers["x-session-token"] || body.sessionToken;
    const images = body.images || []; // array ของ { media_type, data(base64) }

    // 1. ตรวจ auth
    const email = await getEmailFromSession(sessionToken);
    if (!email) {
      return res.status(401).json({ error: "unauthorized", message: "Session หมดอายุ — login ใหม่" });
    }

    if (!images.length) {
      return res.status(400).json({ error: "bad_request", message: "ไม่มีภาพ" });
    }
    if (images.length > 2) {
      return res.status(400).json({ error: "too_many", message: "อัปโหลดได้สูงสุด 2 ภาพ (7d + 30d)" });
    }

    // 2. เช็ค rate limit (ยกเว้นคนซื้อ METHOD)
    const unlimited = await hasMethodAccess(email);
    let usageInfo = { used: 0, limit: MONTHLY_LIMIT, unlimited };
    if (!unlimited) {
      const usage = await checkAndIncrementUsage(email);
      if (!usage.allowed) {
        return res.status(429).json({
          error: "rate_limit",
          message: `ใช้ auto-fill ครบ ${usage.limit} ครั้งในเดือนนี้แล้ว`,
          used: usage.used,
          limit: usage.limit,
          upsell: true,
        });
      }
      usageInfo = { ...usage, unlimited: false };
    }

    // 3. สร้าง content สำหรับ Claude
    const content = [];
    images.forEach((img) => {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data },
      });
    });
    content.push({ type: "text", text: EXTRACTION_PROMPT });

    // 4. เรียก Claude Haiku
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1000,
        messages: [{ role: "user", content }],
      }),
    });

    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      return res.status(502).json({ error: "ai_error", detail: errTxt });
    }

    const aiData = await aiRes.json();
    const textOut = (aiData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // 5. parse JSON (strip markdown ถ้ามี)
    let parsed;
    try {
      const clean = textOut.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: "parse_error", raw: textOut });
    }

    return res.status(200).json({ ok: true, data: parsed, usage: usageInfo });
  } catch (err) {
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
}
