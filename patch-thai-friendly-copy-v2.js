const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");
const backupPath = path.join(process.cwd(), "index.backup-before-thai-copy-v2.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
}

function patch(label, from, to) {
  if (!html.includes(from)) {
    console.log("skip:", label);
    return;
  }
  html = html.split(from).join(to);
  console.log("patched:", label);
}

/* LOGIN / FIRST PAGE */
patch(
  "login headline old",
  '<h1 class="serif">Product<br><em>Scorecard</em></h1>\n    <p class="sub">ใส่ email ที่ใช้ซื้อคอร์ส — ระบบจะส่งลิงก์เข้าใช้งานไปทาง email</p>',
  '<h1 class="serif">เช็กสินค้า<br><em>ก่อนทำคลิป</em></h1>\n    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยดูว่าสินค้านี้ “น่าทำ / ลองเบา ๆ / ข้ามก่อน” — ทดลองใช้ฟรี 3 ครั้ง</p>'
);

patch(
  "login headline current",
  '<h1 class="serif">ตรวจสินค้า<br><em>ก่อนทำคลิป</em></h1>\n    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยบอกว่าสินค้านี้ควร TEST / RISKY / DROP — ทดลองใช้ฟรี 3 scans</p>',
  '<h1 class="serif">เช็กสินค้า<br><em>ก่อนทำคลิป</em></h1>\n    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยดูว่าสินค้านี้ “น่าทำ / ลองเบา ๆ / ข้ามก่อน” — ทดลองใช้ฟรี 3 ครั้ง</p>'
);

patch(
  "login headline already patched",
  '<h1 class="serif">ตรวจสินค้า<br><em>ก่อนทำคลิป</em></h1>\n    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยบอกว่าสินค้านี้ควร TEST / RISKY / DROP — ทดลองใช้ฟรี 3 scans</p>',
  '<h1 class="serif">เช็กสินค้า<br><em>ก่อนทำคลิป</em></h1>\n    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยดูว่าสินค้านี้ “น่าทำ / ลองเบา ๆ / ข้ามก่อน” — ทดลองใช้ฟรี 3 ครั้ง</p>'
);

patch("login button old", "ส่งลิงก์เข้าใช้งาน", "ลองตรวจสินค้าฟรี 3 ครั้ง");
patch("login button scan", "ลองสแกนฟรี 3 ครั้ง", "ลองตรวจสินค้าฟรี 3 ครั้ง");

patch(
  "login hint old",
  "ระบบจะตรวจสอบกับ Stripe ว่า email นี้ซื้อคอร์สแล้วหรือยัง<br>หากซื้อแล้ว — ลิงก์จะถูกส่งไปที่ email ภายใน 1 นาที",
  "<strong>ใช้ฟรี 3 ครั้ง</strong> · ไม่ต้องผูกบัตร · ใช้ข้อมูลจริงจาก TikTok Shop<br>ถ้าคุณซื้อ Scanner หรือ LEGO METHOD แล้ว ระบบจะปลดล็อกสิทธิ์ตามแผนให้อัตโนมัติ"
);

patch(
  "login hint scans",
  "<strong>ใช้ฟรี 3 scans</strong> · ไม่ต้องผูกบัตร · ใช้ข้อมูลจริงจาก TikTok Shop<br>ถ้าคุณซื้อ Scanner หรือ LEGO METHOD แล้ว ระบบจะปลดล็อกสิทธิ์ตามแผนให้อัตโนมัติ",
  "<strong>ใช้ฟรี 3 ครั้ง</strong> · ไม่ต้องผูกบัตร · ใช้ข้อมูลจริงจาก TikTok Shop<br>ถ้าคุณซื้อ Scanner หรือ LEGO METHOD แล้ว ระบบจะปลดล็อกสิทธิ์ตามแผนให้อัตโนมัติ"
);

patch(
  "login step 3",
  "รู้เลยว่าควร TEST / RISKY / DROP",
  "รู้เลยว่าสินค้านี้น่าทำ ลองเบา ๆ หรือควรข้าม"
);

patch(
  "proof scanner",
  "บอกว่าสินค้าน่าเล่นไหม",
  "ช่วยเช็กว่าสินค้านี้คุ้มทำไหม"
);

patch(
  "proof method",
  "สอนว่าหลังจากเจอสินค้าแล้ว ทำคลิปยังไงให้ขาย",
  "สอนว่าหลังจากเจอสินค้าที่ใช่แล้ว ต้องทำคลิปยังไงให้ขาย"
);

