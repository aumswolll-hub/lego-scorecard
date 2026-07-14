// /api/generate-angles.js — สะพาน Scanner → คอนเทนต์
// POST { product_name, mode, decision, metrics } → 3 มุมคอนเทนต์ + hook
//
// จุดขายจริงของฟีเจอร์นี้: prompt ไม่ใช่ generic — ฝัง "winning patterns"
// จากคลังคอนเทนต์ LEGO METHOD ที่มีตัวเลขวิวยืนยัน (83K/30K/24K/20K/18K)
// และมุมถูก tie กับตัวเลขจริงของสินค้าที่เพิ่งสแกน
//
// ผลลัพธ์ persist ลง user_product_tracker.angle_idea / hook_idea อัตโนมัติ
// (field มีอยู่แล้วใน schema — ใช้ให้เกิดประโยชน์สักที)

import { resolveSessionIdentity, getSessionToken, sbRest, configMissing } from "./_auth-helpers.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const ANGLE_PROMPT = (product, metrics, decision) => `คุณคือครีเอเตอร์ TikTok affiliate สายเลือกสินค้าด้วยข้อมูล (แนว LEGO METHOD ของ Ar.ngoon)

สินค้า: "${product}"
ผลสแกน: ${decision} (ตัวเลขจริงจาก TikTok Shop)
ตัวเลข: ${JSON.stringify(metrics)}

สร้าง "มุมคอนเทนต์" 3 มุมสำหรับทำคลิปขายสินค้านี้ โดยใช้ pattern ที่พิสูจน์แล้วว่าชนะ (เลือก pattern ที่เข้ากับสินค้า+ตัวเลขจริงเท่านั้น):

1. "A ≠ B reframe" — เช่น "ขายดี ≠ คุณจะขายได้" (pattern ชนะบ่อยสุด)
2. "ไม่ได้แปลว่า... disclaimer-flip" — จริงใจ+ขัดความเชื่อ เช่น "Top 1 ไม่ได้แปลว่าเข้าไปขายแล้วชนะ"
3. "Identity callout" — "99% ของนายหน้า...", "คนที่ขาย X อยู่ตอนนี้..."
4. "Numbered tactical breakdown" — "มุมที่ 1... มุมที่ 2..." (save rate สูง)
5. "Effort-reframe" — "ไม่ได้แพ้เพราะไม่ขยัน แต่แพ้เพราะ..."
6. "กรีนสกรีน scan format" — โชว์ตัวเลขสินค้าบนจอแล้วชี้จุดที่คนมองข้าม

กติกา:
- hook ต้องหยุดนิ้วใน 2 วินาทีแรก เป็นภาษาพูดไทยธรรมชาติ ไม่ใช่ภาษาโฆษณา
- ผูกกับตัวเลขจริงของสินค้านี้ (เช่น commission, ยอด 7 วันโต, CVR) อย่างน้อย 1 มุม
- ห้ามเคลมเกินจริง ห้ามการันตีรายได้
- แต่ละมุมต้องต่างกันจริง (คนละ pattern คนละอารมณ์)

ตอบเป็น JSON เท่านั้น:
{"angles":[{"name":"ชื่อมุมสั้นๆ","pattern":"pattern ที่ใช้","hook":"ประโยคเปิดคลิป","direction":"แนวคลิป 1-2 ประโยค: ถ่ายยังไง โชว์อะไร จบยังไง"}]}`;

function cleanJson(text) {
  return String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (configMissing() || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "config_error" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const token = getSessionToken(req);
    const identity = await resolveSessionIdentity(token);

    if (!identity) {
      return res.status(401).json({ error: "unauthorized", message: "Session หมดอายุ — login ใหม่" });
    }

    const product = String(body.product_name || "").trim().slice(0, 300);
    const decision = String(body.decision || "").trim().slice(0, 20);
    const metrics = body.metrics && typeof body.metrics === "object" ? body.metrics : {};

    if (!product) {
      return res.status(400).json({ error: "product_required", message: "ไม่มีชื่อสินค้า" });
    }

    // sanitize metrics → เอาเฉพาะตัวเลข/สตริงสั้น กันฉีด prompt
    const safeMetrics = {};
    for (const [k, v] of Object.entries(metrics)) {
      if (typeof v === "number" && isFinite(v)) safeMetrics[String(k).slice(0, 30)] = v;
      else if (typeof v === "string") safeMetrics[String(k).slice(0, 30)] = v.slice(0, 40);
      if (Object.keys(safeMetrics).length >= 15) break;
    }

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200,
        temperature: 0.7,
        messages: [{ role: "user", content: ANGLE_PROMPT(product, safeMetrics, decision) }],
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("[generate-angles] Claude error:", aiRes.status, t.slice(0, 300));
      return res.status(502).json({ error: "ai_error", message: "สร้างมุมไม่สำเร็จ ลองใหม่อีกครั้ง" });
    }

    const aiData = await aiRes.json();
    const textOut = (aiData.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    let angles;
    try {
      const parsed = JSON.parse(cleanJson(textOut));
      angles = (parsed.angles || []).slice(0, 3).map((a) => ({
        name: String(a.name || "").slice(0, 120),
        pattern: String(a.pattern || "").slice(0, 80),
        hook: String(a.hook || "").slice(0, 300),
        direction: String(a.direction || "").slice(0, 500),
      })).filter((a) => a.hook);
    } catch (e) {
      return res.status(502).json({ error: "parse_error", message: "AI ตอบไม่เป็นรูปแบบ ลองใหม่อีกครั้ง" });
    }

    if (!angles.length) {
      return res.status(502).json({ error: "empty", message: "ไม่ได้มุมที่ใช้ได้ ลองใหม่อีกครั้ง" });
    }

    // persist ลง user_product_tracker (best-effort — ไม่ block ผลลัพธ์)
    try {
      const product_key = product.toLowerCase();
      await sbRest(`user_product_tracker?on_conflict=user_email,product_key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_email: identity.email,
          product_key,
          angle_idea: angles.map((a, i) => `${i + 1}. ${a.name} [${a.pattern}] — ${a.direction}`).join("\n"),
          hook_idea: angles.map((a, i) => `${i + 1}. ${a.hook}`).join("\n"),
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.warn("[generate-angles] tracker persist failed (soft):", e?.message || e);
    }

    console.log("[generate-angles] ok:", { email: identity.email, product, n: angles.length });

    return res.status(200).json({ ok: true, product, angles });
  } catch (err) {
    console.error("[generate-angles] error:", err);
    return res.status(500).json({ error: "server_error", message: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" });
  }
}
