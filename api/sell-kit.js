// ════════════════════════════════════════════════
// /api/sell-kit.js — MAGIC BUTTON: ภาพ → มุมขาย → สคริปต์ตามฉากที่ถ่ายได้จริง
//
// 2 จังหวะ (แก้ปัญหา "AI คิดนานเกินไป" ของ flow เดิมที่ทำทุกอย่างใน call เดียว):
//   stage "analyze" — รูปสินค้า+กราฟกี่รูปก็ได้ (สูงสุด 15) + ตัวเลขจากฟอร์ม (ถ้ามี)
//                     → บทวิเคราะห์ + มุมขาย 5 มุม (ยังไม่เขียนสคริปต์ = เร็ว)
//   stage "script"  — มุมที่เลือก + ความยาว + สไตล์ถ่าย + ฉาก/สถานที่ที่ user ถ่ายได้จริง
//                     → สคริปต์ 1 ตัว เขียนเฉพาะฉากที่มีจริงเท่านั้น
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
const MAX_IMAGES = 15;

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

// สรุปผลสแกนจากฟอร์ม (optional — magic button ทำงานได้จากภาพล้วนๆ)
function buildScanBrief(p) {
  if (!p || !p.metrics) return "";
  const m = p.metrics;
  const s = p.scores || {};
  const lines = [];
  lines.push(`\n════ ตัวเลขจากฟอร์ม Scanner (user ตรวจแล้ว — ถ้าขัดกับที่อ่านได้จากภาพ ให้เชื่อฟอร์ม) ════`);
  if (p.name) lines.push(`ชื่อสินค้า: ${p.name}`);
  if (p.decision) lines.push(`ผลตัดสิน Scanner: ${p.decision} (${p.total}/${p.max} = ${Math.round((p.pct || 0) * 100)}%)`);

  if (p.mode === "discovery") {
    lines.push(`Commission: ${fmt(m.commission, "%")} | GMV 7d: ${fmt(m.gmv7)} | GMV 30d: ${fmt(m.gmv30)} | creators: ${fmt(m.creators)}`);
    if (Array.isArray(m.angles) && m.angles.length) lines.push(`มุมที่ user คิดไว้เอง: ${m.angles.join(" / ")}`);
  } else {
    lines.push(`Commission: ${fmt(m.commission, "%")} (score ${fmt(s.sComm)}/3)`);
    lines.push(`Orders 7d/30d: ${fmt(m.orders7)}/${fmt(m.orders30)} (momentum ${fmt(s.sOrders)}/3)`);
    lines.push(`CTR: ${fmt(m.ctr, "%")} (${fmt(s.sCTR)}/3) — CTR สูง = มุมที่ตลาดใช้อยู่หยุดนิ้วได้`);
    lines.push(`ATC 7d/30d: ${fmt(m.atc7)}/${fmt(m.atc30)} (${fmt(s.sATC)}/3)`);
    lines.push(`CVR: ${fmt(m.cvr ? Number(m.cvr).toFixed(1) : null, "%")} (${fmt(s.sCVR)}/3) — สูง = ใส่ตะกร้าแล้วซื้อง่าย`);
    lines.push(`Creators 7d/30d: ${fmt(m.creators7)}/${fmt(m.creators30)} | Orders/Creator: ${fmt(m.opc ? Number(m.opc).toFixed(1) : null)} (${fmt(s.sCreator)}/3)`);
    lines.push(`Stock: ${fmt(m.stock)} (${fmt(s.sStock)}/3)`);
  }
  if (Array.isArray(p.weakest) && p.weakest.length) lines.push(`จุดอ่อนคะแนนต่ำสุด: ${p.weakest.join(", ")}`);
  return lines.join("\n");
}

// กฎร่วมที่ทุก stage ต้องเคารพ
const SHARED_RULES = `กฎเหล็ก (ห้ามละเมิด):
- ผู้ฟังของมุมขายและสคริปต์คือ "คนซื้อสินค้าไปใช้เอง" เท่านั้น ห้ามพูดกับ creator/นายหน้า
- ตัวเลขระบบ (commission / CVR / ATC / orders-per-creator / จำนวน creators) ใช้วิเคราะห์ได้ แต่ห้ามหลุดเข้าบทพูดเด็ดขาด
- ห้ามเคลมทางยา/รักษา/ลดน้ำหนักเกินจริง สินค้าเสริม/สกินแคร์พูดได้แค่ประสบการณ์ใช้ + สิ่งที่เห็นได้
- ห้ามแต่งตัวเลขที่ไม่มีในข้อมูล ห้าม urgency ปลอม
- ภาษาพูดจริงแบบคลิป TikTok ไทย ประโยคสั้น ไม่มีภาษาโฆษณา`;

