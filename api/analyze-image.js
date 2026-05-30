// ════════════════════════════════════════════════
// /api/analyze-image.js — อ่านภาพ TikTok Promotion info → คืนตัวเลข
// รองรับทั้ง Magic Session เดิม + Supabase Password Login ใหม่
// Conservative mode: ไม่มั่นใจ = null ไม่เดา
// ════════════════════════════════════════════════

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MONTHLY_LIMIT = parseInt(process.env.AUTOFILL_MONTHLY_LIMIT || "100", 10);
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const DEBUG_SCANNER = process.env.DEBUG_SCANNER === "true";

async function sb(path, options = {}) {
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

/*
  Verify Supabase Auth access token.
  ใช้ตอน user login แบบ email/password ใหม่
*/
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
      console.warn("[auth] Supabase token invalid:", res.status, detail.slice(0, 300));
      return null;
    }

    const user = await res.json();

    if (!user || !user.email) return null;

    return String(user.email).trim().toLowerCase();
  } catch (err) {
    console.error("[auth] Supabase token verify error:", err);
    return null;
  }
}

/*
  Verify magic session token เดิม
  ใช้ตอน user login แบบ magic link เดิม
*/
async function getEmailFromMagicSession(token) {
  if (!token) return null;

  const res = await sb(
    `sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`
  );

  if (!res.ok) return null;

  const rows = await res.json();

  if (!rows.length) return null;

  if (new Date(rows[0].expires_at) < new Date()) return null;

  return String(rows[0].email).trim().toLowerCase();
}

/*
  เช็กว่า email นี้อยู่ใน customers และ active จริงไหม
*/
async function customerHasAccess(email) {
  if (!email) return false;

  try {
    const res = await sb(
      `customers?email=eq.${encodeURIComponent(email)}&active=eq.true&deactivated_at=is.null&select=email,active,deactivated_at`
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[auth] customer access query failed:", detail);
      return false;
    }

    const rows = await res.json();

    return rows.length > 0;
  } catch (err) {
    console.error("[auth] customer access error:", err);
    return false;
  }
}

/*
  Main auth resolver:
  1. ลอง magic session เดิมก่อน
  2. ถ้าไม่เจอ ลอง Supabase access_token ใหม่
  3. ต้องผ่าน customers.active ด้วย
*/
async function getEmailFromSession(token) {
  if (!token) return null;

  let email = await getEmailFromMagicSession(token);

  if (!email) {
    email = await getEmailFromSupabaseAccessToken(token);
  }

  if (!email) return null;

  const allowed = await customerHasAccess(email);

  if (!allowed) {
    console.warn("[auth] email found but no customer access:", email);
    return null;
  }

  return email;
}

async function hasMethodAccess(email) {
  try {
    const res = await sb(
      `customers?email=eq.${encodeURIComponent(email)}&select=has_method`
    );

    if (!res.ok) return false;

    const rows = await res.json();

    return rows.length > 0 && rows[0].has_method === true;
  } catch {
    return false;
  }
}

async function getUsage(email) {
  const month = new Date().toISOString().slice(0, 7);

  const res = await sb(
    `autofill_usage?email=eq.${encodeURIComponent(email)}&month=eq.${month}&select=count`
  );

  let used = 0;

  if (res.ok) {
    const rows = await res.json();
    if (rows.length) used = Number(rows[0].count || 0);
  }

  return {
    email,
    month,
    used,
    limit: MONTHLY_LIMIT,
    allowed: used < MONTHLY_LIMIT,
  };
}

async function incrementUsage(email) {
  const month = new Date().toISOString().slice(0, 7);
  const current = await getUsage(email);

  if (!current.allowed) {
    return {
      allowed: false,
      used: current.used,
      limit: current.limit,
    };
  }

  const newCount = current.used + 1;

  const res = await sb(`autofill_usage?on_conflict=email,month`, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      email,
      month,
      count: newCount,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`usage_increment_failed: ${detail}`);
  }

  return {
    allowed: true,
    used: newCount,
    limit: MONTHLY_LIMIT,
  };
}