/* APP MAIN COPY */
patch(
  "page header sub",
  "กรอกข้อมูล — ระบบจะตัดสินใจให้",
  "กรอกข้อมูลหรืออัปโหลดรูป — ระบบช่วยบอกว่าควรทำต่อไหม"
);

patch(
  "autofill title",
  "Auto-fill จากภาพ",
  "กรอกตัวเลขจากภาพอัตโนมัติ"
);

patch(
  "autofill badge",
  "เร็วกว่า 10 เท่า",
  "ไม่ต้องกรอกเอง"
);

patch(
  "autofill sub",
  'อัปโหลด screenshot "Promotion info" จาก TikTok — ระบบกรอกให้อัตโนมัติ',
  "อัปโหลดรูป Promotion Info จาก TikTok Shop — ระบบช่วยอ่านตัวเลขให้"
);

patch(
  "upload text",
  "คลิกเพื่อเลือกภาพ หรือลากภาพมาวาง",
  "คลิกเพื่ออัปโหลดรูปสินค้า"
);

patch(
  "upload hint",
  "รองรับ 1-2 ภาพ (Last 7 days + Last 30 days)",
  "ใช้ได้ 1-2 รูป เช่น Last 7 days + Last 30 days"
);

/* RESULT DISPLAY ONLY — do not change backend decision values */
patch('validated display', 'decTxt.textContent = "✓ VALIDATED";', 'decTxt.textContent = "✓ น่าทำ";');
patch('risky display', 'decTxt.textContent = "⚠️ RISKY";', 'decTxt.textContent = "⚠️ ลองเบา ๆ ก่อน";');
patch('dead display', 'decTxt.textContent = "✗ DEAD";', 'decTxt.textContent = "✗ ข้ามก่อน";');

patch(
  "validated msg",
  'msg.textContent = "ยืนยันจาก TikTok App — สินค้าตัวนี้ขายจริง พร้อมเข้าได้";',
  'msg.textContent = "ตัวเลขค่อนข้างดี เริ่มทำคลิปทดลองได้ แต่อย่าเพิ่งทุ่มทั้งหมด";'
);

patch(
  "risky msg",
  'msg.textContent = "ตลาดมีจริง แต่มีจุดอ่อน — ต้องทดสอบก่อนทุ่ม";',
  'msg.textContent = "สินค้านี้มีโอกาส แต่ยังมีจุดที่ต้องระวัง อย่าเพิ่งซื้อของเยอะหรือทุ่มแรง";'
);

patch(
  "dead msg",
  'msg.textContent = "ตัวเลขจาก TikTok ไม่ดี — ทิ้งและหาตัวใหม่";',
  'msg.textContent = "ตัวเลขยังไม่คุ้มแรง ถ้าฝืนทำอาจเสียเวลาถ่ายคลิปฟรี";'
);

patch(
  "result threshold",
  "≥75% = PICK · 50–74% = WAIT · &lt;50% = DROP",
  "≥75% = น่าทำ · 50–74% = ลองเบา ๆ ก่อน · &lt;50% = ข้ามก่อน"
);

patch(
  "result threshold no entity",
  "≥75% = PICK · 50–74% = WAIT · <50% = DROP",
  "≥75% = น่าทำ · 50–74% = ลองเบา ๆ ก่อน · <50% = ข้ามก่อน"
);

/* VALIDATION UPSELL COPY */
patch(
  "validated upsell title",
  "สินค้านี้<em> validated</em> — แต่นั่นคือ 30% ของงาน",
  "สินค้านี้<em>น่าทำ</em> — ขั้นต่อไปคือทำคลิปให้ขาย"
);

patch(
  "validated upsell body",
  "ข้อมูลจาก TikTok ยืนยันว่าตลาดมีจริง — เหลือแค่คุณทำคอนเทนต์ที่ดึงคนได้ Angle ที่ใช่, Hook ที่จับใน 3 วินาที, Script ที่พาคนไปกดสั่งซื้อ คือสิ่งที่ LEGO METHOD สอนคุณ",
  "ระบบช่วยบอกว่าสินค้านี้มีสัญญาณดีแล้ว แต่คำถามต่อไปคือจะใช้มุมไหน Hook อะไร และทำคลิปแบบไหนให้คนซื้อ นี่คือส่วนที่ LEGO METHOD สอนต่อ"
);

