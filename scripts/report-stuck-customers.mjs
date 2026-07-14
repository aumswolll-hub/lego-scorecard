// scripts/report-stuck-customers.mjs — Who was locked out by the old gates?
//
// Lists every ACTIVE user_entitlements row whose email has NO active row in
// the legacy customers table. Before the gate fix, these buyers paid but got
// 403 "ยังไม่พบสิทธิ์" everywhere (register / scans / tracker / autofill).
// After deploying the fix they work automatically — use this list to message
// them that access is restored.
//
// Read-only. Run locally:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/report-stuck-customers.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

async function sbRest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const now = new Date();

const entitlements = await sbRest(
  "user_entitlements?status=eq.active" +
    "&select=email,entitlement_type,plan_code,source,starts_at,ends_at,stripe_payment_intent_id"
);

const active = entitlements.filter(
  (e) => e.email && (!e.ends_at || new Date(e.ends_at) > now)
);

const emails = [...new Set(active.map((e) => e.email.toLowerCase()))];

if (!emails.length) {
  console.log("No active user_entitlements rows found. Nothing was stuck.");
  process.exit(0);
}

// Fetch matching active customers rows in chunks (URL length safety).
const inCustomers = new Set();
for (let i = 0; i < emails.length; i += 50) {
  const chunk = emails.slice(i, i + 50);
  const rows = await sbRest(
    `customers?email=in.(${chunk.map(encodeURIComponent).join(",")})` +
      "&active=eq.true&deactivated_at=is.null&select=email"
  );
  for (const r of rows) inCustomers.add(String(r.email).toLowerCase());
}

const stuck = active.filter((e) => !inCustomers.has(e.email.toLowerCase()));

console.log(`Active entitlement rows : ${active.length}`);
console.log(`Unique emails           : ${emails.length}`);
console.log(`Also in customers (ok)  : ${emails.filter((e) => inCustomers.has(e)).length}`);
console.log(`STUCK (entitlement only): ${new Set(stuck.map((e) => e.email)).size} emails\n`);

if (!stuck.length) {
  console.log("Nobody was locked out. 🎉");
  process.exit(0);
}

console.log("email | plan_code | type | starts_at | ends_at | payment_intent");
console.log("-".repeat(100));
for (const e of stuck) {
  console.log(
    [
      e.email,
      e.plan_code || "-",
      e.entitlement_type || "-",
      (e.starts_at || "").slice(0, 10),
      (e.ends_at || "open-ended").slice(0, 10),
      e.stripe_payment_intent_id || "-",
    ].join(" | ")
  );
}
