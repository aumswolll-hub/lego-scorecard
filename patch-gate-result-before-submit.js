const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");
const backupPath = path.join(process.cwd(), "index.backup-before-result-gate.html");

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
  html = html.replace(from, to);
  console.log("patched:", label);
}

function replaceFunction(functionName, replacement) {
  const marker = `function ${functionName}(`;
  const start = html.indexOf(marker);

  if (start === -1) {
    console.log("skip function:", functionName);
    return;
  }

  const braceStart = html.indexOf("{", start);
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
    console.log("cannot find end for:", functionName);
    return;
  }

  html = html.slice(0, start) + replacement + html.slice(end);
  console.log("patched function:", functionName);
}

/* 1) Add CSS for gated result */
patch(
  "result gate css",
`/* ── Mode Toggle ── */`,
`/* ── Result Gate ── */
.result-gate {
  margin-top: 28px;
  margin-bottom: 18px;
  background: var(--cream-soft);
  border: 1.5px solid var(--ink);
  padding: 24px 26px;
  display: block;
  box-shadow: 4px 4px 0 var(--ink);
}
.result-gate.hidden { display: none; }
.result-gate .rg-label {
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--red);
  margin-bottom: 8px;
}
.result-gate h3 {
  font-family: 'Fraunces', serif;
  font-weight: 900;
  font-size: 26px;
  line-height: 1.05;
  letter-spacing: -0.02em;
  margin-bottom: 10px;
}
.result-gate h3 em {
  font-style: italic;
  color: var(--red);
  font-weight: 500;
}
.result-gate p {
  font-size: 13px;
  color: var(--ink-mute);
  line-height: 1.55;
  margin-bottom: 16px;
}
.result-gate .rg-btn {
  width: 100%;
  background: var(--red);
  color: var(--cream);
  border: 1.5px solid var(--red);
  padding: 14px 18px;
  font-family: 'IBM Plex Sans Thai', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.15s;
}
.result-gate .rg-btn:hover:not(:disabled) {
  background: var(--ink);
  border-color: var(--ink);
  transform: translate(-2px,-2px);
  box-shadow: 4px 4px 0 var(--red);
}
.result-gate .rg-btn:disabled {
  background: var(--grey-line);
  border-color: var(--grey-line);
  color: var(--ink-mute);
  cursor: not-allowed;
}
.result-gate .rg-note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--ink-mute);
  text-align: center;
}
body.result-locked .result-block,
body.result-locked #benchmarkBlock,
body.result-locked #actionPlan,
body.result-locked #upsellResult {
  display: none !important;
}
body.result-locked #saveBtn {
  opacity: 0.45;
  pointer-events: none;
}

 /* ── Mode Toggle ── */`
);

/* 2) Insert gate before result block */
patch(
  "insert result gate html",
`    <div class="result-block">`,
`    <div class="result-gate" id="resultGate">
      <div class="rg-label">ขั้นตอนสุดท้าย</div>
      <h3 class="serif">กดเพื่อดูผล<em> ตรวจสินค้า</em></h3>
      <p>ระบบจะนับเป็น 1 ครั้งเมื่อคุณกดดูผล แล้วค่อยสรุปว่าสินค้านี้ “น่าทำ / ลองเบา ๆ / ข้ามก่อน”</p>
      <button class="rg-btn" id="resultGateBtn" onclick="unlockResult()">ดูผลตรวจสินค้า</button>
      <div class="rg-note" id="resultGateNote">กรอกข้อมูลให้ครบก่อนกดดูผล</div>
    </div>

    <div class="result-block">`
);

/* 3) Add result gate state after currentMode */
patch(
  "add result gate state",
`let currentMode = "validation"; // default: validation (TikTok-based)`,
`let currentMode = "validation"; // default: validation (TikTok-based)
let resultUnlocked = false; // result is hidden until user clicks "ดูผลตรวจสินค้า"`
);

