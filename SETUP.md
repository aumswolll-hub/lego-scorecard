# LEGO Scorecard — Setup Guide

Web app login ด้วย email ที่ใช้จ่ายเงินซื้อคอร์ส (Stripe + Vercel + Supabase + Resend)

---

## 📦 ไฟล์ในโปรเจ็กต์

```
webapp/
├── index.html              ← Frontend (ไม่ต้องแก้)
├── api/
│   ├── auth.js             ← ส่ง magic link
│   ├── verify.js           ← ตรวจสอบ magic link
│   └── stripe-webhook.js   ← รับ webhook จาก Stripe
├── package.json
├── vercel.json
└── SETUP.md (ไฟล์นี้)
```

---

## 🚀 Setup ทั้งหมด 6 ขั้นตอน (ใช้เวลา ~30-45 นาที)

### ขั้นตอน 1: สร้าง Supabase Database

1. ไป https://supabase.com → New Project (ชื่อ `lego-scorecard`)
2. รอสักครู่ให้สร้างเสร็จ
3. ไปที่ **SQL Editor** → New Query → paste SQL ด้านล่าง → Run:

```sql
-- ตาราง customers (เก็บ email ที่จ่ายเงินแล้ว)
CREATE TABLE customers (
  email TEXT PRIMARY KEY,
  active BOOLEAN DEFAULT true,
  stripe_event_id TEXT,
  last_payment_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ตาราง magic_tokens (เก็บ token ที่ส่งไป email)
CREATE TABLE magic_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ตาราง sessions (ระยะยาว 30 วัน)
CREATE TABLE sessions (
  session_token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- index เพื่อ query เร็ว
CREATE INDEX idx_magic_tokens_email ON magic_tokens(email);
CREATE INDEX idx_magic_tokens_expires ON magic_tokens(expires_at);
CREATE INDEX idx_sessions_email ON sessions(email);
```

4. ไปที่ **Settings → API** → copy:
   - **Project URL** (เริ่มต้นด้วย `https://...supabase.co`)
   - **Service Role Key** (ภายใต้ `service_role` — secret!)

📋 จดไว้:
- `SUPABASE_URL` = ...
- `SUPABASE_SERVICE_ROLE_KEY` = ...

---

### ขั้นตอน 2: สมัคร Resend (ส่ง email)

1. ไป https://resend.com → Sign up (ฟรี 3,000 emails/เดือน)
2. ไปที่ **API Keys** → Create API Key → copy
3. **สำคัญ:** ถ้าอยากใช้ domain ของตัวเอง:
   - ไปที่ **Domains** → Add Domain → ใส่ domain (เช่น `arngoon.com`)
   - เพิ่ม DNS records ตามที่ Resend บอก
   - เมื่อ verified แล้ว ใช้ email `noreply@arngoon.com` ได้

📋 จดไว้:
- `RESEND_API_KEY` = ...
- `EMAIL_FROM` = `LEGO Method <noreply@yourdomain.com>` (หรือใช้ `onboarding@resend.dev` ก่อนได้)

---

### ขั้นตอน 3: ตั้งค่า Stripe

1. ไป https://dashboard.stripe.com → **Developers → API keys**
2. Copy **Secret Key** (เริ่มต้นด้วย `sk_live_...` หรือ `sk_test_...`)

📋 จดไว้:
- `STRIPE_SECRET_KEY` = ...

(Webhook secret จะได้หลัง deploy แล้ว — รอขั้นตอน 5)

---

### ขั้นตอน 4: Deploy ขึ้น Vercel

**วิธีที่ 1: ผ่าน Vercel Dashboard (ง่ายสุด)**

1. Push code ขึ้น GitHub:
   ```bash
   cd webapp
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create lego-scorecard --private --push
   ```

2. ไป https://vercel.com → **Add New Project**
3. Import จาก GitHub → เลือก repo `lego-scorecard`
4. ที่หน้า **Configure Project** → **Environment Variables** → ใส่ทีละตัว:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | (จาก Supabase) |
   | `SUPABASE_SERVICE_ROLE_KEY` | (จาก Supabase) |
   | `RESEND_API_KEY` | (จาก Resend) |
   | `EMAIL_FROM` | `LEGO Method <noreply@yourdomain.com>` |
   | `STRIPE_SECRET_KEY` | (จาก Stripe) |
   | `STRIPE_WEBHOOK_SECRET` | (จะใส่หลังขั้นตอน 5) ใส่ placeholder ก่อนได้ |
   | `APP_URL` | (ใส่หลัง deploy แล้ว) |

5. กด **Deploy** → รอ 1-2 นาที
6. ได้ URL เช่น `https://lego-scorecard.vercel.app`

7. กลับไปที่ Vercel → Settings → Environment Variables → **เพิ่ม `APP_URL`** = URL ที่ได้

8. Redeploy (ที่ Deployments → ··· → Redeploy)

**วิธีที่ 2: ผ่าน CLI**

```bash
npm i -g vercel
cd webapp
vercel
# ตอบคำถาม → ระบบ deploy ให้
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
# ... ทุกตัวแปร
vercel --prod
```

---

### ขั้นตอน 5: ตั้งค่า Stripe Webhook

