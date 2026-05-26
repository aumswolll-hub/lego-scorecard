const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");
const backupPath = path.join(process.cwd(), "index.backup-before-thai-friendly-copy.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html — ให้รันใน root project ที่มี index.html");
}

let html = fs.readFileSync(filePath, "utf8");

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("✅ backup created:", backupPath);
}

function replaceAll(label, search, replacement) {
  const count = (html.match(new RegExp(escapeRegExp(search), "g")) || []).length;
  if (count === 0) {
    console.warn(`⚠️ ไม่เจอ text: ${label} — ข้าม`);
    return;
  }
  html = html.split(search).join(replacement);
  console.log(`✅ patched ${label}: ${count} จุด`);
}

function replaceOnce(label, search, replacement) {
  if (!html.includes(search)) {
    console.warn(`⚠️ ไม่เจอ block: ${label} — ข้าม`);
    return;
  }
  html = html.replace(search, replacement);
  console.log("✅ patched:", label);
}

function replaceFunction(functionName, replacement) {
  const marker = `function ${functionName}(`;
  const start = html.indexOf(marker);

  if (start === -1) {
    console.warn(`⚠️ ไม่เจอ function: ${functionName} — ข้าม`);
    return;
  }

  const braceStart = html.indexOf("{", start);
  if (braceStart === -1) {
    console.warn(`⚠️ function ${functionName} ไม่มี { — ข้าม`);
    return;
  }

  let depth = 0;
  let end = -1;

  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      end = i + 1;
      break;
    }
  }

  if (end === -1) {
    console.warn(`⚠️ หา end ของ function ${functionName} ไม่เจอ — ข้าม`);
    return;
  }

  html = html.slice(0, start) + replacement + html.slice(end);
  console.log("✅ patched function:", functionName);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ════════════════════════════════════════════════
// 1) Login / First page copy
// ════════════════════════════════════════════════

replaceOnce(
  "login headline to Thai-friendly",
`<h1 class="serif">ตรวจสินค้า<br><em>ก่อนทำคลิป</em></h1>
    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยบอกว่าสินค้านี้ควร TEST / RISKY / DROP — ทดลองใช้ฟรี 3 scans</p>`,
`<h1 class="serif">เช็กสินค้า<br><em>ก่อนทำคลิป</em></h1>
    <p class="sub">อัปโหลดรูป Promotion Info จาก TikTok Shop แล้วให้ระบบช่วยดูว่าสินค้านี้ “น่าทำ / ลองเบา ๆ / ข้ามก่อน” — ทดลองใช้ฟรี 3 ครั้ง</p>`
);

replaceAll("ลองสแกนฟรี 3 ครั้ง", "ลองสแกนฟรี 3 ครั้ง", "ลองตรวจสินค้าฟรี 3 ครั้ง");
replaceAll("ลองสแกนฟรี 3 ครั้ง button fallback", "ลองสแกนฟรี 3 ครั้ง", "ลองตรวจสินค้าฟรี 3 ครั้ง");
replaceAll("ทดลองใช้ฟรี 3 scans", "ทดลองใช้ฟรี 3 scans", "ทดลองใช้ฟรี 3 ครั้ง");
replaceAll("ใช้ฟรี 3 scans", "ใช้ฟรี 3 scans", "ใช้ฟรี 3 ครั้ง");
replaceAll("Free 3 scans", "Free 3 scans", "Free 3 ครั้ง");
replaceAll("3 scans", "3 scans", "3 ครั้ง");

replaceOnce(
  "login steps text",
`<div><strong>3</strong><span>รู้เลยว่าควร TEST / RISKY / DROP</span></div>`,
`<div><strong>3</strong><span>รู้เลยว่าสินค้านี้น่าทำ ลองเบา ๆ หรือควรข้าม</span></div>`
);

replaceAll("SCANNER</span>\n        <span class=\"proof-v\">บอกว่าสินค้าน่าเล่นไหม", "SCANNER</span>\n        <span class=\"proof-v\">บอกว่าสินค้าน่าเล่นไหม", "SCANNER</span>\n        <span class=\"proof-v\">ช่วยเช็กว่าสินค้านี้คุ้มทำไหม");