function cleanJsonText(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function parseMaybeNumber(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let s = String(value).trim();

  if (!s || s === "—" || s === "-" || s.toLowerCase() === "null") return null;

  s = s.replace(/฿/g, "").replace(/%/g, "").replace(/\+/g, "").trim();

  const multiplier = /k$/i.test(s) ? 1000 : /m$/i.test(s) ? 1000000 : 1;

  s = s.replace(/[kKmM]$/g, "");
  s = s.replace(/,/g, "");

  const match = s.match(/-?\d+(\.\d+)?/);

  if (!match) return null;

  const n = Number(match[0]) * multiplier;

  return Number.isFinite(n) ? n : null;
}

function normalizeConfidence(value) {
  const v = String(value || "").toLowerCase();

  if (v === "high" || v === "medium" || v === "low") return v;

  return "low";
}

function normalizeParsed(parsed) {
  const uncertain = Array.isArray(parsed.uncertain_fields)
    ? parsed.uncertain_fields.map((x) => String(x))
    : [];

  const fieldConfidence = parsed.field_confidence || {};

  const fields = [
    "commission",
    "orders7",
    "orders30",
    "ctr",
    "atc7",
    "atc30",
    "creators7",
    "creators30",
    "stock",
  ];

  const out = {
    commission: null,
    orders7: null,
    orders30: null,
    ctr: null,
    atc7: null,
    atc30: null,
    creators7: null,
    creators30: null,
    stock: null,
    period: parsed.period === "7d" || parsed.period === "30d" ? parsed.period : null,
    productName:
      typeof parsed.productName === "string" && parsed.productName.trim()
        ? parsed.productName.trim()
        : null,
    confidence: normalizeConfidence(parsed.confidence),
    field_confidence: {},
    uncertain_fields: uncertain,
    needs_manual_review: parsed.needs_manual_review === true || uncertain.length > 0,
  };

  for (const field of fields) {
    const confidence = normalizeConfidence(fieldConfidence[field]);
    out.field_confidence[field] = confidence;

    const isUncertain = uncertain.includes(field);
    const numericValue = parseMaybeNumber(parsed[field]);

    if (confidence === "low" || isUncertain) {
      out[field] = null;

      if (!out.uncertain_fields.includes(field)) {
        out.uncertain_fields.push(field);
      }

      out.needs_manual_review = true;
    } else {
      out[field] = numericValue;

      if (numericValue === null) {
        if (!out.uncertain_fields.includes(field)) {
          out.uncertain_fields.push(field);
        }

        out.needs_manual_review = true;
      }
    }
  }

  if (out.period === "7d") {
    out.orders30 = null;
    out.atc30 = null;
    out.creators30 = null;
  }

  if (out.period === "30d") {
    out.orders7 = null;
    out.atc7 = null;
    out.creators7 = null;
  }

  return out;
}

const EXTRACTION_PROMPT = `คุณคือระบบอ่านตัวเลขจากภาพหน้าจอ TikTok Shop "Promotion info" ของ affiliate

ภารกิจของคุณ:
อ่าน "ตัวเลขที่มั่นใจจริงเท่านั้น" จากภาพ
ห้ามวิเคราะห์สินค้า
ห้ามให้คำแนะนำ
ห้ามคำนวณคะแนน
ห้ามเดาตัวเลขเพื่อให้ข้อมูลครบ

หลักสำคัญที่สุด:
ความแม่นสำคัญกว่าความครบ
อ่านได้น้อยแต่ถูก ดีกว่าอ่านครบแต่มั่ว

ถ้าไม่มั่นใจ ให้ใส่ null เท่านั้น

ขั้นตอนการอ่าน:
1. มองหาปุ่ม dropdown ว่าเป็น "Last 7 days" หรือ "Last 30 days" ก่อน
2. อ่านตัวเลขหลักของแต่ละ metric ทีละตัว
3. ตรวจว่าเป็นตัวเลขใหญ่หลัก ไม่ใช่ตัวเลข trend ลูกศร
4. ถ้า field ไหนไม่ชัด ให้ null และใส่ชื่อ field ใน uncertain_fields

โครงสร้างภาพ TikTok Promotion info:
- ด้านบนมักมี "Earn ฿XX.XX per sale"
- ใต้หรือใกล้กันมี "X% commission rate"
- มุมขวาบนมักมีตัวเลขใหญ่ + "In stock"
- ส่วน "Product trends" มี 4 ช่อง:
  1. Orders
  2. CTR
  3. Number of creators
  4. Add-to-cart users
- แต่ละช่องมักมี:
  - ตัวเลขใหญ่ = ค่าหลักที่ต้องอ่าน
  - ตัวเลขเล็กพร้อมลูกศร ▲/▼ = trend เท่านั้น ห้ามเอามาเป็นค่าหลัก

กฎการอ่านตัวเลข:
- "30 ▲1" → เอา 30 เท่านั้น ห้ามเอา 1
- "82 ▼51" → เอา 82 เท่านั้น ห้ามเอา 51
- "310 ▲91" → เอา 310 เท่านั้น ห้ามเอา 91
- CTR เช่น "8.5%" → เอา 8.5
- ตัวเลขเล็กข้าง CTR เช่น "▼2%" คือ trend ห้ามเอา
- "1,234" → 1234
- "1.2K" → 1200
- "358 In stock" → stock = 358
- "10% commission rate" → commission = 10

กฎห้ามเดา:
- ถ้าอ่านช่องไหนไม่ชัด/ไม่มั่นใจ ห้ามเดา ให้ใส่ null
- ถ้ามีโอกาสสับสนระหว่างตัวเลขหลักกับ trend ลูกศร ให้ใส่ null
- ถ้ามีโอกาสสับสนระหว่าง Last 7 days กับ Last 30 days ให้ period = null และ field ช่วงเวลาที่ไม่มั่นใจ = null
- ถ้ามีโอกาสสับสนระหว่าง Orders / Add-to-cart users / Number of creators ให้ field นั้น = null
- ถ้าภาพ crop ไม่ครบ หรือเห็นตัวเลขแค่บางส่วน ให้ field นั้น = null
- ถ้า field_confidence เป็น "low" ค่าของ field นั้นต้องเป็น null
- ห้ามเติมตัวเลขเพื่อให้ JSON ดูครบ
- ห้ามใช้เลขราคา, ค่าคอมต่อ sale, หรือ stock ไปแทน orders/atc/ctr

field confidence:
- high = เห็นชัด อ่านมั่นใจ
- medium = เห็นพออ่านได้ แต่มุม/ความคมชัดอาจไม่สมบูรณ์
- low = ไม่ชัด/มีโอกาสอ่านผิด/มีโอกาสสับสน ต้องใส่ null

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
  "confidence": <"high"|"medium"|"low">,
  "field_confidence": {
    "commission": <"high"|"medium"|"low">,
    "orders7": <"high"|"medium"|"low">,
    "orders30": <"high"|"medium"|"low">,
    "ctr": <"high"|"medium"|"low">,
    "atc7": <"high"|"medium"|"low">,
    "atc30": <"high"|"medium"|"low">,
    "creators7": <"high"|"medium"|"low">,
    "creators30": <"high"|"medium"|"low">,
    "stock": <"high"|"medium"|"low">
  },
  "uncertain_fields": [<string>],
  "needs_manual_review": <true|false>
}

กฎ period:
- ถ้าภาพแสดง "Last 7 days" → ใส่เฉพาะ orders7 / atc7 / creators7 และ period="7d"
- ถ้าภาพแสดง "Last 30 days" → ใส่เฉพาะ orders30 / atc30 / creators30 และ period="30d"
- commission + stock ใส่ได้เสมอถ้าเห็นชัด
- ถ้าไม่เห็น dropdown ชัด → period=null และค่าที่ขึ้นกับช่วงเวลาให้ null
- ถ้ามี uncertain_fields มากกว่า 0 → needs_manual_review=true
- ถ้าภาพไม่ชัด/crop ไม่ครบ → needs_manual_review=true`;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "config_error",
      message: "ยังไม่ได้ตั้ง ANTHROPIC_API_KEY",
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: "config_error",
      message: "ยังไม่ได้ตั้ง SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const sessionToken = req.headers["x-session-token"] || body.sessionToken;
    const images = body.images || [];

    const email = await getEmailFromSession(sessionToken);

    if (!email) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Session หมดอายุ — logout แล้ว login ใหม่",
      });
    }

    if (!images.length) {
      return res.status(400).json({
        error: "bad_request",
        message: "ไม่มีภาพ",
      });
    }

    if (images.length > 2) {
      return res.status(400).json({
        error: "too_many",
        message: "อัปโหลดได้สูงสุด 2 ภาพ (7d + 30d)",
      });
    }

    const unlimited = await hasMethodAccess(email);

    let usageInfo = {
      used: 0,
      limit: MONTHLY_LIMIT,
      unlimited,
    };

    if (!unlimited) {
      const usage = await getUsage(email);

      if (!usage.allowed) {
        return res.status(429).json({
          error: "rate_limit",
          message: `ใช้ auto-fill ครบ ${usage.limit} ครั้งในเดือนนี้แล้ว`,
          used: usage.used,
          limit: usage.limit,
          upsell: true,
        });
      }

      usageInfo = {
        used: usage.used,
        limit: usage.limit,
        unlimited: false,
      };
    }

    const content = [];

    images.forEach((img) => {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.media_type || "image/jpeg",
          data: img.data,
        },
      });
    });

    content.push({
      type: "text",
      text: EXTRACTION_PROMPT,
    });

    console.log("[analyze-image] calling Claude", {
      images: images.length,
      email,
      model: ANTHROPIC_MODEL,
    });

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        temperature: 0,
        messages: [
          {
            role: "user",
            content,
          },
        ],
      }),
    });

    console.log("[analyze-image] Claude status:", aiRes.status);

    if (!aiRes.ok) {
      const errTxt = await aiRes.text();

      console.error("[analyze-image] Claude error:", aiRes.status, errTxt);

      return res.status(502).json({
        error: "ai_error",
        message: `Claude API error ${aiRes.status}`,
        detail: errTxt.slice(0, 500),
      });
    }

    const aiData = await aiRes.json();

    const textOut = (aiData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    let parsed;
    let normalized;

    try {
      const clean = cleanJsonText(textOut);
      parsed = JSON.parse(clean);
      normalized = normalizeParsed(parsed);
    } catch (e) {
      return res.status(502).json({
        error: "parse_error",
        message: "AI ตอบกลับมาไม่ใช่ JSON ที่อ่านได้",
        raw: textOut,
      });
    }

    if (!unlimited) {
      const inc = await incrementUsage(email);

      usageInfo = {
        ...inc,
        unlimited: false,
      };
    }

    const response = {
      ok: true,
      data: normalized,
      usage: usageInfo,
    };

    if (DEBUG_SCANNER) {
      response.debug = {
        model: ANTHROPIC_MODEL,
        raw_ai_text: textOut,
        raw_parsed: parsed,
        normalized,
      };
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("[analyze-image] server error:", err);

    return res.status(500).json({
      error: "server_error",
      message: String(err),
    });
  }
}
