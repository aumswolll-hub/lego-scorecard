cat > patch-hard-lock-result.js <<'EOF'
const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

const backupPath = path.join(process.cwd(), "index.backup-before-hard-result-lock.html");
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
}

function insertAfter(label, needle, insert) {
  if (!html.includes(needle)) {
    console.log("skip:", label);
    return;
  }
  if (html.includes(insert.trim().slice(0, 80))) {
    console.log("already patched:", label);
    return;
  }
  html = html.replace(needle, needle + insert);
  console.log("patched:", label);
}

function replaceOnce(label, from, to) {
  if (!html.includes(from)) {
    console.log("skip:", label);
    return;
  }
  html = html.replace(from, to);
  console.log("patched:", label);
}

/* 1) Add hard lock helper */
insertAfter(
  "hard lock helper after hideBenchmarkAndPlan",
`function hideBenchmarkAndPlan() {
  document.getElementById("benchmarkBlock").classList.remove("active");
  document.getElementById("actionPlan").classList.remove("active");
}
`,
`

function hideFinalResultUntilUnlocked() {
  const totalEl = document.getElementById("totalDisplay");
  const pctEl = document.getElementById("pctDisplay");
  const decEl = document.getElementById("decisionDisplay");
  const decTxt = document.getElementById("decisionText");
  const msg = document.getElementById("resultMsg");
  const saveBtn = document.getElementById("saveBtn");
  const upsell = document.getElementById("upsellResult");

  if (totalEl) totalEl.innerHTML = "—<span class=\\"max\\"></span>";
  if (pctEl) pctEl.textContent = "—";
  if (decEl) decEl.className = "result-decision empty";
  if (decTxt) decTxt.textContent = "กดดูผลเพื่อตรวจสินค้า";
  if (msg) msg.textContent = "ผลลัพธ์จะถูกเปิดหลังจากกด “ดูผลตรวจสินค้า”";
  if (saveBtn) saveBtn.disabled = true;
  if (upsell) upsell.classList.remove("active");

  hideBenchmarkAndPlan();
}

function shouldHideFinalResult() {
  return resultUnlocked !== true;
}
`
);

/* 2) In updateValidation: if all fields filled but result locked, stop before rendering final decision */
replaceOnce(
  "lock validation before final result",
`  if (!allFilled) {
    totalEl.innerHTML = "—<span class=\\"max\\">/21</span>";
    pctEl.textContent = "—";
    decEl.className = "result-decision empty";
    decTxt.textContent = "กรอกข้อมูลให้ครบเพื่อดูผล";
    msg.textContent = \`กรอกแล้ว \${filled}/7 ข้อ • Validation Mode (TikTok App)\`;
    saveBtn.disabled = true;
    document.getElementById("upsellResult").classList.remove("active");
    hideBenchmarkAndPlan();
  } else {`,
`  if (!allFilled) {
    totalEl.innerHTML = "—<span class=\\"max\\">/21</span>";
    pctEl.textContent = "—";
    decEl.className = "result-decision empty";
    decTxt.textContent = "กรอกข้อมูลให้ครบเพื่อดูผล";
    msg.textContent = \`กรอกแล้ว \${filled}/7 ข้อ • Validation Mode (TikTok App)\`;
    saveBtn.disabled = true;
    document.getElementById("upsellResult").classList.remove("active");
    hideBenchmarkAndPlan();
  } else if (shouldHideFinalResult()) {
    hideFinalResultUntilUnlocked();
  } else {`
);

/* 3) In updateDiscovery: same hard lock */
replaceOnce(
  "lock discovery before final result",
`  if (!allFilled) {
    totalEl.innerHTML = "—" + (hasComm ? '<span class="max">/15</span>' : '<span class="max">/12</span>');
    pctEl.textContent = "—";
    decEl.className = "result-decision empty";
    decTxt.textContent = "กรอกข้อมูลให้ครบเพื่อดูผล";
    msg.textContent = \`กรอกแล้ว \${filled}/\${hasComm ? 5 : 4} ข้อ\`;
    saveBtn.disabled = true;
    document.getElementById("upsellResult").classList.remove("active");
    hideBenchmarkAndPlan();
  } else {`,
`  if (!allFilled) {
    totalEl.innerHTML = "—" + (hasComm ? '<span class="max">/15</span>' : '<span class="max">/12</span>');
    pctEl.textContent = "—";
    decEl.className = "result-decision empty";
    decTxt.textContent = "กรอกข้อมูลให้ครบเพื่อดูผล";
    msg.textContent = \`กรอกแล้ว \${filled}/\${hasComm ? 5 : 4} ข้อ\`;
    saveBtn.disabled = true;
    document.getElementById("upsellResult").classList.remove("active");
    hideBenchmarkAndPlan();
  } else if (shouldHideFinalResult()) {
    hideFinalResultUntilUnlocked();
  } else {`
);

/* 4) Force auto-fill to stay locked after filling */
replaceOnce(
  "autofill force lock after apply",
`    const filled = applyAutofillData(result.data || {});`,
`    resultUnlocked = false;
    document.body.classList.add("result-locked");
    const filled = applyAutofillData(result.data || {});
    resultUnlocked = false;
    document.body.classList.add("result-locked");`
);

/* 5) Make input always re-lock result after changes */
replaceOnce(
  "input relock",
`  this.classList.remove("autofilled", "uncertain");
  updateAll();`,
`  this.classList.remove("autofilled", "uncertain");
  resultUnlocked = false;
  document.body.classList.add("result-locked");
  updateAll();`
);

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("DONE: hard result lock patched");
console.log("Backup:", backupPath);
EOF