replaceAll("METHOD</span>\n        <span class=\"proof-v\">สอนว่าหลังจากเจอสินค้าแล้ว ทำคลิปยังไงให้ขาย", "METHOD</span>\n        <span class=\"proof-v\">สอนว่าหลังจากเจอสินค้าแล้ว ทำคลิปยังไงให้ขาย", "METHOD</span>\n        <span class=\"proof-v\">สอนว่าหลังจากเจอสินค้าที่ใช่แล้ว ต้องทำคลิปยังไงให้ขาย");

// ════════════════════════════════════════════════
// 2) General wording: scan -> ตรวจ / scorecard -> เครื่องมือตรวจ
// ════════════════════════════════════════════════

replaceAll("Product <em>Scorecard</em>", "Product <em>Scorecard</em>", "Product <em>Checker</em>");
replaceAll("Product<br><em>Scorecard</em>", "Product<br><em>Scorecard</em>", "ตรวจสินค้า<br><em>ก่อนทำคลิป</em>");
replaceAll("Scorecard</button>", "Scorecard</button>", "ตรวจสินค้า</button>");
replaceAll("Scorecard", "Scorecard", "ตรวจสินค้า");
replaceAll("scorecard", "scorecard", "checker");

replaceAll("scans", "scans", "ครั้ง");
replaceAll("Scans", "Scans", "ครั้ง");
replaceAll("scan", "scan", "ตรวจ");
replaceAll("Scan", "Scan", "ตรวจ");

// Fix accidental API/function words? Keep URLs/routes safe if any visible text replacement hit route names.
// Restore important route/function strings if accidentally changed.
replaceAll("free_ตรวจ_limit", "free_ตรวจ_limit", "free_scan_limit");
replaceAll("monthly_ตรวจ_limit", "monthly_ตรวจ_limit", "monthly_scan_limit");
replaceAll("ตรวจs_used", "ตรวจs_used", "scans_used");
replaceAll("ตรวจs_left", "ตรวจs_left", "scans_left");
replaceAll("can_ตรวจ", "can_ตรวจ", "can_scan");
replaceAll("/api/usage", "/api/usage", "/api/usage");
replaceAll("/api/analyze-image", "/api/analyze-image", "/api/analyze-image");

// ════════════════════════════════════════════════
// 3) Mode / App visible copy
// ════════════════════════════════════════════════

replaceAll("ตรวจสินค้า<em> ของคุณ</em>", "ตรวจสินค้า<em> ของคุณ</em>", "เช็กสินค้า<em> ของคุณ</em>");
replaceAll("กรอกข้อมูล — ระบบจะตัดสินใจให้", "กรอกข้อมูล — ระบบจะตัดสินใจให้", "กรอกข้อมูลหรืออัปโหลดรูป — ระบบช่วยบอกว่าควรทำต่อไหม");

replaceAll("Auto-fill จากภาพ", "Auto-fill จากภาพ", "กรอกตัวเลขจากภาพอัตโนมัติ");
replaceAll("เร็วกว่า 10 เท่า", "เร็วกว่า 10 เท่า", "ไม่ต้องกรอกเอง");
replaceAll("อัปโหลด screenshot \"Promotion info\" จาก TikTok — ระบบกรอกให้อัตโนมัติ", "อัปโหลด screenshot \"Promotion info\" จาก TikTok — ระบบกรอกให้อัตโนมัติ", "อัปโหลดรูป Promotion Info จาก TikTok Shop — ระบบช่วยอ่านตัวเลขให้");
replaceAll("คลิกเพื่อเลือกภาพ หรือลากภาพมาวาง", "คลิกเพื่อเลือกภาพ หรือลากภาพมาวาง", "คลิกเพื่ออัปโหลดรูปสินค้า");
replaceAll("รองรับ 1-2 ภาพ (Last 7 days + Last 30 days)", "รองรับ 1-2 ภาพ (Last 7 days + Last 30 days)", "ใช้ได้ 1-2 รูป เช่น Last 7 days + Last 30 days");

// ════════════════════════════════════════════════
// 4) Result display: replace updateValidation function display text only
// ════════════════════════════════════════════════

