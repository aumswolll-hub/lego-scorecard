// /api/auth.js — Request magic link (FREEMIUM: ใครก็ login ได้)
// POST { email } → ส่ง magic link ทุก email (ไม่ต้องซื้อก่อน)
//
// ใครก็ขอ link ได้ → track สิทธิ์ที่ usage.js แทน
// IMPORTANT: magic link ต้องใช้ production domain จริงเท่านั้น

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const DEFAULT_APP_URL = 'https://legoscanner.app';

function getAppUrl() {
  const raw = process.env.APP_URL || DEFAULT_APP_URL;

  return raw
    .trim()
    .replace(/\/+$/, '');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
      return res.status(400).json({ error: 'กรุณาใส่อีเมลที่ถูกต้อง' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Invalidate old unused tokens for this email
    // กันลูกค้ากดลิงก์เก่าใน Gmail แล้วเข้าไม่ได้
    const { error: invalidateErr } = await supabase
      .from('magic_tokens')
      .update({
        used: true,
        used_at: new Date().toISOString()
      })
      .eq('email', normalizedEmail)
      .eq('used', false);

    if (invalidateErr) {
      console.error('[auth] old token invalidate error:', {
        email: normalizedEmail,
        error: invalidateErr.message
      });

      return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }

    // 2. Generate new magic link token
    const token = crypto.randomBytes(32).toString('hex');

    // เปลี่ยนจาก 15 นาที → 60 นาที
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // 3. Store token
    const { error: tokenErr } = await supabase
      .from('magic_tokens')
      .insert({
        token,
        email: normalizedEmail,
        expires_at: expiresAt.toISOString(),
        used: false
      });

    if (tokenErr) {
      console.error('[auth] token insert error:', {
        email: normalizedEmail,
        error: tokenErr.message
      });

      return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }

    // 4. Build magic link
    const appUrl = getAppUrl();

    // คง path เดิมไว้ก่อน เพื่อไม่ให้ frontend พัง
    // ถ้าคุณมีหน้า /auth/callback แล้ว ค่อยเปลี่ยนเป็น:
    // const magicLink = `${appUrl}/auth/callback?token=${token}`;
    const magicLink = `${appUrl}/?token=${token}`;

    console.log('[auth] magic link generated:', {
      email: normalizedEmail,
      appUrl,
      host: req.headers.host,
      expiresAt: expiresAt.toISOString()
    });

    // 5. Send email via Resend
    const { error: sendErr } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'LEGO Scanner <noreply@legoscanner.me>',
      to: normalizedEmail,
      subject: 'เข้าสู่ระบบ LEGO Scanner',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; color: #0F0F0F;">
          <div style="background: #0F0F0F; color: #F5EFE6; padding: 8px 14px; display: inline-block; font-weight: 700; font-size: 11px; letter-spacing: 0.15em; margin-bottom: 24px;">LEGO SCANNER</div>

          <h1 style="font-size: 32px; line-height: 1.1; margin: 0 0 16px; letter-spacing: -0.02em;">
            เข้าสู่ระบบ<br>
            <span style="color: #C8312B; font-style: italic; font-weight: 500;">Scanner</span>
          </h1>

          <p style="color: #6B6B6B; font-size: 14px; line-height: 1.6; margin-bottom: 32px;">
            คลิกปุ่มด้านล่างเพื่อเข้าสู่ระบบ LEGO Scanner<br>
            ลิงก์นี้ใช้ได้ภายใน <strong>60 นาที</strong> และใช้ได้ <strong>ครั้งเดียว</strong><br>
            ถ้าขอลิงก์หลายครั้ง กรุณากดจากอีเมลล่าสุดเท่านั้น
          </p>

          <a href="${magicLink}" style="display: inline-block; background: #C8312B; color: #F5EFE6; padding: 14px 32px; text-decoration: none; font-weight: 600; font-size: 14px; letter-spacing: 0.1em; text-transform: uppercase;">
            เข้าสู่ระบบ →
          </a>

          <p style="color: #6B6B6B; font-size: 11px; margin-top: 32px; padding-top: 24px; border-top: 1px solid #D9D2C5; line-height: 1.6;">
            ถ้าปุ่มไม่ทำงาน copy ลิงก์นี้ไปวางใน browser:<br>
            <span style="word-break: break-all; color: #0F0F0F;">${magicLink}</span>
          </p>

          <p style="color: #6B6B6B; font-size: 11px; margin-top: 16px;">
            ถ้าคุณไม่ได้ขอเข้าสู่ระบบ ละเลย email นี้ได้
          </p>
        </div>
      `
    });

    if (sendErr) {
      console.error('[auth] email send error:', {
        email: normalizedEmail,
        error: sendErr.message
      });

      return res.status(500).json({ error: 'ส่งอีเมลไม่สำเร็จ' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[auth] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
}
