const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");
const backupPath = path.join(process.cwd(), "index.backup-before-login-hero-patch.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html — ให้รันใน root project");
}

let html = fs.readFileSync(filePath, "utf8");

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("✅ backup created:", backupPath);
}

function replaceOnce(label, search, replacement) {
  if (!html.includes(search)) {
    console.warn(`⚠️ ไม่เจอ block: ${label} — ข้าม`);
    return;
  }
  html = html.replace(search, replacement);
  console.log("✅ patched:", label);
}

// 1) Upgrade login screen copy
replaceOnce(
  "login headline",
`<h1 class="serif">Product<br><em>Scorecard</em></h1>
    <p class="sub">ใส่ email ที่ใช้ซื้อคอร์ส — ระบบจะส่งลิงก์เข้าใช้งานไปทาง email</p>`,
`<h1 class="serif">ตรวจสินค้า<br><em>ก่อนทำคลิป</em></h1>
    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยบอกว่าสินค้านี้ควร TEST / RISKY / DROP — ทดลองใช้ฟรี 3 scans</p>`
);

// 2) Change email label
replaceOnce(
  "email label",
`<label class="field-label">Email</label>`,
`<label class="field-label">Email เพื่อรับลิงก์เข้าใช้งาน</label>`
);

// 3) Change login button
replaceOnce(
  "login button text",
`<button class="login-btn" id="loginBtn" onclick="requestMagicLink()">ส่งลิงก์เข้าใช้งาน</button>`,
`<button class="login-btn" id="loginBtn" onclick="requestMagicLink()">ลองสแกนฟรี 3 ครั้ง</button>`
);

// 4) Change hint copy
replaceOnce(
  "login hint",
`<p class="hint">ระบบจะตรวจสอบกับ Stripe ว่า email นี้ซื้อคอร์สแล้วหรือยัง<br>หากซื้อแล้ว — ลิงก์จะถูกส่งไปที่ email ภายใน 1 นาที</p>`,
`<p class="hint"><strong>ใช้ฟรี 3 scans</strong> · ไม่ต้องผูกบัตร · ใช้ข้อมูลจริงจาก TikTok Shop<br>ถ้าคุณซื้อ Scanner หรือ LEGO METHOD แล้ว ระบบจะปลดล็อกสิทธิ์ตามแผนให้อัตโนมัติ</p>`
);

// 5) Change login button loading reset text in JS
replaceOnce(
  "login button reset text",
`finally { btn.disabled = false; btn.textContent = "ส่งลิงก์เข้าใช้งาน"; }`,
`finally { btn.disabled = false; btn.textContent = "ลองสแกนฟรี 3 ครั้ง"; }`
);

// 6) Add conversion blocks inside login card before hint
replaceOnce(
  "insert login value stack",
`    <button class="login-btn" id="loginBtn" onclick="requestMagicLink()">ลองสแกนฟรี 3 ครั้ง</button>
    <p class="hint">`,
`    <button class="login-btn" id="loginBtn" onclick="requestMagicLink()">ลองสแกนฟรี 3 ครั้ง</button>

    <div class="login-proof">
      <div class="proof-row">
        <span class="proof-k">SCANNER</span>
        <span class="proof-v">บอกว่าสินค้าน่าเล่นไหม</span>
      </div>
      <div class="proof-row">
        <span class="proof-k">METHOD</span>
        <span class="proof-v">สอนว่าหลังจากเจอสินค้าแล้ว ทำคลิปยังไงให้ขาย</span>
      </div>
    </div>

    <div class="login-steps">
      <div><strong>1</strong><span>ใส่ email</span></div>
      <div><strong>2</strong><span>อัปโหลดรูปสินค้า</span></div>
      <div><strong>3</strong><span>รู้เลยว่าควร TEST / RISKY / DROP</span></div>
    </div>

    <p class="hint">`
);

// 7) Add CSS for new blocks
replaceOnce(
  "login css insert",
`.login-card .hint { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--grey-line); font-size: 11px; color: var(--ink-mute); line-height: 1.6; }`,
`.login-card .hint { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--grey-line); font-size: 11px; color: var(--ink-mute); line-height: 1.6; }

.login-proof {
  margin-top: 24px;
  background: var(--cream);
  border: 1.5px solid var(--ink);
  overflow: hidden;
}
.login-proof .proof-row {
  display: grid;
  grid-template-columns: 94px 1fr;
  border-bottom: 1px solid var(--grey-line);
}
.login-proof .proof-row:last-child { border-bottom: none; }
.login-proof .proof-k {
  background: var(--ink);
  color: var(--cream);
  padding: 10px 12px;
  font-family: 'Fraunces', serif;
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.14em;
}
.login-proof .proof-v {
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink);
}

.login-steps {
  margin-top: 16px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.login-steps div {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--ink-mute);
}
.login-steps strong {
  width: 24px;
  height: 24px;
  background: var(--red);
  color: var(--cream);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: 'Fraunces', serif;
  font-weight: 900;
  font-size: 12px;
}
.login-steps span {
  color: var(--ink);
  font-weight: 500;
}`
);

// 8) Slightly improve card width for new copy
replaceOnce(
  "login card width",
`.login-card { width: 100%; max-width: 480px; background: var(--cream-soft);`,
`.login-card { width: 100%; max-width: 560px; background: var(--cream-soft);`
);

// 9) Improve mobile spacing
replaceOnce(
  "mobile login css",
`@media (max-width: 720px) {
  .topbar { padding: 12px 16px; }`,
`@media (max-width: 720px) {
  .login-card { padding: 48px 28px 36px; box-shadow: 6px 6px 0 var(--ink); }
  .login-card h1 { font-size: 36px; }
  .topbar { padding: 12px 16px; }`
);

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("✅ DONE: login hero patched successfully");
console.log("✅ Backup:", backupPath);
console.log("");
console.log("Next:");
console.log("git add index.html index.backup-before-login-hero-patch.html");
console.log("git commit -m \"upgrade login hero for scanner freemium\"");
console.log("git push");