replaceFunction("updateValidation", `function updateValidation() {
  const comm = num("v_commission");
  const sComm = vScoreCommission(comm);
  if (comm === null) setFeedback("fb-v-commission", null, \`← จากที่ TikTok แสดง เช่น "10% commission rate"\`);
  else if (sComm === 3) setFeedback("fb-v-commission", 3, \`<span class="score-badge">3</span> \${comm}% — ค่าคอมดี คุ้มแรง ✅\`);
  else if (sComm === 2) setFeedback("fb-v-commission", 2, \`<span class="score-badge">2</span> \${comm}% — ค่าคอมพอใช้ได้\`);
  else if (sComm === 1) setFeedback("fb-v-commission", 1, \`<span class="score-badge">1</span> \${comm}% — ค่าคอมค่อนข้างต่ำ\`);
  else setFeedback("fb-v-commission", 0, \`<span class="score-badge">0</span> \${comm}% — ต่ำเกินไป อาจไม่คุ้มทำ\`);

  const o7 = num("v_orders7"), o30 = num("v_orders30");
  const sOrders = vScoreOrders(o7, o30);
  if (sOrders === null) setFeedback("fb-v-orders", null, "← กรอก Orders ทั้ง 7 วัน และ 30 วัน");
  else {
    const expected7 = o30 > 0 ? (o30 * 7/30) : 0;
    const ratio = expected7 > 0 ? Math.round(o7/expected7 * 100) : 0;
    if (sOrders === 3) setFeedback("fb-v-orders", 3, \`<span class="score-badge">3</span> 7 วัน=\${o7} | 30 วัน=\${o30} — กระแสยังไปต่อ ✅\`);
    else if (sOrders === 2) setFeedback("fb-v-orders", 2, \`<span class="score-badge">2</span> 7 วัน=\${o7} | 30 วัน=\${o30} — ยังพอไปได้\`);
    else setFeedback("fb-v-orders", 1, \`<span class="score-badge">1</span> 7 วัน=\${o7} | 30 วัน=\${o30} — เริ่มชะลอ ต้องระวัง\`);
  }

  const ctr = num("v_ctr");
  const sCTR = vScoreCTR(ctr);
  if (sCTR === null) setFeedback("fb-v-ctr", null, "← CTR สูง = คนเห็นแล้วสนใจคลิก");
  else if (sCTR === 3) setFeedback("fb-v-ctr", 3, \`<span class="score-badge">3</span> CTR \${ctr}% — คนสนใจดีมาก ✅\`);
  else if (sCTR === 2) setFeedback("fb-v-ctr", 2, \`<span class="score-badge">2</span> CTR \${ctr}% — พอใช้ได้\`);
  else setFeedback("fb-v-ctr", 1, \`<span class="score-badge">1</span> CTR \${ctr}% — คนคลิกน้อย ต้องใช้มุมคลิปแข็ง\`);

  const atc7 = num("v_atc7"), atc30 = num("v_atc30");
  const sATC = vScoreATC(atc7, atc30);
  if (sATC === null) setFeedback("fb-v-atc", null, "← คนใส่ตะกร้าเยอะ = มีความอยากซื้อ");
  else {
    const expected7 = atc30 > 0 ? (atc30 * 7/30) : 0;
    const ratio = expected7 > 0 ? Math.round(atc7/expected7 * 100) : 0;
    if (sATC === 3) setFeedback("fb-v-atc", 3, \`<span class="score-badge">3</span> ตะกร้า 7 วัน=\${atc7} | 30 วัน=\${atc30} — คนยังอยากซื้อ ✅\`);
    else if (sATC === 2) setFeedback("fb-v-atc", 2, \`<span class="score-badge">2</span> ตะกร้า 7 วัน=\${atc7} | 30 วัน=\${atc30} — ยังพอได้\`);
    else setFeedback("fb-v-atc", 1, \`<span class="score-badge">1</span> ตะกร้า 7 วัน=\${atc7} | 30 วัน=\${atc30} — ความสนใจเริ่มตก\`);
  }

  const sCVR = vScoreCVR(o30, atc30);
  const cvrDisp = document.getElementById("v_cvr_display");
  if (sCVR === null) {
    cvrDisp.className = "calc-value empty";
    cvrDisp.innerHTML = "—";
    setFeedback("fb-v-cvr", null, "← ระบบคำนวณให้ ต้องกรอก Orders 30d + ATC 30d");
  } else {
    const cvr = (o30/atc30 * 100);
    cvrDisp.className = "calc-value";
    cvrDisp.innerHTML = cvr.toFixed(1) + "%";
    if (sCVR === 3) setFeedback("fb-v-cvr", 3, \`<span class="score-badge">3</span> ปิดการขาย \${cvr.toFixed(1)}% — คนใส่ตะกร้าแล้วซื้อดีมาก ✅\`);
    else if (sCVR === 2) setFeedback("fb-v-cvr", 2, \`<span class="score-badge">2</span> ปิดการขาย \${cvr.toFixed(1)}% — ใช้ได้\`);
    else setFeedback("fb-v-cvr", 1, \`<span class="score-badge">1</span> ปิดการขาย \${cvr.toFixed(1)}% — คนลังเลเยอะ ต้องทำคลิปให้ชัด\`);
  }

  const c7 = num("v_creators7"), c30 = num("v_creators30");
  if (c7 === null && c30 === null) setFeedback("fb-v-creators", null, "← จำนวนคนที่กำลังทำสินค้านี้");
  else setFeedback("fb-v-creators", null, \`<span class="score-badge">i</span> คนทำ 7 วัน=\${c7 ?? "—"} | 30 วัน=\${c30 ?? "—"} — ใช้ดูว่าตลาดแน่นหรือยัง\`);

  const sOPC = vScoreOrdersPerCreator(o30, c30);
  const opcDisp = document.getElementById("v_opc_display");
  if (sOPC === null) {
    opcDisp.className = "calc-value empty";
    opcDisp.innerHTML = "—";
  } else {
    const opc = o30 / c30;
    opcDisp.className = "calc-value";
    opcDisp.innerHTML = opc.toFixed(1) + "<em>/คน (" + sOPC + "/3)</em>";
  }

  const sCGrowth = vScoreCreatorGrowth(c7, c30);
  const cgDisp = document.getElementById("v_cgrowth_display");
  if (sCGrowth === null) {
    cgDisp.className = "calc-value empty";
    cgDisp.innerHTML = "—";
  } else {
    const expected7 = c30 > 0 ? (c30 * 7/30) : 0;
    const ratio = expected7 > 0 ? Math.round(c7/expected7 * 100) : 0;
    cgDisp.className = "calc-value";
    cgDisp.innerHTML = ratio + "<em>% (" + sCGrowth + "/3)</em>";
  }

  const sCreator = vScoreCreatorCombined(o30, c7, c30);
  if (sCreator === null) {
    setFeedback("fb-v-creatorscore", null, "← ระบบดูให้ว่าคนทำสินค้านี้ขายได้จริงไหม");
    document.getElementById("creatorInsight").classList.remove("active");
  } else {
    let detail = "";
    if (sCreator === 3) detail = "คนทำสินค้านี้ยังขายได้ดี ตลาดยังน่าสนใจ ✅";
    else if (sCreator === 2) detail = "ยังพอทำได้ แต่ต้องดูมุมคลิปให้ดี";
    else detail = "คนทำเยอะหรือกระแสเริ่มตก ต้องระวังมาก";
    setFeedback("fb-v-creatorscore", sCreator, \`<span class="score-badge">\${sCreator}</span> สัญญาณตลาด \${sCreator}/3 — \${detail}\`);
    renderCreatorInsight(sOPC, sCGrowth, o30, c30, c7);
  }

  const stock = num("v_stock");
  const sStock = vScoreStock(stock, o30);
  if (sStock === null) setFeedback("fb-v-stock", null, "← ของเหลือพอขายไหม");
  else if (o30 && o30 > 0) {
    const days = Math.round(stock / (o30/30));
    if (sStock === 3) setFeedback("fb-v-stock", 3, \`<span class="score-badge">3</span> ของเหลือ \${stock} ชิ้น — พอประมาณ \${days} วัน ✅\`);
    else if (sStock === 2) setFeedback("fb-v-stock", 2, \`<span class="score-badge">2</span> ของเหลือ \${stock} ชิ้น — พอประมาณ \${days} วัน เริ่มต้องระวัง\`);
    else setFeedback("fb-v-stock", 1, \`<span class="score-badge">1</span> ของเหลือ \${stock} ชิ้น — เหลือประมาณ \${days} วัน อาจหมดเร็ว\`);
  } else {
    setFeedback("fb-v-stock", sStock, \`<span class="score-badge">\${sStock}</span> ของเหลือ \${stock} ชิ้น — กรอก Orders 30d เพื่อคำนวณว่าพอขายกี่วัน\`);
  }

  const fields = [sComm, sOrders, sCTR, sATC, sCVR, sCreator, sStock];
  const filled = fields.filter(s => s !== null).length;
  const total = fields.reduce((sum, s) => sum + (s ?? 0), 0);
  const max = 21;

  const totalEl = document.getElementById("totalDisplay");
  const pctEl = document.getElementById("pctDisplay");
  const decEl = document.getElementById("decisionDisplay");
  const decTxt = document.getElementById("decisionText");
  const msg = document.getElementById("resultMsg");
  const saveBtn = document.getElementById("saveBtn");
  const allFilled = (sComm !== null && sOrders !== null && sCTR !== null && sATC !== null && sCVR !== null && sCreator !== null && sStock !== null);

  if (!allFilled) {
    totalEl.innerHTML = "—<span class=\\"max\\">/21</span>";
    pctEl.textContent = "—";
    decEl.className = "result-decision empty";
    decTxt.textContent = "กรอกข้อมูลให้ครบเพื่อดูผล";
    msg.textContent = \`กรอกแล้ว \${filled}/7 ข้อ • ใช้ข้อมูลจาก TikTok Shop\`;
    saveBtn.disabled = true;
    document.getElementById("upsellResult").classList.remove("active");
    hideBenchmarkAndPlan();
  } else {
    const pct = total / max;
    totalEl.innerHTML = total + '<span class="max">/' + max + '</span>';
    pctEl.textContent = Math.round(pct * 100) + "%";
    decEl.className = "result-decision";
    const upsellCard = document.getElementById("upsellResult");
    const upsellTitle = document.getElementById("upsellResultTitle");
    const upsellBody = document.getElementById("upsellResultBody");
    const upsellMetaL = document.getElementById("upsellMetaLeft");
    const upsellMetaR = document.getElementById("upsellMetaRight");
    const upsellBtn = document.getElementById("upsellResultBtn");

    upsellCard.classList.add("active");
    upsellCard.classList.remove("pick","wait","drop");

    let decisionVal = "";
    if (pct >= 0.74) {
      decisionVal = "VALIDATED";
      decEl.classList.add("pick");
      decTxt.textContent = "✓ น่าทำ";
      msg.textContent = "ตัวเลขค่อนข้างดี เริ่มทำคลิปทดลองได้ แต่อย่าเพิ่งทุ่มทั้งหมด";
      upsellCard.classList.add("pick");
      upsellTitle.innerHTML = 'สินค้านี้<em>น่าทำ</em> — ขั้นต่อไปคือทำคลิปให้ขาย';
      upsellBody.textContent = "ระบบช่วยบอกว่าสินค้านี้มีสัญญาณดีแล้ว แต่คำถามต่อไปคือจะใช้มุมไหน Hook อะไร และทำคลิปแบบไหนให้คนซื้อ นี่คือส่วนที่ LEGO METHOD สอนต่อ";
      upsellMetaL.textContent = "ช่วยบอกว่าน่าทำ";
      upsellMetaR.textContent = "สอนทำคลิปให้ขาย";
      upsellBtn.textContent = "ดูวิธีทำให้ขายจริง →";
    } else if (pct >= 0.5) {
      decisionVal = "RISKY";
      decEl.classList.add("wait");
      decTxt.textContent = "⚠️ ลองเบา ๆ ก่อน";
      msg.textContent = "สินค้านี้มีโอกาส แต่ยังมีจุดที่ต้องระวัง อย่าเพิ่งซื้อของเยอะหรือทุ่มแรง";
      upsellCard.classList.add("wait");
      upsellTitle.innerHTML = 'สินค้านี้<em>พอมีโอกาส</em> — แต่อย่าเพิ่งทุ่ม';
      upsellBody.textContent = "สินค้าแบบนี้ต้องลองแบบควบคุมความเสี่ยง เริ่มจาก 1–2 คลิป หรือ 3–5 คลิปแบบมีระบบ แล้วค่อยดูสัญญาณก่อนทำต่อ";
      upsellMetaL.textContent = "ช่วยบอกให้ระวัง";
      upsellMetaR.textContent = "สอนระบบทดลองคลิป";
      upsellBtn.textContent = "เรียนระบบลองคลิปก่อนทุ่ม →";
    } else {
      decisionVal = "DEAD";
      decEl.classList.add("drop");
      decTxt.textContent = "✗ ข้ามก่อน";
      msg.textContent = "ตัวเลขยังไม่คุ้มแรง ถ้าฝืนทำอาจเสียเวลาถ่ายคลิปฟรี";
      upsellCard.classList.add("drop");
      upsellTitle.innerHTML = 'ตัวนี้<em>ข้ามก่อน</em> ดีกว่าเสียเวลา';
      upsellBody.textContent = "ดีแล้วที่รู้ก่อนลงแรง สินค้าที่ดูน่าขายไม่ได้แปลว่าคุ้มทำเสมอไป LEGO METHOD สอนวิธีคัดสินค้าตั้งแต่ต้น เพื่อไม่ต้องวนเลือกผิดซ้ำ ๆ";
      upsellMetaL.textContent = "ช่วยกันเสียเวลา";
      upsellMetaR.textContent = "สอนหาตัวที่คุ้มทำ";
      upsellBtn.textContent = "หาสินค้าที่คุ้มทำกว่า →";
    }

    renderBenchmark(pct, "validation", decisionVal);
    renderActionPlan(decisionVal, "validation");

    saveBtn.disabled = !document.getElementById("productName").value.trim();
  }
}`);

