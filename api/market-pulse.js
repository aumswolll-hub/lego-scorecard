// /api/market-pulse.js — Collective intel: "ตลาดรอบ 14 วัน" จากสแกนรวมทุกคน
//
// สิ่งที่ generic AI ไม่มีทางมี: ข้อมูลว่านักเรียนไทยทั้งระบบกำลังสแกนอะไร
// หมวดไหนผ่านเกณฑ์บ่อย หมวดไหนคะแนนร่วง — คำนวณสัปดาห์ละครั้ง (cache ใน
// market_pulse_cache) เพราะจัดหมวดชื่อสินค้าด้วย Claude มีต้นทุน
//
// ความเป็นส่วนตัว: ตอบเฉพาะระดับหมวด + ตัวเลขรวม — ไม่มีชื่อสินค้า/อีเมล
// ของใครหลุดให้คนอื่นเห็นเด็ดขาด

import { resolveSessionIdentity, getSessionToken, sbRest, configMissing } from "./_auth-helpers.js";

// การจัดหมวดกิน AI เวลานาน — เผื่อเวลา function ให้พอ (default 10s ไม่พอ)
export const config = { maxDuration: 60 };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// จัดหมวด = งานง่าย ใช้ Haiku เร็ว/ถูก ไม่ต้องใช้โมเดลใหญ่
const CLASSIFY_MODEL = process.env.PULSE_CLASSIFY_MODEL || "claude-haiku-4-5-20251001";
const WINDOW_DAYS = 14;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // recompute อย่างมากวันละครั้ง
const MIN_CATEGORY_SCANS = 8; // หมวดต้องมีสแกนพอ ก่อนประกาศร้อน/เย็น

const CATEGORIES = [
  "บิวตี้/สกินแคร์", "แฟชั่น/เสื้อผ้า", "ของใช้ในบ้าน", "แม่และเด็ก",
  "อาหาร/เครื่องดื่ม", "สุขภาพ/อาหารเสริม", "อิเล็กทรอนิกส์/แกดเจ็ต",
  "สัตว์เลี้ยง", "เครื่องมือ/DIY", "อื่นๆ",
];

function weekKey() {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function classifyNames(names) {
  // ตอบเป็น array ของ index หมวด (ตามลำดับ input) — output สั้นมาก
  // ไม่มีทางโดน max_tokens ตัด และไม่ต้อง match ชื่อไทยยาวๆ เป็น key
  const catList = CATEGORIES.map((c, i) => `${i}=${c}`).join(", ");
  const nameList = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const prompt = `หมวดสินค้า: ${catList}
จัดหมวดสินค้า TikTok Shop ทีละรายการ ตอบเป็น JSON array ของตัวเลข index หมวดเท่านั้น ยาวเท่าจำนวนรายการ (${names.length} ตัว) เช่น [0,3,1,...]:
${nameList}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`classify ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")
    .replace(/```json/gi, "").replace(/```/g, "").trim();
  const indexes = JSON.parse(text);
  if (!Array.isArray(indexes)) throw new Error("classify: not an array");

  const map = {};
  names.forEach((n, i) => {
    const idx = Number(indexes[i]);
    if (Number.isInteger(idx) && idx >= 0 && idx < CATEGORIES.length) {
      map[n] = CATEGORIES[idx];
    }
  });
  return map;
}

async function computePulse() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

  const res = await sbRest(
    `product_scans?created_at=gte.${encodeURIComponent(since)}` +
      `&select=user_email,product_name,decision,score_pct,commission_rate` +
      `&order=created_at.desc&limit=5000`
  );
  if (!res.ok) throw new Error(`scans ${res.status}`);
  const scans = await res.json();

  const uniqUsers = new Set(scans.map((s) => s.user_email)).size;
  const positive = scans.filter((s) => s.decision === "VALIDATED" || s.decision === "PICK").length;

  // จัดหมวดชื่อสินค้า (unique, top 150 ตามความถี่) ครั้งเดียวต่อ compute
  const nameCount = new Map();
  for (const s of scans) {
    const n = String(s.product_name || "").trim();
    if (!n) continue;
    nameCount.set(n, (nameCount.get(n) || 0) + 1);
  }
  const topNames = [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([n]) => n);

  let nameToCat = {};
  if (topNames.length >= 10) {
    try { nameToCat = await classifyNames(topNames); } catch (e) {
      console.warn("[market-pulse] classify failed:", e?.message || e);
    }
  }

  const catStats = {};
  for (const s of scans) {
    const cat = nameToCat[String(s.product_name || "").trim()];
    if (!cat) continue;
    catStats[cat] = catStats[cat] || { scans: 0, positive: 0 };
    catStats[cat].scans++;
    if (s.decision === "VALIDATED" || s.decision === "PICK") catStats[cat].positive++;
  }

  const eligible = Object.entries(catStats)
    .filter(([c, v]) => v.scans >= MIN_CATEGORY_SCANS && c !== "อื่นๆ")
    .map(([c, v]) => ({ category: c, scans: v.scans, pick_rate: Math.round((v.positive / v.scans) * 100) }))
    .sort((a, b) => b.pick_rate - a.pick_rate);

  return {
    window_days: WINDOW_DAYS,
    total_scans: scans.length,
    uniq_users: uniqUsers,
    pick_rate: scans.length ? Math.round((positive / scans.length) * 100) : 0,
    hot: eligible[0] || null,
    cold: eligible.length > 1 ? eligible[eligible.length - 1] : null,
    categories: eligible,
    computed_at: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  if (configMissing()) return res.status(500).json({ error: "config_error" });

  const identity = await resolveSessionIdentity(getSessionToken(req));
  if (!identity) return res.status(401).json({ error: "unauthorized" });

  try {
    const wk = weekKey();

    const cacheRes = await sbRest(`market_pulse_cache?week_key=eq.${encodeURIComponent(wk)}&select=payload,updated_at`);
    if (cacheRes.ok) {
      const rows = await cacheRes.json();
      if (rows.length && Date.now() - new Date(rows[0].updated_at).getTime() < CACHE_MAX_AGE_MS) {
        return res.status(200).json({ ok: true, cached: true, pulse: rows[0].payload });
      }
    }

    const pulse = await computePulse();

    await sbRest(`market_pulse_cache?on_conflict=week_key`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ week_key: wk, payload: pulse, updated_at: new Date().toISOString() }),
    }).catch(() => {});

    return res.status(200).json({ ok: true, cached: false, pulse });
  } catch (err) {
    console.error("[market-pulse] error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}
