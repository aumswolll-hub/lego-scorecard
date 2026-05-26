// /api/verify.js — Verify magic link token (FREEMIUM)
// GET ?token=xxx → returns { email, sessionToken, expiresAt }
//
// เปลี่ยนจากเดิม: เดิมบล็อกคนที่ customers.active != true
// ตอนนี้: ใครยืนยัน token ได้ = login ได้ → สิทธิ์เช็คที่ usage.js

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    // 1. Look up token
    const { data: row, error } = await supabase
      .from('magic_tokens')
      .select('email, expires_at, used')
      .eq('token', token)
      .single();

    if (error || !row) {
      return res.status(404).json({ error: 'ลิงก์ไม่ถูกต้อง' });
    }

    // 2. Check expiration
    if (new Date(row.expires_at) < new Date()) {
      return res.status(410).json({ error: 'ลิงก์หมดอายุ — กรุณาขอใหม่' });
    }

    // 3. Check already used
    if (row.used) {
      return res.status(410).json({ error: 'ลิงก์ถูกใช้ไปแล้ว — กรุณาขอใหม่' });
    }

    // ── FREEMIUM: ไม่เช็ค customers.active แล้ว — ใครยืนยัน token ได้ = login ได้ ──
    // (เดิมตรงนี้บล็อกคนที่ไม่ active — ลบออกแล้ว)

    // 4. Mark token as used (atomic)
    const { error: updateErr } = await supabase
      .from('magic_tokens')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', token)
      .eq('used', false);

    if (updateErr) {
      return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }

    // 5. Generate session token (30 days)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await supabase.from('sessions').insert({
      session_token: sessionToken,
      email: row.email,
      expires_at: sessionExpires.toISOString()
    });

    // 6. Ensure usage row exists (สร้าง row freemium ให้คนใหม่)
    await supabase
      .from('scanner_user_usage')
      .upsert(
        { email: row.email, scans_used: 0, free_scan_limit: 3, is_paid: false, plan: 'free' },
        { onConflict: 'email', ignoreDuplicates: true }
      );

    return res.status(200).json({
      email: row.email,
      sessionToken,
      expiresAt: sessionExpires.toISOString()
    });
  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
}