// ════════════════════════════════════════════════
// 5) Paywall copy
// ════════════════════════════════════════════════

replaceAll("ใช้ครบ 3 SCANS ฟรีแล้ว", "ใช้ครบ 3 SCANS ฟรีแล้ว", "ตรวจฟรีครบ 3 ครั้งแล้ว");
replaceAll("เลือกสินค้าต่อ<em> แบบไม่เดา</em>", "เลือกสินค้าต่อ<em> แบบไม่เดา</em>", "ถ้าจะเลือกสินค้าต่อ<em> อย่าใช้แค่ความรู้สึก</em>");
replaceAll("ถ้าจะคัดสินค้าต่อแบบจริงจัง เลือกแผนที่ใช่สำหรับคุณ", "ถ้าจะคัดสินค้าต่อแบบจริงจัง เลือกแผนที่ใช่สำหรับคุณ", "ปลดล็อกเครื่องมือตรวจสินค้า หรือเข้า LEGO METHOD เพื่อเรียนทั้งระบบตั้งแต่เลือกสินค้า → คิดมุมคลิป → ทำคลิปขาย");

replaceAll("LEGO SCANNER", "LEGO SCANNER", "LEGO SCANNER");
replaceAll("สแกนสินค้าได้ <strong>100 ครั้ง/เดือน</strong>", "สแกนสินค้าได้ <strong>100 ครั้ง/เดือน</strong>", "ตรวจสินค้าได้ <strong>100 ครั้ง/เดือน</strong>");
replaceAll("ได้ LEGO SCANNER 300 ครั้ง/เดือน", "ได้ LEGO SCANNER 300 ครั้ง/เดือน", "ได้เครื่องมือตรวจสินค้า 300 ครั้ง/เดือน");