const ANALYZE_PROMPT = `คุณคือ LEGO SELL KIT — เครื่องยนต์เปลี่ยน "ภาพสินค้า + กราฟ" ให้กลายเป็นมุมขายที่ใช้ได้ทันที

สิ่งที่คุณจะได้รับ: รูปภาพหลายรูป (อาจเป็นรูปสินค้า, screenshot TikTok Promotion info, กราฟยอดขาย, หน้าร้านคู่แข่ง — ผสมกันได้) และอาจมีตัวเลขจากฟอร์ม Scanner แนบมา

ขั้นตอน:
1. แยกประเภทรูปแต่ละรูป: รูปสินค้า / กราฟ-ตัวเลข / อื่นๆ
2. จากรูปสินค้า: ระบุว่าสินค้าคืออะไร รูปทรง จุดเด่นที่มองเห็น การใช้งาน (ห้ามเดาสรรพคุณที่มองไม่เห็น)
3. จากกราฟ/ตัวเลข: อ่านแบบ conservative — ไม่ชัดไม่ต้องใช้ ห้ามเดา (ถ้ามีตัวเลขจากฟอร์มให้เชื่อฟอร์มก่อน)
4. วิเคราะห์ตลาด: ใครซื้อ ทำไมตอนนี้ คู่แข่งหนาแน่นไหม สัญญาณอะไรบอกโอกาส/ความเสี่ยง
5. แตกมุมขาย 5 มุม เรียงตามโอกาสชนะ

หลักคิดมุมขาย: แต่ละมุม = "คนแบบไหน × เจ็บเรื่องอะไร" ไม่ใช่ฟีเจอร์สินค้า ห้ามมุม "สินค้าตัวนี้ดีมาก" — ต้องเป็น "ถ้าคุณเป็นคนที่…เจอปัญหา…" และ 5 มุมต้องคนละ pain คนละกลุ่มคนจริงๆ

${SHARED_RULES}

ตอบเป็น JSON เท่านั้น ห้าม markdown:
{
  "product_name": "<ชื่อ/ประเภทสินค้าที่ระบุได้จากภาพหรือฟอร์ม>",
  "analysis": {
    "headline": "<1 ประโยค: น่าเล่นแค่ไหน เพราะอะไร>",
    "market_read": "<2-4 ประโยค: ใครซื้อ ทำไมตอนนี้ คู่แข่ง อ้างสิ่งที่เห็นจากภาพ/ตัวเลขจริง>",
    "strengths": ["<จุดแข็ง อิงภาพ/ตัวเลขจริง>"],
    "risks": ["<ความเสี่ยง อิงภาพ/ตัวเลขจริง>"],
    "risk_flags": ["<คำ/เคลมต้องห้ามของสินค้านี้ ถ้าไม่มีให้ []>"]
  },
  "angles": [
    {
      "rank": 1,
      "name": "<ชื่อมุมสั้นๆ>",
      "persona": "<คนแบบไหน>",
      "pain": "<เจ็บเรื่องอะไร>",
      "promise": "<สินค้าเปลี่ยนอะไรให้เขา>",
      "data_signal": "<สิ่งที่เห็นจากภาพ/ตัวเลขที่บอกว่ามุมนี้มีโอกาส>",
      "hook_example": "<ประโยคเปิด 1 ประโยค>"
    }
  ]
}
(angles ครบ 5 มุม เรียง rank 1-5 — กระชับ ไม่ต้องน้ำเยอะ)`;

// ═══════ WINNING PRODUCT EXPANSION (framework ของ founder — ห้ามแก้หลักคิด) ═══════
// แตก Winning Product เป็น Content System: Diagnosis → Avatars → 30 มุม → Hooks 50 → แผนเทสต์
// แบ่งเป็น 3 stage เพื่อความเร็ว: expand (section 1-4) / hooks (section 5) / plan (section 6,8,9,10)
// section 7 (full scripts) ใช้ stage "script" ต่อมุมที่มีอยู่แล้ว