1. ไป Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. **Endpoint URL:** `https://YOUR_VERCEL_URL.vercel.app/api/stripe-webhook`
3. **Events to send:** เลือก:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `invoice.payment_succeeded`
   - `charge.refunded`
4. กด **Add endpoint**
5. ที่หน้า endpoint → **Signing secret** → กด Reveal → copy

6. กลับไป Vercel → Settings → Environment Variables → แก้ `STRIPE_WEBHOOK_SECRET` = ค่าที่ copy มา
7. Redeploy

---

### ขั้นตอน 6: ทดสอบ

**Test 1: เพิ่ม email manually ใน Supabase**

ก่อนที่ลูกค้าจะจ่ายเงิน เราต้องการทดสอบก่อน → ไปที่ Supabase:
- Table Editor → `customers` → Insert row
- email: `your-email@example.com`, active: `true`

แล้วเปิด `https://YOUR_VERCEL_URL.vercel.app` → ใส่ email → ดูว่า magic link มาที่ inbox มั้ย

**Test 2: ทดสอบ Stripe Webhook**

ใน Stripe Dashboard → Webhooks → endpoint ของคุณ → **Send test webhook**:
- Event: `checkout.session.completed`
- Send

ดูที่ Supabase → customers — ควรจะมี email ใหม่เพิ่มเข้ามาอัตโนมัติ

**Test 3: ทดสอบจริง**

จ่ายเงินผ่าน Payment Link ของ Stripe ด้วย email ใหม่ → check Supabase ว่ามี email เพิ่มมั้ย → ลอง login

---

## 🎯 สรุป Flow ทั้งหมด

```
1. ลูกค้าจ่ายเงินผ่าน Stripe Payment Link
   ↓
2. Stripe ส่ง webhook → /api/stripe-webhook
   ↓
3. Supabase เพิ่ม email เข้า table customers (active=true)
   ↓
4. ลูกค้าเข้า https://yourapp.vercel.app
   ↓
5. ใส่ email → กด "ส่งลิงก์เข้าใช้งาน"
   ↓
6. /api/auth ตรวจ Supabase → ถ้ามี → สร้าง token → ส่ง email
   ↓
7. ลูกค้ากด link ใน email → ไปที่ /?token=xxx
   ↓
8. /api/verify ตรวจ token → ส่ง session token กลับมา
   ↓
9. Frontend เก็บ session ใน localStorage (อายุ 30 วัน)
   ↓
10. ใช้ Scorecard ได้
```

---

## 🛠️ Admin tasks

**ดูว่ามีใครจ่ายเงินแล้วบ้าง:**
- Supabase → Table Editor → customers

**Ban user (เช่นกรณี refund manual):**
```sql
UPDATE customers SET active = false WHERE email = 'user@example.com';
```

**เพิ่ม email manually (เช่น คอมพ์):**
```sql
INSERT INTO customers (email, active) VALUES ('vip@example.com', true);
```

**ลบ tokens เก่า (cleanup):**
```sql
DELETE FROM magic_tokens WHERE expires_at < NOW() - INTERVAL '7 days';
DELETE FROM sessions WHERE expires_at < NOW();
```

แนะนำให้ตั้ง Supabase Cron Job หรือ Vercel Cron ทุก 24 ชั่วโมง

---

## ⚠️ ข้อควรระวัง

1. **ห้าม commit `.env` ขึ้น GitHub** — ใช้ Vercel Environment Variables เท่านั้น
2. **Service Role Key** มีสิทธิ์เต็มในการแก้ data — เก็บเป็นความลับ
3. **Stripe Webhook Secret** จะต่างกันระหว่าง test mode กับ live mode — ใส่ถูกตัว
4. **Resend free tier** ส่งได้ 3,000 emails/เดือน — ถ้าเกิน upgrade
5. **Magic link หมดอายุ 15 นาที** ใช้ครั้งเดียว — security

---

## 🆘 Troubleshooting

**"ไม่พบ email นี้ในระบบ" แม้จ่ายเงินแล้ว:**
- เช็ค Vercel Logs (Deployments → ··· → View Function Logs) — webhook ทำงานมั้ย
- เช็ค Stripe Webhook → Events → คลิกที่ event ดู response

**Email ไม่ถึง:**
- เช็ค Spam folder
- เช็ค Resend Dashboard → Emails → status delivered/bounced
- ถ้าใช้ `onboarding@resend.dev` → ส่งได้แค่ email ที่ verify เท่านั้น

**"ลิงก์หมดอายุ":**
- 15 นาทีเท่านั้น — ขอใหม่
- ถ้าใช้แล้วใช้ซ้ำ → ขอใหม่ (token ใช้ครั้งเดียว)

---

## 📊 ค่าใช้จ่าย (ฟรีเกือบทั้งหมด)

- **Vercel**: ฟรี (Hobby plan สำหรับ < 100k requests/เดือน)
- **Supabase**: ฟรี (500 MB DB)
- **Resend**: ฟรี (3,000 emails/เดือน)
- **Stripe**: ฟรี ค่า webhook = ค่าธรรมเนียมตามการขายปกติ

ถ้าธุรกิจโต → upgrade ทีละตัว ตามต้องการ