replaceAll("ปลดล็อก Scanner", "ปลดล็อก Scanner", "ปลดล็อกเครื่องมือตรวจสินค้า");
replaceAll("เอาระบบเต็ม →", "เอาระบบเต็ม →", "เข้า LEGO METHOD →");

// ════════════════════════════════════════════════
// 6) Result default message / action plan words
// ════════════════════════════════════════════════

replaceAll("≥75% = PICK · 50–74% = WAIT · <50% = DROP", "≥75% = PICK · 50–74% = WAIT · <50% = DROP", "≥75% = น่าทำ · 50–74% = ลองเบา ๆ ก่อน · <50% = ข้ามก่อน");
replaceAll("≥75% = PICK · 50–74% = WAIT · &lt;50% = DROP", "≥75% = PICK · 50–74% = WAIT · &lt;50% = DROP", "≥75% = น่าทำ · 50–74% = ลองเบา ๆ ก่อน · &lt;50% = ข้ามก่อน");

replaceAll("PICK", "PICK", "น่าทำ");
replaceAll("WAIT", "WAIT", "ลองเบา ๆ");
replaceAll("DROP", "DROP", "ข้ามก่อน");
replaceAll("VALIDATED", "VALIDATED", "น่าทำ");
replaceAll("RISKY", "RISKY", "ลองเบา ๆ");
replaceAll("DEAD", "DEAD", "ข้ามก่อน");