const WIN_ROLE = `คุณคือ TikTok Shop Affiliate Sales Angle Strategist ระดับ Top 0.1%
หน้าที่ของคุณคือ "แตกมุมการขายจาก Winning Product" ให้กลายเป็นหลายคลิป หลายมุม หลาย buyer pain โดยไม่ต้องหาสินค้าใหม่
เป้าหมาย: เปลี่ยนสินค้าที่เริ่มขายได้/คลิปเริ่มมีออเดอร์/เริ่มแมส ให้กลายเป็น Content System ที่ Test, Scale, Re-angle ได้อย่างเป็นระบบ

ข้อห้าม (เด็ดขาด):
- ห้ามให้คำตอบ generic ห้ามแตกมุมแบบผิวเผิน
- ห้ามพูดแค่ "ทำรีวิว / ทำ before-after"
- ห้ามเน้นยอดวิวมากกว่ายอดขาย ห้ามดึง beginner ที่ไม่มี buying intent
- ห้ามใช้คำเคลมเกินจริง ห้ามเขียนเหมือนแบรนด์พูดเอง
- ต้องเขียนเหมือน creator ที่ขายของเป็น
- ผู้ฟังคือคนซื้อสินค้า — ห้ามพูดถึงค่าคอม/ตัวเลขระบบในบทพูดหรือ hook`;

function buildWinBrief(w) {
  const f = (label, v) => (v && String(v).trim() ? `${label}: ${String(v).trim().slice(0, 400)}` : null);
  return [
    f("1. ชื่อสินค้า", w.name),
    f("2. หมวดสินค้า", w.category),
    f("3. ราคา", w.price),
    f("4. ค่าคอม", w.commission),
    f("5. คลิปที่ขายได้พูดมุมไหน", w.winning_angle),
    f("6. Hook ที่ใช้", w.winning_hook),
    f("7. คนซื้อคือใคร", w.buyer),
    f("8. Pain หลักของคนซื้อ", w.pain),
    f("9. จุดเด่นสินค้า", w.strengths),
    f("10. จุดที่คนลังเลก่อนซื้อ", w.hesitation),
    f("11. คอมเมนต์/คำถามจากลูกค้า", w.comments),
    f("12. คู่แข่งขายมุมไหนอยู่", w.competitors),
    f("13. ข้อจำกัดของสินค้า", w.limits),
    f("14. เป้าหมายของคลิปใหม่", w.goal),
  ].filter(Boolean).join("\n");
}

// part: "core" = section 1-3 | "angles:A-E" / "angles:F-J" = section 4 ครึ่งละ 15 มุม
// แยก 3 call ยิงขนานจาก frontend — call เดียว 30 มุมโดนตัด JSON + ช้า 3.5 นาที (พิสูจน์แล้ว)
const ANGLE_CATS = {
  "A-E": `A. Pain (เจ็บปัญหาโดยตรง) / B. Mistake (คุณกำลังใช้/เลือก/ทำผิดอยู่) / C. Comparison (ก่อน-หลัง, ถูก-แพง, ตัวนี้ vs ตัวเก่า) / D. Identity (คนแบบฉันควรใช้สิ่งนี้) / E. Daily Situation (สถานการณ์ประจำวันที่ทำให้จำเป็น)`,
  "F-J": `F. Objection (แพงไหม ใช้ยากไหม เห็นผลจริงไหม เหมาะกับใคร) / G. Proof (ผลลัพธ์ รีวิว ทดลอง reaction) / H. Urgency (ไม่ซื้อตอนนี้พลาดอะไร — ห้าม urgency ปลอม) / I. Gift/Occasion (ของขวัญ เทศกาล ให้แฟน พ่อแม่ ลูก) / J. Competitor Reframe (ทำให้ต่างจากของที่คนเคยเห็น)`,
};

