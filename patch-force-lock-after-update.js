cat > patch-force-lock-after-update.js <<'EOF'
const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

const backupPath = path.join(process.cwd(), "index.backup-before-force-lock-after-update.html");
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
}

const patch = `
/* ── HARD RESULT LOCK PATCH ──
   Prevent users from seeing final score / decision before submit/unlock.
   This runs AFTER updateAll renders, so it overrides any earlier result leak.
*/
(function hardResultLockPatch() {
  function isUnlocked() {
    try {
      return typeof resultUnlocked !== "undefined" && resultUnlocked === true;
    } catch (e) {
      return false;
    }
  }

  function forceHideFinalResult() {
    if (isUnlocked()) return;

    const totalEl = document.getElementById("totalDisplay");
    const pctEl = document.getElementById("pctDisplay");
    const decEl = document.getElementById("decisionDisplay");
    const decTxt = document.getElementById("decisionText");
    const msg = document.getElementById("resultMsg");
    const benchmark = document.getElementById("benchmarkBlock");
    const actionPlan = document.getElementById("actionPlan");
    const upsell = document.getElementById("upsellResult");

    if (totalEl) totalEl.innerHTML = "—<span class=\\"max\\"></span>";
    if (pctEl) pctEl.textContent = "—";

    if (decEl) {
      decEl.className = "result-decision empty";
    }

    if (decTxt) {
      decTxt.textContent = "กดดูผลเพื่อตรวจสินค้า";
    }

    if (msg) {
      msg.textContent = "ระบบกรอกข้อมูลให้แล้ว แต่ผลตรวจจะเปิดหลังจากกดดูผลเท่านั้น";
    }

    if (benchmark) benchmark.classList.remove("active");
    if (actionPlan) actionPlan.classList.remove("active");
    if (upsell) upsell.classList.remove("active");
  }

  // Patch updateAll so every recalculation re-locks final result
  if (typeof updateAll === "function" && !window.__legoUpdateAllLocked) {
    const originalUpdateAll = updateAll;

    updateAll = function patchedUpdateAll() {
      const result = originalUpdateAll.apply(this, arguments);
      setTimeout(forceHideFinalResult, 0);
      return result;
    };

    window.__legoUpdateAllLocked = true;
  }

  // Patch applyAutofillData so upload always locks before/after filling
  if (typeof applyAutofillData === "function" && !window.__legoAutofillLocked) {
    const originalApplyAutofillData = applyAutofillData;

    applyAutofillData = function patchedApplyAutofillData() {
      try {
        if (typeof resultUnlocked !== "undefined") resultUnlocked = false;
        document.body.classList.add("result-locked");
      } catch (e) {}

      const result = originalApplyAutofillData.apply(this, arguments);

      try {
        if (typeof resultUnlocked !== "undefined") resultUnlocked = false;
        document.body.classList.add("result-locked");
      } catch (e) {}

      setTimeout(forceHideFinalResult, 0);
      return result;
    };

    window.__legoAutofillLocked = true;
  }

  // Run immediately on page load
  setTimeout(forceHideFinalResult, 0);

  // Safety: if anything renders result later, hide again
  setInterval(function () {
    if (!isUnlocked()) forceHideFinalResult();
  }, 500);
})();
`;

if (html.includes("HARD RESULT LOCK PATCH")) {
  console.log("already patched");
} else {
  html = html.replace("</script>", patch + "\n</script>");
  fs.writeFileSync(filePath, html, "utf8");
  console.log("DONE: force lock after update patched");
}
EOF
