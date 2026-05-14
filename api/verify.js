// /api/verify.js — Verify magic link token
// GET ?token=xxx → returns { email, sessionToken, expiresAt }

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

    // 4. Verify email is still active in customers
    const { data: customer } = await supabase
      .from('customers')
      .select('active')
      .eq('email', row.email)
      .single();

    if (!customer || !customer.active) {
      return res.status(403).json({ error: 'บัญชีนี้ถูกระงับสิทธิ์' });
    }

    // 5. Mark token as used (atomic update)
    const { error: updateErr } = await supabase
      .from('magic_tokens')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', token)
      .eq('used', false);

    if (updateErr) {
      return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }

    // 6. Generate session token (30 days)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await supabase.from('sessions').insert({
      session_token: sessionToken,
      email: row.email,
      expires_at: sessionExpires.toISOString()
    });

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