function buildExpandPrompt(winBrief, hasImages, part) {
  const head = `${WIN_ROLE}

ข้อมูลสินค้า:
${winBrief}
${hasImages ? "(มีรูปสินค้า/กราฟแนบมา — ใช้สิ่งที่เห็นจริงประกอบ ห้ามเดาสิ่งที่มองไม่เห็น)" : ""}
ข้อมูลข้อไหนไม่ได้ให้มา ให้วิเคราะห์จากข้อมูลที่มี ห้ามแต่งข้อมูลเพิ่ม`;

  if (part === "core") {
    return `${head}

ทำ 3 ส่วนนี้:

1. Product Diagnosis — สินค้านี้ขายได้เพราะอะไรจริงๆ อย่าตอบว่า "สินค้าดี" ให้หา hidden buying reason (แก้ pain รายวัน / ชีวิตง่ายขึ้น / ดูดีขึ้น / ลดความอาย / ลดความเสี่ยง / ประหยัดเงิน / ประหยัดเวลา / ใช้แทนของแพง / รู้สึกฉลาดที่ซื้อ / กลัวพลาด / เห็นผลเร็ว)

2. Winning Angle Breakdown — แยกคลิปที่ขายได้: Hook ดึงคนแบบไหน / Pain ที่หยุดคนดู / Desire ที่ถูกกระตุ้น / Belief ที่ถูกเปลี่ยน / Proof ที่ทำให้เชื่อ / CTA ที่ทำให้ซื้อ / เหตุผลที่มุมนี้ชนะ (ถ้าไม่มีข้อมูลคลิปเดิม ให้ null)

3. Core Buyer Avatar — 3-5 กลุ่ม แต่ละกลุ่ม: เขาเป็นใคร / เจ็บเรื่องอะไร / อยากได้ผลลัพธ์อะไร / กลัวอะไร / ต้องได้ยินประโยคไหนถึงจะซื้อ

ตอบเป็น JSON เท่านั้น (ทุก field ประโยคสั้น ห้ามน้ำ):
{
  "product_name": "<ชื่อสินค้า>",
  "diagnosis": {
    "summary": "<2-3 ประโยค: ขายได้เพราะอะไรจริงๆ>",
    "hidden_buying_reasons": [ { "reason": "<ชื่อเหตุผล>", "why": "<อธิบายสั้น>" } ]
  },
  "winning_breakdown": { "hook_type": "", "pain": "", "desire": "", "belief_shift": "", "proof": "", "cta": "", "why_it_won": "" } หรือ null,
  "avatars": [ { "name": "<ชื่อกลุ่มสั้น>", "who": "", "pain": "", "want": "", "fear": "", "buying_line": "<ประโยคที่ต้องได้ยินถึงจะซื้อ>" } ]
}`;
  }

  const range = part === "angles:F-J" ? "F-J" : "A-E";
  const startNo = range === "A-E" ? 1 : 16;
  return `${head}

Sales Angle Expansion — แตกมุมขาย 15 มุม แบ่ง 5 หมวด หมวดละ 3 มุม:
${ANGLE_CATS[range]}

แต่ละมุมต้องคนละ pain คนละกลุ่มคนจริงๆ ห้ามผิวเผิน ห้ามซ้ำกันเอง
ทุก field เขียนสั้น 1 ประโยค (main_message/selling_point ไม่เกิน 15 คำ)

ตอบเป็น JSON เท่านั้น:
{ "angles": [ { "no": ${startNo}, "category": "<หมวด เช่น A. Pain>", "name": "<Angle Name>", "hook": "<Hook>", "main_message": "", "buyer_pain": "", "selling_point": "", "cta": "", "clip_type": "<Vlog|Review|Voiceover|Comparison|Demo|Story|Reaction>" } ] }
(ครบ 15 มุม no ${startNo}-${startNo + 14} เรียงตามหมวด)`;
}

function buildHooksPrompt(winBrief, expandSummary) {
  return `${WIN_ROLE}

ข้อมูลสินค้า:
${winBrief}
${expandSummary ? `\nสรุปจากการวิเคราะห์: ${expandSummary}` : ""}

สร้าง Hook 50 อันสำหรับสินค้านี้ แบ่งเป็น:
- 10 Hook แบบเจ็บ pain
- 10 Hook แบบเตือนว่ากำลังทำผิด
- 10 Hook แบบเปรียบเทียบ
- 10 Hook แบบ curiosity
- 10 Hook แบบ buyer-now พร้อมซื้อ

Hook ต้องสั้น แรง เข้าใจใน 1-2 วินาทีแรก ห้าม generic ห้ามเริ่มด้วย "วันนี้จะมารีวิว" ห้ามพูดเหมือนโฆษณา ห้ามซ้ำ pattern กันเอง

ตอบเป็น JSON เท่านั้น:
{ "hooks": { "pain": ["...×10"], "mistake": ["...×10"], "comparison": ["...×10"], "curiosity": ["...×10"], "buyer_now": ["...×10"] } }`;
}

