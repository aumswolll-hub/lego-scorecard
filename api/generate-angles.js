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

// มุมขายพูดกับ "คนซื้อสินค้า" (end customer) — ไม่ใช่พูดกับนายหน้า
// วิเคราะห์จากชื่อ/ประเภทสินค้าเท่านั้น (ห้ามใช้ตัวเลขสถิติจากระบบ)
// taxonomy มุมขายตามคลัง Sales Angle Expansion ของ LEGO METHOD
const ANGLE_PROMPT = (product) => `คุณคือมือเขียนสคริปต์คลิป TikTok ขายของเก่งที่สุดในไทย — คลิปของคุณพูดกับ "คนที่จะซื้อสินค้าไปใช้" เท่านั้น

สินค้า: "${product}"

ขั้นตอนคิด (คิดในใจ ไม่ต้องแสดง):
1. เดาประเภทสินค้า + คนซื้อหลัก จากชื่อสินค้า (เพศ วัย ไลฟ์สไตล์ บริบทการใช้)
2. ลิสต์ pain point ของคนซื้อที่สินค้านี้แก้ได้ แล้วคัด 3 อันที่ "เจ็บสุด + พบบ่อยสุด"
3. จับคู่แต่ละ pain กับมุมขายที่เหมาะสุดจากคลังนี้ (เลือกให้ต่างกัน 3 มุม):
   • Pain — เจ็บปัญหาโดยตรง
   • Mistake — "คุณกำลังใช้/เลือก/ทำผิดอยู่"
   • Comparison — ก่อน-หลัง / ถูก-แพง / ตัวนี้ vs ตัวเก่า
   • Identity — "คนแบบฉันควรใช้สิ่งนี้"
   • Daily Situation — สถานการณ์ประจำวันที่ทำให้สินค้านี้จำเป็น
   • Objection — ตอบข้อสงสัยก่อนซื้อ (แพงไหม ใช้ยากไหม เห็นผลจริงไหม)
   • Proof — โชว์ผลลัพธ์ ทดลองใช้ ก่อน-หลัง reaction
   • Urgency — ถ้าไม่ซื้อตอนนี้จะพลาดอะไร
   • Gift/Occasion — ซื้อเป็นของขวัญ ให้แฟน พ่อแม่ ลูก
   • Competitor Reframe — ทำให้ต่างจากของที่คนเคยเห็นในตลาด

กติกา:
- hook = ประโยคแรกที่คนมี pain นั้นเลื่อนผ่านไม่ได้ ภาษาพูดจริงๆ ห้ามภาษาโฆษณา ห้ามขึ้นต้นว่า "ใครกำลัง..."ซ้ำกันทุกมุม
- script = โครงคลิป 20-40 วินาที เขียนเป็นบีท 3-5 บีท: เปิดด้วย pain → ขยี้/สาธิตให้เห็นภาพ → พลิกเข้าสินค้า → ปิดด้วย CTA สั้นๆ (เช่น "กดตะกร้าดูเลย")
- ห้ามอ้างตัวเลขสถิติ/ยอดขายจากระบบ ห้ามเคลมเกินจริง โดยเฉพาะสกินแคร์/อาหารเสริม (ห้ามอ้างรักษาโรค)
- 3 มุมต้องคนละ pain คนละมุม คนละอารมณ์ จริงๆ

ตอบเป็น JSON เท่านั้น:
{"angles":[{"name":"ชื่อมุมสั้นๆ","angle_type":"ประเภทมุมจากคลัง","pain":"pain point ที่มุมนี้ตี (1 ประโยค)","hook":"ประโยคเปิดคลิป","script":"บีท 1: ... / บีท 2: ... / บีท 3: ... (คร่าวๆ ถ่ายตามได้เลย)"}]}`;

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
        messages: [{ role: "user", content: ANGLE_PROMPT(product) }],
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
        angle_type: String(a.angle_type || "").slice(0, 60),
        pain: String(a.pain || "").slice(0, 300),
        hook: String(a.hook || "").slice(0, 300),
        script: String(a.script || "").slice(0, 800),
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
          angle_idea: angles.map((a, i) => `${i + 1}. ${a.name} [${a.angle_type}] pain: ${a.pain}\n   script: ${a.script}`).join("\n"),
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
