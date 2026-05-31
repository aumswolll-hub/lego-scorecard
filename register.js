// /api/register.js — Create password login for existing eligible customers
// Used for old Magic Link customers who need to create password account
//
// POST { email, password }
// Checks public.customers first.
// If customer has access, creates Supabase Auth user with email_confirm = true.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function findAuthUserByEmail(email) {
  // Supabase Admin API has no direct getUserByEmail in all versions,
  // so we search pages safely.
  const perPage = 1000;
  let page = 1;

  while (page <= 10) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      console.error("[register] listUsers error:", error);
      return null;
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

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "config_error",
      message: "Missing Supabase env",
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

    // 1) Check entitlement in customers first
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
      });
    }

    if (!customer) {
      return res.status(403).json({
        error: "no_access",
        message:
          "ยังไม่พบสิทธิ์ของอีเมลนี้ กรุณาใช้อีเมลเดียวกับที่ใช้ชำระเงิน หรือแจ้งทีมงานตรวจสอบ",
      });
    }

    // 2) If auth user already exists, do not overwrite password here.
    // Tell customer to login or reset password.
    const existingUser = await findAuthUserByEmail(email);

    if (existingUser) {
      return res.status(409).json({
        error: "already_exists",
        message:
          "อีเมลนี้มีบัญชีแล้ว กรุณากดเข้าสู่ระบบ หรือกดลืมรหัสผ่าน / ตั้งรหัสผ่านใหม่",
      });
    }

    // 3) Create confirmed auth user
    const { data: created, error: createError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          source: "lego_scanner_register",
          plan: customer.plan || "customer",
        },
      });

    if (createError) {
      console.error("[register] create auth user error:", createError);

      const msg = String(createError.message || "").toLowerCase();

      if (
        msg.includes("already") ||
        msg.includes("registered") ||
        msg.includes("exists")
      ) {
        return res.status(409).json({
          error: "already_exists",
          message:
            "อีเมลนี้มีบัญชีแล้ว กรุณากดเข้าสู่ระบบ หรือกดลืมรหัสผ่าน / ตั้งรหัสผ่านใหม่",
        });
      }

      return res.status(500).json({
        error: "create_user_failed",
        message: "สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่",
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
      message: "สร้างบัญชีสำเร็จ กรุณาเข้าสู่ระบบ",
    });
  } catch (err) {
    console.error("[register] server error:", err);

    return res.status(500).json({
      error: "server_error",
      message: String(err),
    });
  }
}