// Restore decision logic strings if accidental display replacement broke JS comparisons
replaceAll('decision === "น่าทำ"', 'decision === "น่าทำ"', 'decision === "PICK" || decision === "VALIDATED"');
replaceAll('decision === "ลองเบา ๆ"', 'decision === "ลองเบา ๆ"', 'decision === "WAIT" || decision === "RISKY"');
replaceAll('decision === "ข้ามก่อน"', 'decision === "ข้ามก่อน"', 'decision === "DROP" || decision === "DEAD"');

// Restore internal constants that must remain English in records/logic
replaceAll('decisionVal = "น่าทำ";', 'decisionVal = "น่าทำ";', 'decisionVal = "PICK";');
replaceAll('decisionVal = "ลองเบา ๆ";', 'decisionVal = "ลองเบา ๆ";', 'decisionVal = "WAIT";');
replaceAll('decisionVal = "ข้ามก่อน";', 'decisionVal = "ข้ามก่อน";', 'decisionVal = "DROP";');
replaceAll('const decision = pct >= 0.74 ? "น่าทำ" : pct >= 0.5 ? "ลองเบา ๆ" : "ข้ามก่อน";', 'const decision = pct >= 0.74 ? "น่าทำ" : pct >= 0.5 ? "ลองเบา ๆ" : "ข้ามก่อน";', 'const decision = pct >= 0.74 ? "PICK" : pct >= 0.5 ? "WAIT" : "DROP";');
replaceAll('const decision = pct >= 0.74 ? "น่าทำ" : pct >= 0.5 ? "ลองเบา ๆ" : "ข้ามก่อน";', 'const decision = pct >= 0.74 ? "น่าทำ" : pct >= 0.5 ? "ลองเบา ๆ" : "ข้ามก่อน";', 'const decision = pct >= 0.74 ? "VALIDATED" : pct >= 0.5 ? "RISKY" : "DEAD";');

