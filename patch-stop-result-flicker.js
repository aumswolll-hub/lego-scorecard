const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

const backupPath = path.join(process.cwd(), "index.backup-before-stop-result-flicker.html");
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
}

/* 1) CSS: hide result instantly while locked — no flicker */
const cssPatch = `
/* ── STOP RESULT FLICKER PATCH ── */
body.result-locked #totalDisplay,
body.result-locked #pctDisplay,
body.result-locked #decisionDisplay,
body.result-locked #resultMsg {
  visibility: hidden !important;
}

body.result-locked #benchmarkBlock,
body.result-locked #actionPlan,
body.result-locked #upsellResult {
  display: none !important;
}

body.result-locked .result-block {
  position: relative;
  min-height: 180px;
}

body.result-locked .result-block::after {
  content: "กรอกข้อมูลครบแล้ว กดปุ่มด้านล่างเพื่อดูผลตรวจและบันทึก";
  position: absolute;
  inset: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: rgba(245,239,230,0.9);
  font-family: 'IBM Plex Sans Thai', sans-serif;
  font-size: 14px;
  line-height: 1.55;
  border: 1px solid rgba(245,239,230,0.18);
  background: rgba(245,239,230,0.035);
  padding: 20px;
  z-index: 5;
}
`;

if (!html.includes("STOP RESULT FLICKER PATCH")) {
  html = html.replace("</style>", cssPatch + "\n</style>");
}

/* 2) JS: lock before input/updateAll can render */
const jsPatch = `
/* ── STOP RESULT FLICKER JS ── */
(function stopResultFlickerPatch() {
  function isActuallyUnlocked() {
    return window.resultUnlocked === true;
  }

  function lockBeforePaint() {
    if (isActuallyUnlocked()) return;
    document.body.classList.add("result-locked");
  }

  function unlockOnlyAfterSubmit() {
    document.body.classList.remove("result-locked");
  }

  // Initial lock
  window.resultUnlocked = false;
  document.body.classList.add("result-locked");

  // Capture phase = runs BEFORE normal input listeners/updateAll
  document.addEventListener("input", function(e) {
    if (!e.target || !e.target.matches("input")) return;
    window.resultUnlocked = false;
    document.body.classList.add("result-locked");
  }, true);

  // Capture change too, for autofill / file / browser events
  document.addEventListener("change", function(e) {
    if (!e.target || !e.target.matches("input")) return;
    window.resultUnlocked = false;
    document.body.classList.add("result-locked");
  }, true);

  // Patch updateAll: keep CSS lock active BEFORE and AFTER calculation
  if (typeof updateAll === "function" && !window.__stopFlickerUpdateAllPatched) {
    const originalUpdateAll = updateAll;

    updateAll = function patchedUpdateAllNoFlicker() {
      lockBeforePaint();

      const result = originalUpdateAll.apply(this, arguments);

      if (!isActuallyUnlocked()) {
        document.body.classList.add("result-locked");
      }

      return result;
    };

    window.__stopFlickerUpdateAllPatched = true;
  }

  // Patch saveProduct: only this click can unlock result
  if (typeof saveProduct === "function" && !window.__stopFlickerSaveProductPatched) {
    const originalSaveProduct = saveProduct;

    saveProduct = function patchedSaveProductNoFlicker() {
      window.resultUnlocked = true;
      unlockOnlyAfterSubmit();

      if (typeof updateAll === "function") updateAll();

      return originalSaveProduct.apply(this, arguments);
    };

    window.__stopFlickerSaveProductPatched = true;
  }

  // Keep button label stable
  function fixButtonLabel() {
    const btn = document.getElementById("saveBtn");
    if (!btn) return;
    btn.textContent = "ดูผลและบันทึก";
  }

  setTimeout(fixButtonLabel, 0);
})();
`;

if (!html.includes("STOP RESULT FLICKER JS")) {
  html = html.replace("</script>", jsPatch + "\n</script>");
}

fs.writeFileSync(filePath, html, "utf8");
console.log("DONE: stop result flicker patched");
console.log("Backup:", backupPath);
