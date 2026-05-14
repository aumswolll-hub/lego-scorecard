// /api/auth.js — Request magic link
// POST { email } → checks Supabase, sends magic link via Resend

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Check if email exists in customers table (added by Stripe webhook)
    const { data: customer, error: customerErr } = await supabase
      .from('customers')
      .select('email, active')
      .eq('email', normalizedEmail)
      .single();

    if (customerErr || !customer || !customer.active) {
      // Don't reveal whether email exists — return generic message
      // But for development, you can return specific error:
      return res.status(404).json({
        error: 'ไม่พบ email นี้ในระบบ — กรุณาใช้ email ที่ซื้อคอร์ส'
      });
    }

    // 2. Generate magic link token (random 32 bytes)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // 3. Store token in Supabase
    const { error: tokenErr } = await supabase
      .from('magic_tokens')
      .insert({
        token,
        email: normalizedEmail,
        expires_at: expiresAt.toISOString(),
        used: false
      });

    if (tokenErr) {
      console.error('Token insert error:', tokenErr);
      return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }

    // 4. Build magic link
    const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const magicLink = `${appUrl}/?token=${token}`;

    // 5. Send email via Resend
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'LEGO Method <onboarding@resend.dev>',
      to: normalizedEmail,
      subject: 'เข้าสู่ระบบ LEGO Scorecard',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; color: #0F0F0F;">
          <div style="background: #0F0F0F; color: #F5EFE6; padding: 8px 14px; display: inline-block; font-weight: 700; font-size: 11px; letter-spacing: 0.15em; margin-bottom: 24px;">LEGO METHOD™</div>
          <h1 style="font-size: 32px; line-height: 1.1; margin: 0 0 16px; letter-spacing: -0.02em;">
            เข้าสู่ระบบ<br>
            <span style="color: #C8312B; font-style: italic; font-weight: 500;">Scorecard</span>
          </h1>
          <p style="color: #6B6B6B; font-size: 14px; line-height: 1.6; margin-bottom: 32px;">
            คลิกปุ่มด้านล่างเพื่อเข้าสู่ระบบ LEGO Scorecard<br>
            ลิงก์นี้ใช้ได้ภายใน <strong>15 นาที</strong> และใช้ได้ <strong>ครั้งเดียว</strong>
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

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
}