// ════════════════════════════════════════════════
// 7) Bio / CTA words in offer modal
// ════════════════════════════════════════════════

replaceAll("Scanner คือจุดเริ่ม — Method คือระบบที่พาไปขายจริง", "Scanner คือจุดเริ่ม — Method คือระบบที่พาไปขายจริง", "เครื่องมือตรวจคือจุดเริ่ม — METHOD คือระบบที่พาไปขายจริง");
replaceAll("SCANNER เลือก<em> สนามรบ</em>", "SCANNER เลือก<em> สนามรบ</em>", "SCANNER ช่วย<em> คัดสินค้า</em>");
replaceAll("METHOD สอน<em> ให้ชนะ</em>", "METHOD สอน<em> ให้ชนะ</em>", "METHOD สอน<em> ให้ขาย</em>");
replaceAll("SCANNER บอกว่าสินค้าน่าเล่นไหม", "SCANNER บอกว่าสินค้าน่าเล่นไหม", "SCANNER ช่วยดูว่าสินค้าคุ้มทำไหม");
replaceAll("METHOD สอนเล่นยังไงให้ขาย", "METHOD สอนเล่นยังไงให้ขาย", "METHOD สอนทำคลิปยังไงให้ขาย");
replaceAll("ดูระบบเต็ม →", "ดูระบบเต็ม →", "ดู LEGO METHOD →");

// ════════════════════════════════════════════════
// Write file
// ════════════════════════════════════════════════

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("✅ DONE: Thai-friendly copy patched successfully");
console.log("✅ Backup:", backupPath);
console.log("");
console.log("Next:");
console.log("git add index.html index.backup-before-thai-friendly-copy.html patch-thai-friendly-copy.js");
console.log("git commit -m \\"make scanner copy Thai-friendly\\"");
console.log("git push");
