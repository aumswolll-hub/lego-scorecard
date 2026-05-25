// ════════════════════════════════════════════════
// /api/analyze-image.js — อ่านภาพ TikTok Promotion info → คืนตัวเลข
// ใช้ Claude vision อ่านตัวเลขจากภาพ
//
// วาง: api/analyze-image.js ใน repo
// ต้องมี env:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional env:
//   AUTOFILL_MONTHLY_LIMIT   default 30
// ════════════════════════════════════════════════

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MONTHLY_LIMIT = parseInt(process.env.AUTOFILL_MONTHLY_LIMIT || "30", 10);

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

async function getEmailFromSession(token) {
  if (!token) return null;

  const res = await sb(
    `sessions?session_token=eq.${encodeURIComponent(token)}&select=email,expires_at`
  );

  if (!res.ok) return null;

  const rows = await res.json();
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;

  return rows[0].email;
}

async function hasMethodAccess(email) {
  try {
    const res = await sb(
      `customers?email=eq.${encodeURIComponent(email)}&select=has_method`
    );

    if (!res.ok) return false;

    const rows = await res.json();
    return rows.length > 0 && rows[0].has_method === true;
  } catch (error) {
    console.error("[analyze-image] hasMethodAccess error:", error);
    return false;
  }
}

async function checkAndIncrementUsage(email) {
  const month = new Date().toISOString().slice(0, 7);

  const getRes = await sb(
    `autofill_usage?email=eq.${encodeURIComponent(email)}&month=eq.${month}&select=count`
  );

  let used = 0;

  if (getRes.ok) {
    const rows = await getRes.json();
    if (rows.length) used = rows[0].count || 0;
  }

  if (used >= MONTHLY_LIMIT) {
    return { allowed: false, used, limit: MONTHLY_LIMIT };
  }

  await sb(`autofill_usage?on_conflict=email,month`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      email,
      month,
      count: used + 1,
      updated_at: new Date().toISOString(),
    }),
  });

  return { allowed: true, used: used + 1, limit: MONTHLY_LIMIT };
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") {
    throw new Error("empty_ai_response");
  }

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonOnly = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(jsonOnly);
    }

    throw new Error("parse_error");
  }
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/[^\d.-]/g, "")
    .trim();

  if (!cleaned) return null;

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeParsedData(parsed) {
  const data = {
    productName: parsed.productName || "",
    commissionRate: normalizeNumber(parsed.commissionRate ?? parsed.commission),
    orders7d: normalizeNumber(parsed.orders7d ?? parsed.orders7),
    orders30d: normalizeNumber(parsed.orders30d ?? parsed.orders30),
    ctr: normalizeNumber(parsed.ctr),
    atc7d: normalizeNumber(parsed.atc7d ?? parsed.atc7),
    atc30d: normalizeNumber(parsed.atc30d ?? parsed.atc30),
    stock: normalizeNumber(parsed.stock),
    reviews: normalizeNumber(parsed.reviews),
    creators7d: normalizeNumber(parsed.creators7d ?? parsed.creators7),
    creators30d: normalizeNumber(parsed.creators30d ?? parsed.creators30),
    period: parsed.period || null,
  };

  const missingFields = Object.entries(data)
    .filter(([key, value]) => {
      if (key === "productName") return value === "";
      if (key === "period") return value === null;
      return value === null;
    })
    .map(([key]) => key);

  return {
    success: true,
    ok: true,
    data,
    missingFields,
    confidence: parsed.confidence || "low",
    uncertainFields: parsed.uncertain_fields || parsed.uncertainFields || [],
  };
}

