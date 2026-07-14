// /api/digest-unsubscribe.js — one-click unsubscribe from the weekly digest.
// GET ?email=...&sig=... where sig = HMAC(email, CRON_SECRET) from digest-cron.
// Signed link → no auth needed, but nobody can unsubscribe someone else.

import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function sigFor(email) {
  return crypto
    .createHmac("sha256", CRON_SECRET || "no-secret")
    .update(String(email).trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

function page(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:-apple-system,'Segoe UI',sans-serif;background:#F5EFE6;color:#0F0F0F;display:grid;place-items:center;min-height:100vh;margin:0;">
    <div style="max-width:420px;padding:40px 24px;text-align:center;">
      <div style="background:#0F0F0F;color:#F5EFE6;padding:8px 14px;display:inline-block;font-weight:700;font-size:11px;letter-spacing:0.15em;margin-bottom:24px;">LEGO SCANNER</div>
      <h1 style="font-size:24px;margin:0 0 12px;">${title}</h1>
      <p style="color:#6B6B6B;font-size:14px;line-height:1.6;">${body}</p>
    </div>
  </body></html>`;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const email = String(req.query.email || "").trim().toLowerCase();
  const sig = String(req.query.sig || "");

  if (!email || !sig || !CRON_SECRET || sig !== sigFor(email)) {
    return res.status(400).send(page("ลิงก์ไม่ถูกต้อง", "ลิงก์ยกเลิกรับอีเมลไม่ถูกต้องหรือหมดอายุ"));
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scanner_email_prefs?on_conflict=email`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        email,
        digest_enabled: false,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!r.ok) throw new Error(`prefs upsert ${r.status}`);

    return res
      .status(200)
      .send(page("ยกเลิกเรียบร้อย", `${email} จะไม่ได้รับอีเมลสรุปรายสัปดาห์อีก<br>เปลี่ยนใจเมื่อไหร่ ทักทีมงานได้เลย`));
  } catch (err) {
    console.error("[digest-unsubscribe] error:", err);
    return res.status(500).send(page("เกิดข้อผิดพลาด", "ยกเลิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"));
  }
}
