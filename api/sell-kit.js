// ════════════════════════════════════════════════
// /api/sell-kit.js — SCAN → SELL ในระบบเดียว
// รับผลสแกน (ตัวเลข + คะแนน + decision) + รูปสินค้า (optional)
// → คืน 1) บทวิเคราะห์  2) มุมขาย 5 มุม  3) สคริปต์พากย์เสียง 3 ตัว
// ลูกค้าไม่ต้องเอาผลไปวางใน Gemini/ChatGPT อีกต่อไป
// ════════════════════════════════════════════════

import { resolveSessionIdentity, getSessionToken, sbRest, configMissing } from "./_auth-helpers.js";

export const config = {
  maxDuration: 300,
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.SELLKIT_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const DEBUG_SCANNER = process.env.DEBUG_SCANNER === "true";

function cleanJsonText(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function fmt(v, suffix = "") {
  if (v === null || v === undefined || v === "") return "ไม่มีข้อมูล";
  return `${v}${suffix}`;
}

// สรุปผลสแกนเป็นข้อความให้ AI อ่าน — ส่งเฉพาะที่มีจริง ไม่เดา
function buildScanBrief(p) {
  const lines = [];
  lines.push(`ชื่อสินค้า: ${p.name || "ไม่ระบุ"}`);
  lines.push(`โหมดสแกน: ${p.mode === "discovery" ? "Discovery (สำรวจตลาด)" : "Validation (ตัวเลขจริงจาก TikTok)"}`);
  lines.push(`ผลตัดสิน: ${p.decision} (คะแนนรวม ${p.total}/${p.max} = ${Math.round((p.pct || 0) * 100)}%)`);

  if (p.mode === "validation") {
    lines.push(`— ตัวเลขจาก TikTok Promotion Info —`);
    lines.push(`Commission: ${fmt(p.metrics.commission, "%")} (คะแนน ${fmt(p.scores.sComm)}/3)`);
    lines.push(`Orders 7 วัน: ${fmt(p.metrics.orders7)} | Orders 30 วัน: ${fmt(p.metrics.orders30)} (momentum score ${fmt(p.scores.sOrders)}/3)`);
    lines.push(`CTR: ${fmt(p.metrics.ctr, "%")} (คะแนน ${fmt(p.scores.sCTR)}/3) — CTR สูง = มุมคอนเทนต์ที่มีอยู่ในตลาดตอนนี้หยุดนิ้วคนได้`);
    lines.push(`Add-to-cart 7 วัน: ${fmt(p.metrics.atc7)} | 30 วัน: ${fmt(p.metrics.atc30)} (คะแนน ${fmt(p.scores.sATC)}/3)`);
    lines.push(`CVR (orders30/ATC30): ${fmt(p.metrics.cvr ? p.metrics.cvr.toFixed(1) : null, "%")} (คะแนน ${fmt(p.scores.sCVR)}/3) — CVR สูง = คนใส่ตะกร้าแล้วตัดสินใจซื้อง่าย`);
    lines.push(`Creators 7 วัน: ${fmt(p.metrics.creators7)} | 30 วัน: ${fmt(p.metrics.creators30)} | Orders/Creator: ${fmt(p.metrics.opc ? p.metrics.opc.toFixed(1) : null)} (คะแนน ${fmt(p.scores.sCreator)}/3) — orders/creator สูง + creators น้อย = ช่องว่างให้แทรก`);
    lines.push(`Stock: ${fmt(p.metrics.stock)} (คะแนน ${fmt(p.scores.sStock)}/3)`);
  } else {
    lines.push(`— ข้อมูลโหมดสำรวจ —`);
    lines.push(`Commission: ${fmt(p.metrics.commission, "%")}`);
    lines.push(`GMV 7 วัน: ${fmt(p.metrics.gmv7)} | GMV 30 วัน: ${fmt(p.metrics.gmv30)}`);
    lines.push(`จำนวน creators ในตลาด: ${fmt(p.metrics.creators)}`);
    if (Array.isArray(p.metrics.angles) && p.metrics.angles.length) {
      lines.push(`มุมขายที่ผู้ใช้คิดไว้เอง: ${p.metrics.angles.join(" / ")}`);
    }
  }

  if (p.weakest && p.weakest.length) {
    lines.push(`จุดอ่อนที่คะแนนต่ำสุด: ${p.weakest.join(", ")}`);
  }
  return lines.join("\n");
}

const SELL_KIT_PROMPT = `คุณคือ LEGO SELL KIT — เครื่องยนต์สร้างแผนขายของ LEGO METHOD™
คุณได้รับผลสแกนสินค้า TikTok affiliate ที่ผ่านการให้คะแนนด้วยสูตรจริง (ไม่ใช่ความรู้สึก) และอาจได้รับรูปสินค้าประกอบ

ภารกิจ: เปลี่ยนผลสแกนเป็นแผนขายที่ใช้ได้ทันที 3 ชั้น
1. บทวิเคราะห์สินค้า — อิงตัวเลขจริงจากผลสแกนเท่านั้น ห้ามแต่งตัวเลขเพิ่ม
2. มุมขาย 5 มุม — เรียงตามโอกาสชนะ
3. สคริปต์พากย์เสียง 3 ตัว — จาก 3 มุมที่ดีที่สุด อ่านออกเสียงได้ทันที

หลักคิดมุมขาย (กฎเหล็กของ LEGO METHOD):
- 1 สินค้า แตกได้หลายมุมขาย — แต่ละมุมคือ "คนแบบไหน × เจ็บเรื่องอะไร" ไม่ใช่ฟีเจอร์สินค้า
- ห้ามใช้มุมแบบ "สินค้าตัวนี้ดีมาก" — ต้องเป็น "ถ้าคุณเป็นคนที่…แล้วเจอปัญหา…"
- ทุกมุมต้องผูกกับสัญญาณจากตัวเลขจริง เช่น:
  - CTR สูง = มุมที่ตลาดใช้อยู่ work แล้ว → บอกว่ามุมตลาดหลักคืออะไร แล้วหา "มุมต่าง" ที่ยังว่าง
  - CVR สูง = สินค้าปิดการขายตัวเองได้ → สคริปต์เน้นพาไปดูตะกร้า ไม่ต้องขายหนัก
  - CVR ต่ำ + ATC สูง = คนลังเลตอนจ่าย → มุมต้องฆ่าความลังเล (ราคา/ความเสี่ยง/ของแท้)
  - Orders/Creator สูง + creators น้อย = ช่องว่างตลาด → เข้าเร็ว ก่อนคนแห่ตาม
  - Momentum ชะลอ = อย่าเล่นมุมเดิมของตลาด ต้องมุมใหม่เท่านั้น
- ถ้ามีรูปสินค้า: ใช้สิ่งที่เห็นจริงในรูป (รูปทรง สี การใช้งาน จุดเด่นที่มองเห็น) มาเป็นวัตถุดิบมุมขาย ห้ามเดาสรรพคุณที่มองไม่เห็น

กฎสำคัญที่สุด — ผู้ฟังของมุมขายและสคริปต์คือ "คนซื้อสินค้า" (end buyer) เท่านั้น:
- ห้ามสร้างมุมที่ persona เป็น creator/นายหน้า/คนอยากขายของ — คนดูคลิปคือคนที่จะซื้อสินค้าไปใช้เอง
- ตัวเลข commission / CVR / ATC / orders-per-creator / จำนวน creators คือข้อมูลภายในสำหรับวิเคราะห์เท่านั้น ห้ามหลุดเข้าไปในบทพูดเด็ดขาด
- Believability ในสคริปต์ใช้ได้เฉพาะสิ่งที่คนซื้อเห็นเองได้จริง เช่น ยอดขายบนหน้าสินค้า รีวิว หรือสิ่งที่เห็นในคลิป

กฎสคริปต์พากย์เสียง:
- ความยาวพูดจริง 30–60 วินาที (ประมาณ 80–150 คำไทย)
- โครง 6 ท่อนตามอารมณ์ (arc ที่พิสูจน์แล้วของ LEGO METHOD): Hook (0–3 วิ หยุดนิ้ว) → Pain (ตอกปัญหา) → ขยี้ (ขยายให้เห็นภาพ + สิ่งที่เสียถ้าปล่อยไว้) → Mechanism (สินค้าแก้ยังไง — สาธิต/โชว์ ไม่ใช่เคลม) → กันข้อสงสัย (ตอบ 1 ข้อลังเลที่ใหญ่ที่สุดก่อนซื้อ สั้นๆ) → CTA (กดตะกร้า)
- Hook เลือกจาก 3 ตระกูล: ปัญหา / ความอยาก / ขัดความเชื่อ — สคริปต์ 3 ตัวต้องใช้ hook คนละตระกูล
- ภาษาพูดจริงแบบคลิป TikTok ไทย ประโยคสั้น ไม่มีคำหรู ไม่มีภาษาโฆษณา
- ใส่ [ฉาก: …] สั้นๆ หน้าแต่ละท่อน บอกว่าถ่ายอะไรประกอบ
- CTA ห้ามเวอร์ ห้ามกดดันปลอม — ใช้เหตุผลจริงจากตัวเลข (เช่น stock เหลือน้อยจริงค่อยพูดเรื่อง stock)

กฎความปลอดภัย TikTok (สำคัญมาก — บัญชีผู้ใช้โดนแบนได้จริง):
- ห้ามเคลมทางยา/รักษา/ลดน้ำหนักเกินจริง (เช่น "หายขาด" "ลด 10 โลใน 7 วัน" "รักษาสิว")
- สินค้ากลุ่มอาหารเสริม/สกินแคร์: พูดได้แค่ประสบการณ์การใช้ + สิ่งที่เห็นได้ ห้ามอ้างผลลัพธ์ทางการแพทย์
- ห้ามการันตีรายได้หรือผลลัพธ์
- ถ้าสินค้าอยู่ในกลุ่มเสี่ยง ให้ระบุคำต้องห้ามของสินค้านี้ใน risk_flags

ความซื่อสัตย์:
- ถ้าผลตัดสินคือ DEAD/DROP: วิเคราะห์ตรงๆ ว่าทำไมไม่ควรลงแรง และมุม/สคริปต์ให้ทำเฉพาะแบบ "ทดสอบต้นทุนต่ำ" พร้อมบอกชัดว่านี่คือสินค้าความเสี่ยงสูง
- ถ้าผลคือ RISKY/WAIT: บอกชัดว่าจุดอ่อนคืออะไร และมุมขายต้องชดเชยจุดอ่อนตรงไหน
- ห้ามเติมตัวเลขที่ไม่มีในข้อมูล

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น ห้าม markdown:
{
  "analysis": {
    "headline": "<สรุป 1 ประโยคว่าสินค้านี้น่าเล่นแค่ไหน เพราะอะไร>",
    "market_read": "<อ่านตลาดจากตัวเลข 2-4 ประโยค: ใครซื้อ ทำไมตอนนี้ คู่แข่งหนาแน่นแค่ไหน>",
    "strengths": ["<จุดแข็งอิงตัวเลข>", "..."],
    "risks": ["<ความเสี่ยงอิงตัวเลข>", "..."],
    "risk_flags": ["<คำ/เคลมต้องห้ามสำหรับสินค้านี้ ถ้าไม่มีให้ []>"]
  },
  "angles": [
    {
      "rank": 1,
      "name": "<ชื่อมุมสั้นๆ>",
      "persona": "<คนแบบไหน>",
      "pain": "<เจ็บเรื่องอะไร>",
      "promise": "<สินค้าเปลี่ยนอะไรให้เขา>",
      "data_signal": "<ตัวเลขไหนจากผลสแกนที่บอกว่ามุมนี้มีโอกาส>",
      "hook_example": "<ประโยคเปิดตัวอย่าง 1 ประโยค>"
    }
    // 5 มุม เรียง rank 1-5
  ],
  "scripts": [
    {
      "angle_rank": 1,
      "angle_name": "<ชื่อมุม>",
      "hook_family": "<ปัญหา|ความอยาก|ขัดความเชื่อ>",
      "duration_sec": <30-45>,
      "sections": [
        { "label": "Hook", "scene": "<[ฉาก] สั้นๆ>", "vo": "<คำพูด>" },
        { "label": "Pain", "scene": "...", "vo": "..." },
        { "label": "ขยี้", "scene": "...", "vo": "..." },
        { "label": "Mechanism", "scene": "...", "vo": "..." },
        { "label": "กันข้อสงสัย", "scene": "...", "vo": "..." },
        { "label": "CTA", "scene": "...", "vo": "..." }
      ]
    }
    // 3 สคริปต์ จากมุม rank 1-3
  ]
}`;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "config_error", message: "ยังไม่ได้ตั้ง ANTHROPIC_API_KEY" });
  }

  if (configMissing()) {
    return res.status(500).json({ error: "config_error", message: "ยังไม่ได้ตั้ง SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const token = getSessionToken(req);

    const identity = await resolveSessionIdentity(token);
    if (!identity) {
      return res.status(401).json({ error: "unauthorized", message: "Session หมดอายุ — logout แล้ว login ใหม่" });
    }
    const email = identity.email;

    const product = body.product || {};
    if (!product.decision || !product.metrics) {
      return res.status(400).json({ error: "bad_request", message: "ไม่มีผลสแกน — กรอกข้อมูลให้ครบแล้วดูผลก่อน" });
    }

    const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];

    const brief = buildScanBrief(product);

    const content = [];
    images.forEach((img) => {
      if (!img || !img.data) return;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.media_type || "image/jpeg",
          data: img.data,
        },
      });
    });

    let userNote = "";
    if (typeof body.audience === "string" && body.audience.trim()) {
      userNote = `\n\nข้อมูลเพิ่มจากผู้ใช้ (กลุ่มเป้าหมาย/บริบทที่เขารู้): ${body.audience.trim().slice(0, 500)}`;
    }

    content.push({
      type: "text",
      text: `${SELL_KIT_PROMPT}\n\n════ ผลสแกนจริงจาก LEGO SCANNER ════\n${brief}${userNote}${images.length ? "\n\n(มีรูปสินค้าแนบมา " + images.length + " รูป — ใช้สิ่งที่เห็นจริงในรูปประกอบการวิเคราะห์และมุมขาย)" : "\n\n(ไม่มีรูปสินค้าแนบ — วิเคราะห์จากชื่อสินค้าและตัวเลขเท่านั้น ห้ามเดารายละเอียดที่มองไม่เห็น)"}`,
    });

    console.log("[sell-kit] calling Claude", { email, model: ANTHROPIC_MODEL, images: images.length, decision: product.decision });

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // บทเรียนซ้ำจาก generate-angles: JSON ไทย long-form โดนตัดกลางถ้า token น้อย
        max_tokens: 9000,
        temperature: 0.7,
        messages: [{ role: "user", content }],
      }),
    });

    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      console.error("[sell-kit] Claude error:", aiRes.status, errTxt);
      return res.status(502).json({
        error: "ai_error",
        message: `AI มีปัญหาชั่วคราว (${aiRes.status}) — ลองใหม่อีกครั้ง`,
        detail: errTxt.slice(0, 500),
      });
    }

    const aiData = await aiRes.json();
    const textOut = (aiData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    let kit;
    try {
      kit = JSON.parse(cleanJsonText(textOut));
    } catch (e) {
      console.error("[sell-kit] parse error, raw:", textOut.slice(0, 800));
      return res.status(502).json({
        error: "parse_error",
        message: "AI ตอบกลับมาไม่สมบูรณ์ — กดสร้างใหม่อีกครั้ง",
      });
    }

    if (!kit || !kit.analysis || !Array.isArray(kit.angles) || !Array.isArray(kit.scripts)) {
      return res.status(502).json({
        error: "invalid_kit",
        message: "ผลลัพธ์ไม่ครบ — กดสร้างใหม่อีกครั้ง",
      });
    }

    // persist สรุป kit ลง tracker เหมือน generate-angles (best-effort — ไม่ block ผลลัพธ์)
    try {
      const product_key = String(product.name || "").trim().toLowerCase();
      if (product_key) {
        await sbRest(`user_product_tracker?on_conflict=user_email,product_key`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            user_email: email,
            product_key,
            angle_idea: kit.angles.map((a) => `${a.rank}. ${a.name} | ${a.persona} | pain: ${a.pain} | signal: ${a.data_signal}`).join("\n"),
            hook_idea: kit.angles.map((a) => `${a.rank}. ${a.hook_example || ""}`).join("\n"),
            updated_at: new Date().toISOString(),
          }),
        });
      }
    } catch (e) {
      console.warn("[sell-kit] tracker persist failed (soft):", e?.message || e);
    }

    const response = { ok: true, kit };

    if (DEBUG_SCANNER) {
      response.debug = { model: ANTHROPIC_MODEL, raw: textOut.slice(0, 2000) };
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("[sell-kit] server error:", err);
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
}