function buildPlanPrompt(winBrief, anglesList) {
  return `${WIN_ROLE}

ข้อมูลสินค้า:
${winBrief}

มุมขายที่แตกไว้แล้ว (30 มุม):
${anglesList}

ทำ 4 ส่วนนี้:

1. Content Re-angle Map — เอาคลิป winning เดิมแตกเป็น 10 เวอร์ชันใหม่ แต่ละเวอร์ชันเปลี่ยนอย่างน้อย 1 อย่าง (Hook / Pain / Buyer / สถานการณ์ / B-roll / Proof / CTA / Story / Objection / Comparison)

2. Scale Decision — 3 มุมทำก่อน / 3 มุมโอกาสขายดีสุด / 3 มุมเหมาะคนพร้อมซื้อ / 3 มุมดึงคนกว้าง / มุมที่ควรเลี่ยงเพราะดึงคนไม่ซื้อ / ควรทำกี่คลิปใน 7 วัน / ถ้ามุมไหนชนะ scale ยังไงต่อ (อ้างมุมด้วยเลข no + ชื่อ)

3. Test Plan 7 วัน — Day 1-7 ลงมุมไหน วันละกี่คลิป คลิปไหน test / scale / proof / objection handling

4. Metrics — metric ที่ต้องดู (3-second hold, avg watch time, watched full, CTR, add to cart, orders, comment intent, save rate, revenue per clip, order per 1,000 views) + กฎตัดสิน: view เยอะไม่ขายแก้ยังไง / view น้อยขายดี scale ยังไง / คนถามเยอะไม่ซื้อแปลว่าอะไร / เมื่อไหร่หยุดทันที

ตอบเป็น JSON เท่านั้น (กระชับ):
{
  "reangle_map": [ { "version": 1, "angle": "", "hook": "", "changed": "<สิ่งที่เปลี่ยน>", "why_test": "", "kpi": "" } ],
  "scale": {
    "do_first": ["<no. ชื่อมุม — เหตุผลสั้น>"], "best_sellers": [""], "buyer_ready": [""], "broad_reach": [""],
    "avoid": ["<มุมที่เลี่ยง + เพราะอะไร>"], "clips_in_7_days": <number>, "scale_how": "<ถ้าชนะ scale ยังไง>"
  },
  "test_plan": [ { "day": 1, "clips": [ { "angle": "", "purpose": "<test|scale|proof|objection>" } ] } ],
  "metrics": {
    "watch": ["<metric + เกณฑ์>"],
    "decisions": [ { "situation": "view เยอะแต่ไม่ขาย", "action": "" }, { "situation": "view น้อยแต่ขายดี", "action": "" }, { "situation": "คนถามเยอะแต่ไม่ซื้อ", "action": "" }, { "situation": "หยุดทันทีเมื่อ", "action": "" } ]
  }
}`;
}