/* 4) Add helper functions before setMode */
patch(
  "add gate helper functions",
`function setMode(mode) {`,
`function isValidationComplete() {
  return (
    num("v_commission") !== null &&
    num("v_orders7") !== null &&
    num("v_orders30") !== null &&
    num("v_ctr") !== null &&
    num("v_atc7") !== null &&
    num("v_atc30") !== null &&
    num("v_creators7") !== null &&
    num("v_creators30") !== null &&
    num("v_stock") !== null
  );
}

function isDiscoveryComplete() {
  return (
    num("gmv7") !== null &&
    num("gmv30") !== null &&
    scoreAngles() !== null &&
    num("cr") !== null &&
    num("conc") !== null
  );
}

function isCurrentFormComplete() {
  return currentMode === "validation" ? isValidationComplete() : isDiscoveryComplete();
}

function lockResult() {
  resultUnlocked = false;
  document.body.classList.add("result-locked");

  const gate = document.getElementById("resultGate");
  if (gate) gate.classList.remove("hidden");

  applyResultGateUI();
}

function applyResultGateUI() {
  const gate = document.getElementById("resultGate");
  const btn = document.getElementById("resultGateBtn");
  const note = document.getElementById("resultGateNote");

  if (!gate || !btn || !note) return;

  const complete = isCurrentFormComplete();

  if (resultUnlocked) {
    gate.classList.add("hidden");
    document.body.classList.remove("result-locked");
    return;
  }

  gate.classList.remove("hidden");
  document.body.classList.add("result-locked");

  btn.disabled = !complete;

  if (!complete) {
    note.textContent = "กรอกข้อมูลให้ครบก่อนกดดูผล";
  } else if (usageState && !usageState.can_scan) {
    note.textContent = "คุณตรวจฟรีครบแล้ว — ปลดล็อกเพื่อดูผลต่อ";
  } else if (usageState?.plan === "admin") {
    note.textContent = "Admin · ไม่ถูกนับจำนวนครั้ง";
  } else {
    const left = usageState?.scans_left ?? "—";
    const limit = usageState?.monthly_scan_limit ?? usageState?.free_scan_limit ?? "—";
    note.textContent = \`เหลือ \${left}/\${limit} ครั้ง\`;
  }
}

async function recordResultViewUsage() {
  if (!currentSession?.token) return true;

  if (usageState && usageState.is_admin) return true;

  if (usageState && !usageState.can_scan) {
    showPaywall();
    return false;
  }

  try {
    const res = await fetch("/api/usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": currentSession.token
      },
    });

    const data = await res.json().catch(() => null);

    if (res.status === 403) {
      if (data) usageState = data;
      applyUsageStateToUI();
      showPaywall();
      return false;
    }

    if (!res.ok || !data) {
      showToast("ตรวจสิทธิ์ไม่สำเร็จ ลองใหม่อีกครั้ง");
      return false;
    }

    usageState = data;

    // update counter only. Do NOT auto-open paywall after the 3rd successful free result.
    updateScanCounter();
    applyResultGateUI();

    return true;
  } catch (e) {
    console.error("[usage] result view error:", e);
    showToast("เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง");
    return false;
  }
}

async function unlockResult() {
  if (!isCurrentFormComplete()) {
    showToast("กรอกข้อมูลให้ครบก่อนดูผล");
    applyResultGateUI();
    return;
  }

  const ok = await recordResultViewUsage();
  if (!ok) return;

  resultUnlocked = true;
  document.body.classList.remove("result-locked");

  const gate = document.getElementById("resultGate");
  if (gate) gate.classList.add("hidden");

  updateAll();

  const rb = document.querySelector(".result-block");
  if (rb) rb.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setMode(mode) {`
);

/* 5) setMode should lock result */
patch(
  "setMode lock",
`  updateAll();
}`,
`  lockResult();
  updateAll();
}`
);

/* 6) Replace updateAll to apply gate after scoring */
replaceFunction("updateAll", `function updateAll() {
  if (currentMode === "validation") {
    updateValidation();
  } else {
    updateDiscovery();
  }

  applyResultGateUI();
}`);

/* 7) showApp should start locked */
patch(
  "showApp lock",
`  // Load freemium usage state
  loadUsageState();`,
`  lockResult();

  // Load freemium usage state
  loadUsageState();`
);

/* 8) applyUsageStateToUI should update gate */
patch(
  "applyUsageStateToUI gate",
`  updateScanCounter();
  initCreditTimer();
  updateDashBanner();`,
`  updateScanCounter();
  initCreditTimer();
  updateDashBanner();
  applyResultGateUI();`
);

/* 9) Remove usage increment from saveProduct because now counted on result unlock */
patch(
  "remove increment on save",
`  // ── FREEMIUM: นับ scan สำเร็จ (+1) ──
  incrementScan();

  showToast(\`บันทึก "\${name}" แล้ว — \${record.decision}\`);`,
`  // Usage is counted when user clicks "ดูผลตรวจสินค้า", not when saving to Tracker.
  showToast(\`บันทึก "\${name}" แล้ว — \${record.decision}\`);`
);

/* 10) clearForm should lock result again */
patch(
  "clearForm lock",
`  updateAll();
  document.getElementById("productName").focus();`,
`  lockResult();
  updateAll();
  document.getElementById("productName").focus();`
);

/* 11) Starting new autofill should lock result */
patch(
  "autofill lock start",
`  afStatus("loading", \`<span class="autofill-spinner">⟳</span> กำลังอ่านภาพ \${fileArr.length} ภาพ...\`);`,
`  lockResult();
  afStatus("loading", \`<span class="autofill-spinner">⟳</span> กำลังอ่านภาพ \${fileArr.length} ภาพ...\`);`
);

/* 12) Input should update gate */
patch(
  "input listener gate",
`  this.classList.remove("autofilled", "uncertain");
  updateAll();`,
`  this.classList.remove("autofilled", "uncertain");
  updateAll();
  applyResultGateUI();`
);

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("DONE: gated result before submit");
console.log("Backup:", backupPath);
console.log("");
console.log("Next:");
console.log("git add index.html patch-gate-result-before-submit.js");
console.log('git commit -m "gate scan result before showing outcome"');
console.log("git push");
