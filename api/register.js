// /api/register.js — Create or reset password for eligible LEGO customers
// POST { email, password }
//
// Flow:
// 1. Check public.customers first
// 2. If customer has access:
//    - if Auth user does not exist → create confirmed user
//    - if Auth user exists → update password directly
// 3. Frontend can login immediately with email + password
//
// This avoids email reset rate limit for legacy Magic Link customers.

import { createClient } from "@supabase/supabase-js";

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
    return {
      client: null,
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    };
  }

  try {
    const client = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    return { client, error: null };
  } catch (err) {
    return {
      client: null,
      error: String(err?.message || err),
    };
  }
}

async function findAuthUserByEmail(supabase, email) {
  const perPage = 100;
  let page = 1;

  while (page <= 30) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      console.error("[register] listUsers error:", error);
      throw new Error("list_users_failed");
    }

    const users = data?.users || [];

    const found = users.find(
      (u) => String(u.email || "").toLowerCase() === email
    );

    if (found) return found;

    if (users.length < perPage) break;

    page++;
  }

  return null;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "method_not_allowed",
      message: "Method not allowed",
    });
  }

  const { client: supabase, error: configError } = createSupabaseAdmin();

  if (!supabase) {
    console.error("[register] config error:", configError);

    return res.status(500).json({
      error: "config_error",
      message: configError,
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const email = normalizeEmail(body.email);
    const password = String(body.password || "");

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: "invalid_email",
        message: "กรุณากรอกอีเมลให้ถูกต้อง",
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        error: "invalid_password",
        message: "กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร",
      });
    }

    // 1) Check entitlement first
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select(
        "email, active, deactivated_at, plan, is_paid, has_method, monthly_scan_limit, legacy_unlimited"
      )
      .eq("email", email)
      .eq("active", true)
      .is("deactivated_at", null)
      .maybeSingle();

    if (customerError) {
      console.error("[register] customer query error:", customerError);

      return res.status(500).json({
        error: "db_error",
        message: "ตรวจสอบสิทธิ์ไม่สำเร็จ",
        detail: customerError.message || customerError,
      });
    }

    if (!customer) {
      return res.status(403).json({
        error: "no_access",
        message:
          "ยังไม่พบสิทธิ์ของอีเมลนี้ กรุณาใช้อีเมลเดียวกับที่ใช้ชำระเงิน หรือแจ้งทีมงานตรวจสอบ",
      });
    }

    // 2) Find auth user
    let existingUser = null;

    try {
      existingUser = await findAuthUserByEmail(supabase, email);
    } catch (err) {
      console.error("[register] find user failed:", err);

      return res.status(500).json({
        error: "auth_lookup_failed",
        message: "ตรวจสอบบัญชีผู้ใช้ไม่สำเร็จ กรุณาลองใหม่",
      });
    }

    // 3A) Existing Auth user → update password directly
    if (existingUser) {
      const { data: updated, error: updateError } =
        await supabase.auth.admin.updateUserById(existingUser.id, {
          password,
          email_confirm: true,
          user_metadata: {
            ...(existingUser.user_metadata || {}),
            source: "lego_scanner_register_password_update",
            plan: customer.plan || "customer",
            password_updated_at: new Date().toISOString(),
          },
        });

      if (updateError) {
        console.error("[register] update password error:", updateError);

        return res.status(500).json({
          error: "update_password_failed",
          message: "ตั้งรหัสผ่านไม่สำเร็จ กรุณาลองใหม่",
          detail: updateError.message || updateError,
        });
      }

      console.log("[register] updated password for existing auth user:", {
        email,
        userId: updated?.user?.id || existingUser.id,
        plan: customer.plan,
      });

      return res.status(200).json({
        ok: true,
        email,
        mode: "password_updated",
        message: "ตั้งรหัสผ่านสำเร็จ กำลังเข้าสู่ระบบ",
      });
    }

    // 3B) No Auth user → create confirmed user
    const { data: created, error: createError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          source: "lego_scanner_register_new_user",
          plan: customer.plan || "customer",
        },
      });

    if (createError) {
      console.error("[register] create auth user error:", createError);

      return res.status(500).json({
        error: "create_user_failed",
        message: "สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่",
        detail: createError.message || createError,
      });
    }

    console.log("[register] created auth user:", {
      email,
      userId: created?.user?.id,
      plan: customer.plan,
    });

    return res.status(200).json({
      ok: true,
      email,
      mode: "created",
      message: "สร้างบัญชีสำเร็จ กำลังเข้าสู่ระบบ",
    });
  } catch (err) {
    console.error("[register] server error:", err);

    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
}