function buildScriptPrompt({ productName, analysisBrief, angle, options }) {
  const duration = Math.min(180, Math.max(15, parseInt(options.duration_sec, 10) || 30));
  const style = String(options.style || "แบบไหนก็ได้").slice(0, 100);
  const scenes = String(options.scenes || "").trim().slice(0, 600);

  // จำนวนท่อนตามความยาว — คลิปสั้นไม่ต้องครบ 6 ท่อน
  let beatGuide;
  if (duration <= 20) beatGuide = "4 ท่อน: Hook → Pain → Mechanism → CTA (สั้น กระชับ ทุกวินาทีมีค่า)";
  else if (duration <= 45) beatGuide = "5-6 ท่อน: Hook → Pain → ขยี้ → Mechanism → (กันข้อสงสัยถ้าจำเป็น) → CTA";
  else beatGuide = "6-7 ท่อน: Hook → Pain → ขยี้ (ขยาย + สิ่งที่เสียถ้าปล่อยไว้) → Mechanism/สาธิต → เหตุผลว่าทำไมต้องตัวนี้ → กันข้อสงสัย → CTA";

  return `คุณคือมือเขียนสคริปต์คลิป TikTok ขายของ — เขียนสคริปต์ 1 ตัวจากมุมขายที่เลือกไว้แล้ว ให้ถ่ายได้จริงตามเงื่อนไขของคนถ่าย

สินค้า: ${productName}
${analysisBrief ? `บริบทจากการวิเคราะห์: ${analysisBrief}` : ""}

มุมขายที่เลือก:
- ชื่อมุม: ${angle.name}
- คนซื้อ: ${angle.persona}
- Pain: ${angle.pain}
- Promise: ${angle.promise}
${angle.hook_example ? `- แนว hook: ${angle.hook_example}` : ""}

เงื่อนไขการถ่ายของ user (สำคัญมาก — เขียนเกินกว่านี้ไม่ได้):
- ความยาวคลิป: ~${duration} วินาที (คำพูดประมาณ ${Math.round(duration * 2.5)} คำไทย)
- สไตล์การถ่าย: ${style}
- ฉาก/สถานที่/อุปกรณ์ที่ถ่ายได้จริง: ${scenes || "ไม่ระบุ — ใช้ฉากพื้นฐานที่ใครก็ถ่ายได้ (ห้องในบ้าน + มีสินค้าจริง 1 ชิ้น)"}

กฎการเขียนฉาก:
- ทุก [ฉาก] ต้องถ่ายได้ด้วยสิ่งที่ user บอกว่ามีเท่านั้น ห้ามสั่งฉากที่เขาไม่มี (เช่น ห้ามสั่ง "ถ่ายที่ออฟฟิศ" ถ้าเขาบอกว่ามีแค่ห้องนอน)
- CTA ต้องปิดที่ตะกร้า TikTok Shop เสมอ ("กดตะกร้าด้านล่าง" / "กดดูในตะกร้า") — ห้ามใช้ "ลิงก์ใน bio"
- ถ้าสไตล์คือพากย์เสียงทับ b-roll: vo = เสียงพากย์ล้วน ฉาก = ภาพสินค้า/การใช้งานที่ถ่ายได้
- ถ้าสไตล์คือพูดหน้ากล้อง: vo = คำพูดหน้ากล้อง ธรรมชาติเหมือนเล่าให้เพื่อนฟัง
- โครง: ${beatGuide}

${SHARED_RULES}

ตอบเป็น JSON เท่านั้น:
{
  "script": {
    "angle_name": "${angle.name}",
    "duration_sec": ${duration},
    "style": "${style}",
    "hook_family": "<ปัญหา|ความอยาก|ขัดความเชื่อ>",
    "sections": [
      { "label": "<ชื่อท่อน>", "scene": "<[ฉาก] ที่ถ่ายได้จริงตามเงื่อนไข>", "vo": "<คำพูด>" }
    ],
    "shooting_note": "<เคล็ดลับถ่าย 1-2 ประโยคสำหรับฉากที่ user มี>"
  }
}`;
}

