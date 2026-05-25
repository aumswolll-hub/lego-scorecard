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
const EXTRACTION_PROMPT = `คุณคือระบบอ่านตัวเลขจากภาพหน้าจอ TikTok Shop "Promotion info" ของ affiliate ความแม่นยำสำคัญมาก

ขั้นตอนการอ่าน (ทำตามนี้อย่างเคร่งครัด):
1. มองหาคำว่า "Last 7 days" หรือ "Last 30 days" ที่ปุ่ม dropdown ก่อน — เพื่อรู้ว่าภาพนี้เป็นช่วงไหน
2. อ่านตัวเลขหลักของแต่ละ metric ทีละตัว อย่างระมัดระวัง

โครงสร้างภาพ TikTok Promotion info:
- บนสุด: "Earn ฿XX.XX per sale" และใต้ลงมา "X% commission rate"
- มุมขวาบน: ตัวเลขใหญ่ + "In stock" (เช่น "358 In stock")
- ส่วน "Product trends" มี 4 ช่อง: Orders, CTR, Number of creators, Add-to-cart users
- แต่ละช่องมี: ตัวเลขใหญ่ (ค่าหลัก) + ตัวเลขเล็กพร้อมลูกศร ▲/▼ (คือ trend ไม่ใช่ค่าหลัก!)

กฎการอ่านตัวเลข (สำคัญที่สุด — ผิดบ่อย):
- เอาเฉพาะ "ตัวเลขใหญ่" ที่เป็นค่าหลัก เช่น "30 ▲1" → เอา 30 (ห้ามเอา 1)
- "82 ▼51" → เอา 82 (ห้ามเอา 51), "310 ▲91" → เอา 310
- CTR เป็น % เช่น "8.5%" → เอา 8.5 (ตัวเลขเล็ก ▼2% คือ trend ห้ามเอา)
- ตัวเลขที่มี comma เช่น "1,234" → เอา 1234 (ตัด comma)
- In stock: "358" → 358
- commission: "10% commission rate" → เอา 10

ตรวจสอบตัวเอง: ก่อนตอบ ให้เทียบว่าตัวเลขที่อ่านสมเหตุสมผลมั้ย (เช่น ATC ควร > Orders, Orders ควร > 0)

คืน JSON เท่านั้น ห้ามมีข้อความอื่น ห้ามมี markdown:
{
  "commission": <number|null>,
  "orders7": <number|null>,
  "orders30": <number|null>,
  "ctr": <number|null>,
  "atc7": <number|null>,
  "atc30": <number|null>,
  "creators7": <number|null>,
  "creators30": <number|null>,
  "stock": <number|null>,
  "period": <"7d"|"30d"|null>,
  "productName": <string|null>,
  "confidence": <"high"|"medium"|"low" — ความมั่นใจในการอ่านโดยรวม>,
  "uncertain_fields": [<ชื่อ field ที่อ่านไม่ชัด/ไม่มั่นใจ เช่น "ctr">]
}

กฎ period:
- ถ้าภาพแสดง "Last 7 days" → ใส่ค่าใน orders7/atc7/creators7, ส่วน *30 = null, period="7d"
- ถ้าภาพแสดง "Last 30 days" → ใส่ค่าใน orders30/atc30/creators30, ส่วน *7 = null, period="30d"
- commission + stock ใส่ได้เสมอถ้าเห็น (ไม่ขึ้นกับ period)
- ถ้าอ่านช่องไหนไม่ชัด/ไม่แน่ใจ → ใส่ค่าที่เดาได้ดีที่สุด แล้วใส่ชื่อช่องนั้นใน uncertain_fields
- ถ้าอ่านไม่ออกเลยจริงๆ → null`;

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
        model: "claude-sonnet-4-6", // Sonnet = อ่านภาพแม่นกว่า Haiku มาก
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
