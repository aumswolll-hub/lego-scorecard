// /api/digest-cron.js — Watchtower v1: weekly Thai digest email
//
// Vercel Cron hits this (see vercel.json "crons") with
// Authorization: Bearer ${CRON_SECRET}. Manual trigger with the same header
// works too. Never callable without the secret.
//
// Per active user (scanned in the last 60 days, not opted out):
//   1. stale products (>14 days old) → "รอเช็คใหม่ X ตัว"
//   2. top fresh winners (VALIDATED/PICK) → "ควรลงมือ"
//   3. real hit-rate from outcomes (user_product_tracker)
// One email via Resend, with an HMAC-signed unsubscribe link.
//
// Design constraints:
// - Batched + capped per run (DIGEST_MAX_SEND, default 200) — Resend safety.
// - All reads are service-role; nothing here trusts client input.

import { Resend } from "resend";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const MAX_SEND = parseInt(process.env.DIGEST_MAX_SEND || "200", 10);
const STALE_DAYS = 14;
const ACTIVE_WINDOW_DAYS = 60;

const resend = new Resend(process.env.RESEND_API_KEY);

const DEFAULT_APP_URL = "https://legoscanner.app";

function appUrl() {
  return (process.env.APP_URL || DEFAULT_APP_URL).trim().replace(/\/+$/, "");
}

