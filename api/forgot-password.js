// /api/forgot-password.js — Send password recovery link via Resend
// POST { email } → always { ok: true } (no email enumeration)
//
// WHY this exists:
// The frontend used to call sb.auth.resetPasswordForEmail() directly, which
// sends through Supabase's built-in SMTP — hard rate limit (~2-4/hour, whole
// project) and on newer projects it only delivers to team-member addresses.
// Customers never received the email while the UI said "sent".
//
// Flow:
// 1. Look up the Auth user.
//    - exists → generate a recovery link (admin.generateLink) and email it
//      through Resend (same channel as /api/auth.js magic links).
//    - does not exist BUT the email has access (legacy customers OR
//      user_entitlements) → create a confirmed Auth user with a random
//      password first, then send the recovery link. This is how legacy
//      Magic-Link customers set their first password.
//    - does not exist and no access → do nothing, still return ok.
// 2. Response is always { ok: true } so the endpoint can't be used to probe
//    which emails are registered.
//
// IMPORTANT: the redirect URL must be allowlisted in
// Supabase → Auth → URL Configuration → Redirect URLs.

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import crypto from "crypto";

import { resolveUserEntitlements } from "./_entitlements.mjs";

const resend = new Resend(process.env.RESEND_API_KEY);

const DEFAULT_APP_URL = "https://legoscanner.app";

function getAppUrl() {
  const raw = process.env.APP_URL || DEFAULT_APP_URL;
  return raw.trim().replace(/\/+$/, "");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return { client: null, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
  }

  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return { client, error: null };
}

async function findAuthUserByEmail(supabase, email) {
  const perPage = 100;
  let page = 1;

  while (page <= 30) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      console.error("[forgot-password] listUsers error:", error);
      throw new Error("list_users_failed");
    }

    const users = data?.users || [];
    const found = users.find((u) => String(u.email || "").toLowerCase() === email);

    if (found) return found;
    if (users.length < perPage) break;

    page++;
  }

  return null;
}

async function sendRecoveryEmail(email, recoveryLink) {
  const thaiTime = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  });

  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || "LEGO Scanner <noreply@legoscanner.me>",
    to: email,
    subject: `ตั้งรหัสผ่านใหม่ LEGO Scanner — ลิงก์ล่าสุด ${thaiTime}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; color: #0F0F0F;">
        <div style="background: #0F0F0F; color: #F5EFE6; padding: 8px 14px; display: inline-block; font-weight: 700; font-size: 11px; letter-spacing: 0.15em; margin-bottom: 24px;">
          LEGO SCANNER
        </div>

        <h1 style="font-size: 32px; line-height: 1.1; margin: 0 0 16px; letter-spacing: -0.02em;">
          ตั้งรหัสผ่านใหม่<br>
          <span style="color: #C8312B; font-style: italic; font-weight: 500;">Scanner</span>
        </h1>

        <p style="color: #6B6B6B; font-size: 14px; line-height: 1.6; margin-bottom: 32px;">
          คลิกปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่<br>
          ลิงก์นี้ใช้ได้ <strong>ครั้งเดียว</strong> และหมดอายุใน <strong>60 นาที</strong><br>
          ถ้าขอลิงก์หลายครั้ง กรุณากดจากอีเมลล่าสุดเท่านั้น
        </p>

        <a href="${recoveryLink}" style="display: inline-block; background: #C8312B; color: #F5EFE6; padding: 14px 32px; text-decoration: none; font-weight: 600; font-size: 14px; letter-spacing: 0.1em; text-transform: uppercase;">
          ตั้งรหัสผ่านใหม่ →
        </a>

        <p style="color: #6B6B6B; font-size: 11px; margin-top: 32px; padding-top: 24px; border-top: 1px solid #D9D2C5; line-height: 1.6;">
          ถ้าปุ่มไม่ทำงาน copy ลิงก์นี้ไปวางใน browser:<br>
          <span style="word-break: break-all; color: #0F0F0F;">${recoveryLink}</span>
        </p>

        <p style="color: #6B6B6B; font-size: 11px; margin-top: 16px;">
          ถ้าคุณไม่ได้ขอตั้งรหัสผ่านใหม่ ละเลย email นี้ได้
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`resend_send_failed: ${error.message || error}`);
  }
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { client: supabase, error: configError } = createSupabaseAdmin();

  if (!supabase) {
    console.error("[forgot-password] config error:", configError);
    return res.status(500).json({ error: "config_error" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const email = normalizeEmail(body.email);

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: "invalid_email",
        message: "กรุณากรอกอีเมลให้ถูกต้อง",
      });
    }

    let authUser = await findAuthUserByEmail(supabase, email);

    // Legacy Magic-Link customer without an Auth account: if the email has
    // access, create a confirmed user so the recovery link can set the first
    // password. No access + no account → silently succeed (no enumeration).
    if (!authUser) {
      const entitlement = await resolveUserEntitlements(email);

      if (!entitlement.has_scanner_access) {
        console.log("[forgot-password] no account + no access, skipping:", email);
        return res.status(200).json({ ok: true });
      }

      const { data: created, error: createError } =
        await supabase.auth.admin.createUser({
          email,
          password: crypto.randomBytes(24).toString("hex"),
          email_confirm: true,
          user_metadata: {
            source: "lego_scanner_forgot_password_bootstrap",
            plan: entitlement.effective_scanner_plan || "customer",
          },
        });

      if (createError || !created?.user) {
        console.error("[forgot-password] bootstrap create error:", createError);
        return res.status(500).json({
          error: "create_user_failed",
          message: "สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่",
        });
      }

      authUser = created.user;
    }

    const { data: linkData, error: linkError } =
      await supabase.auth.admin.generateLink({
        type: "recovery",
        email,
        options: {
          redirectTo: `${getAppUrl()}/reset-password.html`,
        },
      });

    const recoveryLink = linkData?.properties?.action_link;

    if (linkError || !recoveryLink) {
      console.error("[forgot-password] generateLink error:", linkError);
      return res.status(500).json({
        error: "link_failed",
        message: "สร้างลิงก์ไม่สำเร็จ กรุณาลองใหม่",
      });
    }

    await sendRecoveryEmail(email, recoveryLink);

    console.log("[forgot-password] recovery email sent:", {
      email,
      userId: authUser.id,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[forgot-password] error:", err);
    return res.status(500).json({
      error: "server_error",
      message: "ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    });
  }
}