const EXTRACTION_PROMPT = `
You are an OCR extraction engine for TikTok Shop Affiliate "Promotion info" screenshots.

Your only job:
Read visible numbers from the image and return ONE valid JSON object.

Critical behavior:
- Extract as many visible fields as possible.
- If a number is visible or partially visible, return your best estimate.
- Do NOT leave a field null just because confidence is not perfect.
- Use null ONLY when the field is not visible in the image.
- If unsure, still return the best estimate and add the field name to uncertain_fields.
- Return JSON only.
- No markdown.
- No explanation.
- Your answer must start with { and end with }.

Read these fields:
1. productName = product name if visible
2. commissionRate = number from "commission rate", e.g. "10%" -> 10
3. stock = number from "In stock"
4. orders7d = Orders if the screenshot says Last 7 days
5. orders30d = Orders if the screenshot says Last 30 days
6. ctr = CTR percentage number, e.g. "8.5%" -> 8.5
7. atc7d = Add-to-cart users if screenshot says Last 7 days
8. atc30d = Add-to-cart users if screenshot says Last 30 days
9. creators7d = Number of creators if screenshot says Last 7 days
10. creators30d = Number of creators if screenshot says Last 30 days
11. reviews = review count if visible
12. period = "7d" if Last 7 days, "30d" if Last 30 days, otherwise null

Important TikTok layout rules:
- In Product trends, read the BIG main number.
- Ignore small numbers next to ▲ or ▼ because those are trend changes.
- Example: "30 ▲1" means value = 30, not 1.
- Example: "82 ▼51" means value = 82, not 51.
- Example: "310 ▲91" means value = 310, not 91.
- Remove commas: "1,234" -> 1234.
- Convert K/M: "1.2K" -> 1200, "1.5M" -> 1500000.
- CTR and commission should be numbers only, no % sign.

If there are two uploaded images:
- One may be Last 7 days and one may be Last 30 days.
- Combine both into the same JSON object.
- Fill both 7d and 30d fields when visible.

Return exactly this JSON shape:

{
  "productName": "",
  "commissionRate": null,
  "orders7d": null,
  "orders30d": null,
  "ctr": null,
  "atc7d": null,
  "atc30d": null,
  "creators7d": null,
  "creators30d": null,
  "stock": null,
  "reviews": null,
  "period": null,
  "confidence": "medium",
  "uncertain_fields": []
}
`;
`;
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      ok: false,
      error: "method_not_allowed",
      message: "Method not allowed",
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      success: false,
      ok: false,
      error: "config_error",
      message: "ยังไม่ได้ตั้งค่า Supabase env",
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      success: false,
      ok: false,
      error: "config_error",
      message: "ยังไม่ได้ตั้ง ANTHROPIC_API_KEY",
    });
  }

  let textOut = "";

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const sessionToken = req.headers["x-session-token"] || body.sessionToken;
    const images = body.images || [];

    console.log("[analyze-image] uploaded image count:", images.length);

    const email = await getEmailFromSession(sessionToken);

    if (!email) {
      return res.status(401).json({
        success: false,
        ok: false,
        error: "unauthorized",
        message: "Session หมดอายุ — login ใหม่",
      });
    }

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        success: false,
        ok: false,
        error: "bad_request",
        message: "ไม่มีภาพ",
      });
    }

    if (images.length > 2) {
      return res.status(400).json({
        success: false,
        ok: false,
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
      const usage = await checkAndIncrementUsage(email);

      if (!usage.allowed) {
        return res.status(429).json({
          success: false,
          ok: false,
          error: "rate_limit",
          message: `ใช้ auto-fill ครบ ${usage.limit} ครั้งในเดือนนี้แล้ว`,
          used: usage.used,
          limit: usage.limit,
          upsell: true,
        });
      }

      usageInfo = {
        ...usage,
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

    console.log("[analyze-image] calling Claude, email:", email);

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
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

      console.error("[analyze-image] Claude API error:", aiRes.status, errTxt);

      return res.status(502).json({
        success: false,
        ok: false,
        error: "ai_error",
        message: `Claude API error ${aiRes.status}`,
        detail: errTxt.slice(0, 500),
        usage: usageInfo,
      });
    }

    const aiData = await aiRes.json();

    textOut = (aiData.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    console.log("[analyze-image] MODEL RAW OUTPUT:", textOut);

    const parsed = safeJsonParse(textOut);

    console.log("[analyze-image] PARSED RESULT:", parsed);

    const finalResponse = normalizeParsedData(parsed);

    console.log("[analyze-image] FINAL RESPONSE:", finalResponse);

    return res.status(200).json({
      ...finalResponse,
      usage: usageInfo,
    });
  } catch (error) {
    console.error("[analyze-image] server/parse error:", error);
    console.error("[analyze-image] raw output:", textOut);

    const isParseError =
      error.message === "parse_error" ||
      error.message === "empty_ai_response" ||
      error instanceof SyntaxError;

    return res.status(isParseError ? 200 : 500).json({
      success: false,
      ok: false,
      error: isParseError ? "parse_error" : "server_error",
      message: isParseError
        ? "อ่านภาพไม่สำเร็จ: parse_error"
        : String(error.message || error),
      raw: textOut || null,
    });
  }
}