function sb(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

export function unsubscribeSig(email) {
  return crypto
    .createHmac("sha256", CRON_SECRET || "no-secret")
    .update(String(email).trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

function daysAgo(iso) {
  return Math.floor((Date.now() - new Date(iso || 0).getTime()) / 86400000);
}

// Group scans → per-user portfolio summary
function buildPortfolios(scans) {
  const users = new Map();

  for (const s of scans) {
    const email = String(s.user_email || "").toLowerCase();
    if (!email) continue;

    let u = users.get(email);
    if (!u) {
      u = { email, products: new Map(), totalScans: 0 };
      users.set(email, u);
    }
    u.totalScans++;

    const key = String(s.product_name || "").trim().toLowerCase();
    if (!key) continue;

    const prev = u.products.get(key);
    if (!prev || new Date(s.created_at) > new Date(prev.created_at)) {
      u.products.set(key, s);
    }
  }

  return users;
}

function summarize(u, trackerRows) {
  const products = [...u.products.values()];
  const stale = products.filter((p) => daysAgo(p.created_at) >= STALE_DAYS);
  const freshWinners = products
    .filter(
      (p) =>
        daysAgo(p.created_at) < STALE_DAYS &&
        (p.decision === "VALIDATED" || p.decision === "PICK")
    )
    .sort((a, b) => Number(b.score_pct || 0) - Number(a.score_pct || 0))
    .slice(0, 3);

  const mine = trackerRows.filter(
    (t) => String(t.user_email || "").toLowerCase() === u.email
  );
  const withOutcome = mine.filter(
    (t) => t.user_status === "Got Order" || t.user_status === "No Order"
  );
  const wins = withOutcome.filter((t) => t.user_status === "Got Order").length;

  return {
    productCount: u.products.size,
    staleCount: stale.length,
    staleTop: stale
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(0, 3),
    freshWinners,
    outcomes: withOutcome.length,
    wins,
  };
}

function emailHtml(email, s) {
  const base = appUrl();
  const unsub = `${base}/api/digest-unsubscribe?email=${encodeURIComponent(email)}&sig=${unsubscribeSig(email)}`;

  const staleBlock = s.staleCount
    ? `<div style="border:1.5px solid #C49A4A; background:#FBF4E4; padding:14px 16px; margin:0 0 16px;">
        🕐 <strong>${s.staleCount} สินค้า</strong>ข้อมูลเก่าเกิน ${STALE_DAYS} วัน — ตัวเลข TikTok เป็นรอบ 7/30 วัน คะแนนเดิมอาจไม่จริงแล้ว<br>
        <span style="color:#6B6B6B; font-size:12px;">${s.staleTop.map((p) => `• ${p.product_name} (${daysAgo(p.created_at)} วัน)`).join("<br>")}</span>
      </div>`
    : "";

  const winnersBlock = s.freshWinners.length
    ? `<p style="margin:0 0 6px; font-weight:700;">✅ ควรลงมือสัปดาห์นี้:</p>
       <p style="margin:0 0 16px; color:#333;">${s.freshWinners.map((p, i) => `${i + 1}. ${p.product_name} — ${Math.round(Number(p.score_pct || 0) * 100)}%`).join("<br>")}</p>`
    : "";

  const accuracyBlock = s.outcomes >= 3
    ? `<p style="margin:0 0 16px;">💰 จาก <strong>${s.outcomes}</strong> ตัวที่คุณบันทึกผล — ขายได้จริง <strong>${s.wins}</strong> ตัว</p>`
    : `<p style="margin:0 0 16px; color:#6B6B6B; font-size:13px;">ทิป: กดสินค้าใน Tracker แล้วบันทึก “ขายได้/ยังไม่ขาย” — ระบบจะโชว์ความแม่นจริงของคุณ</p>`;

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:480px; margin:0 auto; padding:36px 20px; color:#0F0F0F;">
      <div style="background:#0F0F0F; color:#F5EFE6; padding:8px 14px; display:inline-block; font-weight:700; font-size:11px; letter-spacing:0.15em; margin-bottom:20px;">LEGO SCANNER — WEEKLY</div>
      <h1 style="font-size:26px; line-height:1.15; margin:0 0 18px;">พอร์ตสินค้าของคุณสัปดาห์นี้</h1>
      <p style="margin:0 0 16px; color:#333;">คุณมีสินค้าในระบบ <strong>${s.productCount}</strong> ตัว</p>
      ${staleBlock}
      ${winnersBlock}
      ${accuracyBlock}
      <a href="${base}/?utm_source=digest" style="display:inline-block; background:#C8312B; color:#F5EFE6; padding:13px 28px; text-decoration:none; font-weight:600; font-size:13px; letter-spacing:0.08em;">เปิด SCANNER →</a>
      <p style="color:#6B6B6B; font-size:11px; margin-top:32px; padding-top:20px; border-top:1px solid #D9D2C5;">
        อีเมลนี้ส่งสัปดาห์ละครั้งถึงผู้ใช้ LEGO Scanner ที่มีสินค้าในระบบ ·
        <a href="${unsub}" style="color:#6B6B6B;">ยกเลิกรับอีเมลนี้</a>
      </p>
    </div>`;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (!CRON_SECRET) {
    return res.status(500).json({ error: "missing_cron_secret" });
  }

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "config_error" });
  }

  try {
    const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400000).toISOString();

    const [scansRes, trackerRes, prefsRes] = await Promise.all([
      sb(
        `product_scans?created_at=gte.${encodeURIComponent(since)}` +
          `&select=user_email,product_name,decision,score_pct,created_at` +
          `&order=created_at.desc&limit=5000`
      ),
      sb(`user_product_tracker?select=user_email,user_status`),
      sb(`scanner_email_prefs?digest_enabled=eq.false&select=email`),
    ]);

    if (!scansRes.ok) throw new Error(`scans query ${scansRes.status}`);

    const scans = await scansRes.json();
    const trackerRows = trackerRes.ok ? await trackerRes.json() : [];
    const optedOut = new Set(
      (prefsRes.ok ? await prefsRes.json() : []).map((r) => String(r.email).toLowerCase())
    );

    const users = buildPortfolios(scans);

    // ทดสอบปลอดภัย: ?dry=1 = คำนวณครบแต่ไม่ส่งจริง / ?only=email = ส่งหาคนเดียว
    const dryRun = String(req.query?.dry || "") === "1";
    const onlyEmail = String(req.query?.only || "").trim().toLowerCase();

    let sent = 0, skipped = 0, failed = 0;
    const preview = [];

    for (const [email, u] of users) {
      if (sent >= MAX_SEND) break;
      if (onlyEmail && email !== onlyEmail) { skipped++; continue; }
      if (optedOut.has(email)) { skipped++; continue; }

      const s = summarize(u, trackerRows);

      // ไม่มีอะไรน่าบอก (ของใหม่หมด, ไม่มี winner, พอร์ตเล็กมาก) → ข้าม
      if (s.staleCount === 0 && s.freshWinners.length === 0 && s.productCount < 2) {
        skipped++;
        continue;
      }

      if (dryRun) {
        preview.push({ email, stale: s.staleCount, winners: s.freshWinners.length, products: s.productCount, outcomes: s.outcomes });
        sent++;
        continue;
      }

      try {
        const { error } = await resend.emails.send({
          from: process.env.EMAIL_FROM || "LEGO Scanner <noreply@legoscanner.me>",
          to: email,
          subject: s.staleCount
            ? `🕐 ${s.staleCount} สินค้าของคุณรอเช็คใหม่ — LEGO Scanner Weekly`
            : `พอร์ตสินค้าของคุณสัปดาห์นี้ — LEGO Scanner Weekly`,
          html: emailHtml(email, s),
        });
        if (error) throw new Error(error.message || "send_failed");
        sent++;
      } catch (err) {
        failed++;
        console.error("[digest] send failed:", email, String(err?.message || err));
      }
    }

    console.log("[digest] run complete:", { users: users.size, sent, skipped, failed, dryRun });

    return res.status(200).json({
      ok: true, users: users.size, sent, skipped, failed,
      ...(dryRun ? { dry_run: true, preview: preview.slice(0, 30) } : {}),
    });
  } catch (err) {
    console.error("[digest] error:", err);
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
}