patch(
  "risky upsell title",
  'ตลาด<em> มีจริง</em> — แต่ห้ามทุ่ม',
  'สินค้านี้<em>พอมีโอกาส</em> — แต่อย่าเพิ่งทุ่ม'
);

patch(
  "risky upsell body",
  "สินค้าเกรดนี้ขายได้ แต่มีจุดอ่อน (commission ต่ำ, CTR ลด, หรือ momentum ชะลอ) ห้ามใส่ effort มากก่อนทดสอบ LEGO METHOD สอนระบบทดสอบ 3-5 คลิป อ่านสัญญาณ แล้วตัดสินใจขยาย/ถอย",
  "สินค้าแบบนี้ต้องลองแบบควบคุมความเสี่ยง เริ่มจาก 1–2 คลิป หรือ 3–5 คลิปแบบมีระบบ แล้วค่อยดูสัญญาณก่อนทำต่อ"
);

patch(
  "dead upsell title",
  'ตัวเลข<em> ไม่โกหก</em> — ทิ้งเถอะ',
  'ตัวนี้<em>ข้ามก่อน</em> ดีกว่าเสียเวลา'
);

patch(
  "dead upsell body",
  "TikTok บอกชัดว่าสินค้านี้ไม่ทำเงิน — ทิ้งแล้วประหยัด 1-2 สัปดาห์ LEGO METHOD สอนระบบ Pre-Filter ที่ทำให้สินค้าที่ผ่านมาถึงคุณ ถูกกรองแล้วจาก signal ที่ใช่",
  "ดีแล้วที่รู้ก่อนลงแรง สินค้าที่ดูน่าขายไม่ได้แปลว่าคุ้มทำเสมอไป LEGO METHOD สอนวิธีคัดสินค้าตั้งแต่ต้น เพื่อไม่ต้องวนเลือกผิดซ้ำ ๆ"
);

/* PAYWALL COPY */
patch(
  "paywall tag",
  "ใช้ครบ 3 SCANS ฟรีแล้ว",
  "ตรวจฟรีครบ 3 ครั้งแล้ว"
);

patch(
  "paywall title",
  "เลือกสินค้าต่อ<em> แบบไม่เดา</em>",
  "ถ้าจะเลือกสินค้าต่อ<em> อย่าใช้แค่ความรู้สึก</em>"
);

patch(
  "paywall sub",
  "ถ้าจะคัดสินค้าต่อแบบจริงจัง เลือกแผนที่ใช่สำหรับคุณ",
  "ปลดล็อกเครื่องมือตรวจสินค้า หรือเข้า LEGO METHOD เพื่อเรียนทั้งระบบตั้งแต่เลือกสินค้า → คิดมุมคลิป → ทำคลิปขาย"
);

patch(
  "scanner benefit",
  "สแกนสินค้าได้ <strong>100 ครั้ง/เดือน</strong>",
  "ตรวจสินค้าได้ <strong>100 ครั้ง/เดือน</strong>"
);

patch(
  "method benefit",
  "ได้ LEGO SCANNER 300 ครั้ง/เดือน",
  "ได้เครื่องมือตรวจสินค้า 300 ครั้ง/เดือน"
);

patch(
  "scanner pay button",
  "ปลดล็อก Scanner",
  "ปลดล็อกเครื่องมือตรวจสินค้า"
);

patch(
  "method button",
  "เอาระบบเต็ม →",
  "เข้า LEGO METHOD →"
);

/* BADGE / COUNTER COPY */
patch("free scan counter", "ใช้ฟรีเหลือ", "ตรวจฟรีเหลือ");
patch("last scan", "scan ฟรีครั้งสุดท้าย", "ตรวจฟรีครั้งสุดท้าย");
patch("free used up", "ใช้ฟรีครบแล้ว", "ตรวจฟรีครบแล้ว");

/* SIDEBAR / OFFER COPY */
patch(
  "scanner sidebar tagline",
  "Scanner คือจุดเริ่ม — Method คือระบบที่พาไปขายจริง",
  "เครื่องมือตรวจคือจุดเริ่ม — METHOD คือระบบที่พาไปขายจริง"
);

patch(
  "view full system",
  "ดูระบบเต็ม →",
  "ดู LEGO METHOD →"
);

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("DONE: Thai-friendly copy v2 patched successfully");
console.log("Backup:", backupPath);
console.log("");
console.log("Next commands:");
console.log("git add index.html patch-thai-friendly-copy-v2.js");
console.log('git commit -m "make scanner copy Thai-friendly v2"');
console.log("git push");
