// /api/verify.js — Verify magic link token (FREEMIUM)
// GET ?token=xxx → returns { email, sessionToken, expiresAt }
//
// Logic:
// 1. Verify token
// 2. Create session first
// 3. Ensure usage row exists
// 4. Mark magic token as used only after session is created successfully
//
// สำคัญ:
// - ห้าม mark token used ก่อนสร้าง session สำเร็จ
// - เพิ่ม log reason เพื่อ debug 410 ได้ชัด

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
      console.log('[verify failed]', {
        reason: 'token_missing'
      });

      return res.status(400).json({ error: 'Token required' });
    }

    // 1. Look up token
    const { data: row, error } = await supabase
      .from('magic_tokens')
      .select('email, expires_at, used, used_at')
      .eq('token', token)
      .single();

    if (error || !row) {
      console.log('[verify failed]', {
        reason: 'token_not_found',
        tokenPreview: String(token).slice(0, 12),
        supabaseError: error?.message || null
      });

      return res.status(404).json({
        error: 'ลิงก์ไม่ถูกต้อง กรุณาขอลิงก์ใหม่'
      });
    }

    // 2. Check expiration
    const now = new Date();
    const expiresAt = new Date(row.expires_at);

    if (expiresAt < now) {
      console.log('[verify failed]', {
        reason: 'token_expired',
        email: row.email,
        expiresAt: row.expires_at,
        now: now.toISOString()
      });

      return res.status(410).json({
        error: 'ลิงก์หมดอายุ — กรุณาขอใหม่'
      });
    }

    // 3. Check already used
    if (row.used) {
      console.log('[verify failed]', {
        reason: 'token_already_used',
        email: row.email,
        usedAt: row.used_at || null
      });

      return res.status(410).json({
        error: 'ลิงก์ถูกใช้ไปแล้ว — กรุณาขอใหม่'
      });
    }

    // 4. Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // 5. Insert session first
    const { error: sessionErr } = await supabase
      .from('sessions')
      .insert({
        session_token: sessionToken,
        email: row.email,
        expires_at: sessionExpires.toISOString()
      });

    if (sessionErr) {
      console.error('[verify failed]', {
        reason: 'session_insert_failed',
        email: row.email,
        error: sessionErr.message
      });

      return res.status(500).json({
        error: 'สร้าง session ไม่สำเร็จ กรุณาลองใหม่'
      });
    }

    // 6. Ensure usage row exists
    const { error: usageErr } = await supabase
      .from('scanner_user_usage')
      .upsert(
        {
          email: row.email,
          scans_used: 0,
          free_scan_limit: 3,
          is_paid: false,
          plan: 'free'
        },
        {
          onConflict: 'email',
          ignoreDuplicates: true
        }
      );

    if (usageErr) {
      console.error('[verify failed]', {
        reason: 'usage_upsert_failed',
        email: row.email,
        error: usageErr.message
      });

      return res.status(500).json({
        error: 'เตรียมสิทธิ์ใช้งานไม่สำเร็จ กรุณาลองใหม่'
      });
    }

    // 7. Mark token as used only AFTER session + usage succeeded
    const { data: updatedToken, error: updateErr } = await supabase
      .from('magic_tokens')
      .update({
        used: true,
        used_at: new Date().toISOString()
      })
      .eq('token', token)
      .eq('used', false)
      .select('email')
      .single();

    if (updateErr || !updatedToken) {
      console.error('[verify failed]', {
        reason: 'token_mark_used_failed_or_race_condition',
        email: row.email,
        error: updateErr?.message || null
      });

      return res.status(410).json({
        error: 'ลิงก์นี้ถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่'
      });
    }

    console.log('[verify success]', {
      email: row.email,
      sessionExpires: sessionExpires.toISOString()
    });

    return res.status(200).json({
      email: row.email,
      sessionToken,
      expiresAt: sessionExpires.toISOString()
    });
  } catch (err) {
    console.error('[verify error]', err);

    return res.status(500).json({
      error: 'เกิดข้อผิดพลาด'
    });
  }
}