async function callClaude(content, maxTokens) {
  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [{ role: "user", content }],
    }),
  });

  if (!aiRes.ok) {
    const errTxt = await aiRes.text();
    const err = new Error(`claude_${aiRes.status}`);
    err.status = aiRes.status;
    err.detail = errTxt.slice(0, 500);
    throw err;
  }

  const aiData = await aiRes.json();
  return (aiData.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

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

    const VALID_STAGES = ["analyze", "script", "expand", "hooks", "plan"];
    const stage = VALID_STAGES.includes(body.stage) ? body.stage : "analyze";

    // ─────────────────────────────────────────
    // STAGE 2: เขียนสคริปต์จากมุมที่เลือก + เงื่อนไขถ่ายจริง
    // ─────────────────────────────────────────
    if (stage === "script") {
      const angle = body.angle || {};
      if (!angle.name || !angle.pain) {
        return res.status(400).json({ error: "bad_request", message: "ไม่มีมุมขาย — กดวิเคราะห์ภาพก่อน แล้วเลือกมุม" });
      }

      const productName = String(body.product_name || "สินค้า").slice(0, 300);
      const analysisBrief = String(body.analysis_brief || "").slice(0, 800);
      const options = body.options || {};

      const prompt = buildScriptPrompt({
        productName,
        analysisBrief,
        angle: {
          name: String(angle.name).slice(0, 200),
          persona: String(angle.persona || "").slice(0, 300),
          pain: String(angle.pain).slice(0, 300),
          promise: String(angle.promise || "").slice(0, 300),
          hook_example: String(angle.hook_example || "").slice(0, 300),
        },
        options,
      });

      const textOut = await callClaude([{ type: "text", text: prompt }], 3000);

      let parsed;
      try {
        parsed = JSON.parse(cleanJsonText(textOut));
      } catch (e) {
        console.error("[sell-kit script] parse error:", textOut.slice(0, 500));
        return res.status(502).json({ error: "parse_error", message: "AI ตอบไม่สมบูรณ์ — กดใหม่อีกครั้ง" });
      }

      if (!parsed?.script || !Array.isArray(parsed.script.sections) || !parsed.script.sections.length) {
        return res.status(502).json({ error: "invalid_script", message: "สคริปต์ไม่ครบ — กดใหม่อีกครั้ง" });
      }

      console.log("[sell-kit] script ok:", { email, angle: angle.name, dur: parsed.script.duration_sec });
      return res.status(200).json({ ok: true, script: parsed.script });
    }

    // ─────────────────────────────────────────
    // WINNING EXPANSION: expand (section 1-4) / hooks (section 5) / plan (section 6,8,9,10)
    // ─────────────────────────────────────────
    if (stage === "expand" || stage === "hooks" || stage === "plan") {
      const win = body.win || {};
      if (!win.name || !String(win.name).trim()) {
        return res.status(400).json({ error: "bad_request", message: "ใส่ชื่อสินค้าก่อน — ระบบต้องรู้ว่ากำลังแตกมุมอะไร" });
      }
      const winBrief = buildWinBrief(win);

      if (stage === "expand") {
        // แยก 3 part ยิงขนานจาก frontend: core / angles:A-E / angles:F-J
        // (call เดียว 30 มุม = JSON โดนตัด + 3.5 นาที — พิสูจน์แล้ว 2026-07-21)
        const part = ["core", "angles:A-E", "angles:F-J"].includes(body.part) ? body.part : "core";
        const images = part === "core" ? (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES) : [];
        const content = [];
        images.forEach((img) => {
          if (!img || !img.data) return;
          content.push({
            type: "image",
            source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data },
          });
        });
        content.push({ type: "text", text: buildExpandPrompt(winBrief, images.length > 0, part) });

        console.log("[sell-kit] expand:", { email, product: win.name, part, images: images.length });
        const textOut = await callClaude(content, part === "core" ? 4000 : 7000);

        let parsed;
        try {
          parsed = JSON.parse(cleanJsonText(textOut));
        } catch (e) {
          console.error(`[sell-kit expand ${part}] parse error:`, textOut.slice(-400));
          return res.status(502).json({ error: "parse_error", message: "AI ตอบไม่สมบูรณ์ — กดใหม่อีกครั้ง" });
        }

        if (part === "core") {
          if (!parsed?.diagnosis || !Array.isArray(parsed.avatars)) {
            return res.status(502).json({ error: "invalid_expand", message: "ผลลัพธ์ไม่ครบ — กดใหม่อีกครั้ง" });
          }
        } else if (!Array.isArray(parsed?.angles) || parsed.angles.length < 10) {
          return res.status(502).json({ error: "invalid_expand", message: "มุมไม่ครบ — กดใหม่อีกครั้ง" });
        }

        return res.status(200).json({ ok: true, part, expand: parsed });
      }

      if (stage === "hooks") {
        const expandSummary = String(body.expand_summary || "").slice(0, 600);
        console.log("[sell-kit] hooks:", { email, product: win.name });
        const textOut = await callClaude([{ type: "text", text: buildHooksPrompt(winBrief, expandSummary) }], 5000);

        let parsed;
        try {
          parsed = JSON.parse(cleanJsonText(textOut));
        } catch (e) {
          console.error("[sell-kit hooks] parse error:", textOut.slice(-400));
          return res.status(502).json({ error: "parse_error", message: "AI ตอบไม่สมบูรณ์ — กดใหม่อีกครั้ง" });
        }
        if (!parsed?.hooks || !Array.isArray(parsed.hooks.pain)) {
          return res.status(502).json({ error: "invalid_hooks", message: "Hook ไม่ครบ — กดใหม่อีกครั้ง" });
        }
        return res.status(200).json({ ok: true, hooks: parsed.hooks });
      }

      // stage === "plan"
      const anglesList = String(body.angles_list || "").slice(0, 4000);
      if (!anglesList) {
        return res.status(400).json({ error: "bad_request", message: "ต้องแตก 30 มุมก่อน (กดปุ่มวิเคราะห์) แล้วค่อยขอแผน" });
      }
      console.log("[sell-kit] plan:", { email, product: win.name });
      const textOut = await callClaude([{ type: "text", text: buildPlanPrompt(winBrief, anglesList) }], 8000);

      let parsed;
      try {
        parsed = JSON.parse(cleanJsonText(textOut));
      } catch (e) {
        console.error("[sell-kit plan] parse error:", textOut.slice(-400));
        return res.status(502).json({ error: "parse_error", message: "AI ตอบไม่สมบูรณ์ — กดใหม่อีกครั้ง" });
      }
      if (!Array.isArray(parsed?.reangle_map) || !parsed?.scale || !Array.isArray(parsed?.test_plan)) {
        return res.status(502).json({ error: "invalid_plan", message: "แผนไม่ครบ — กดใหม่อีกครั้ง" });
      }
      return res.status(200).json({ ok: true, plan: parsed });
    }

    // ─────────────────────────────────────────
    // STAGE 1: ภาพ (+ ฟอร์มถ้ามี) → วิเคราะห์ + 5 มุมขาย
    // ─────────────────────────────────────────
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES);
    const product = body.product || null;
    const hasFormData = !!(product && product.metrics);

    if (!images.length && !hasFormData) {
      return res.status(400).json({ error: "bad_request", message: "ใส่รูปสินค้า/กราฟอย่างน้อย 1 รูป หรือกรอกตัวเลขในฟอร์มก่อน" });
    }

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
      userNote = `\n\nข้อมูลเพิ่มจาก user: ${body.audience.trim().slice(0, 500)}`;
    }

    const brief = buildScanBrief(product);
    content.push({
      type: "text",
      text: `${ANALYZE_PROMPT}\n${brief}${userNote}${images.length ? `\n\n(มีรูปแนบ ${images.length} รูป)` : "\n\n(ไม่มีรูปแนบ — วิเคราะห์จากตัวเลขฟอร์มเท่านั้น)"}`,
    });

    console.log("[sell-kit] analyze:", { email, model: ANTHROPIC_MODEL, images: images.length, hasFormData });

    const textOut = await callClaude(content, 4000);

    let kit;
    try {
      kit = JSON.parse(cleanJsonText(textOut));
    } catch (e) {
      console.error("[sell-kit analyze] parse error:", textOut.slice(0, 500));
      return res.status(502).json({ error: "parse_error", message: "AI ตอบไม่สมบูรณ์ — กดใหม่อีกครั้ง" });
    }

    if (!kit?.analysis || !Array.isArray(kit.angles) || !kit.angles.length) {
      return res.status(502).json({ error: "invalid_kit", message: "ผลลัพธ์ไม่ครบ — กดใหม่อีกครั้ง" });
    }

    // persist มุม+hook ลง tracker (best-effort)
    try {
      const product_key = String(kit.product_name || product?.name || "").trim().toLowerCase();
      // ห้าม persist ตอน AI ระบุสินค้าไม่ได้ (product_name จะเป็นประโยคอธิบายยาวๆ = ขยะใน tracker)
      const looksLikeRefusal = product_key.length > 60 || /ไม่สามารถ|ไม่มีรูป|ระบุไม่ได้/.test(product_key);
      if (product_key && !looksLikeRefusal) {
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
    if (DEBUG_SCANNER) response.debug = { model: ANTHROPIC_MODEL, raw: textOut.slice(0, 1500) };

    return res.status(200).json(response);
  } catch (err) {
    if (err && err.status) {
      console.error("[sell-kit] Claude error:", err.status, err.detail);
      return res.status(502).json({ error: "ai_error", message: `AI มีปัญหาชั่วคราว (${err.status}) — ลองใหม่อีกครั้ง` });
    }
    console.error("[sell-kit] server error:", err);
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
}
