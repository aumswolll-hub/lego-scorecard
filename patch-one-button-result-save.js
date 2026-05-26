const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

const backupPath = path.join(process.cwd(), "index.backup-before-one-button-result-save.html");
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
}

const patch = `
/* ── ONE BUTTON RESULT + SAVE PATCH ── */
(function oneButtonResultSavePatch() {
  function n(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const v = el.value;
    return v === "" ? null : parseFloat(v);
  }

  function hasValue(id) {
    const el = document.getElementById(id);
    return !!(el && String(el.value || "").trim());
  }

  function validationReady() {
    return (
      hasValue("productName") &&
      n("v_commission") !== null &&
      n("v_orders7") !== null &&
      n("v_orders30") !== null &&
      n("v_ctr") !== null &&
      n("v_atc7") !== null &&
      n("v_atc30") !== null &&
      n("v_creators7") !== null &&
      n("v_creators30") !== null &&
      n("v_stock") !== null
    );
  }

  function discoveryReady() {
    const hasAngles = [1,2,3,4,5].some(i => hasValue("angle" + i));
    return (
      hasValue("productName") &&
      n("gmv7") !== null &&
      n("gmv30") !== null &&
      hasAngles &&
      n("cr") !== null &&
      n("conc") !== null
    );
  }

  function formReady() {
    try {
      if (typeof currentMode !== "undefined" && currentMode === "discovery") {
        return discoveryReady();
      }
      return validationReady();
    } catch (e) {
      return validationReady();
    }
  }

  function styleMainCTA() {
    const btn = document.getElementById("saveBtn");
    if (!btn) return;

    btn.textContent = "ดูผลและบันทึก";
    btn.disabled = !formReady();

    if (btn.disabled) {
      btn.title = "กรอกข้อมูลให้ครบก่อนดูผล";
    } else {
      btn.title = "กดเพื่อเปิดผลตรวจและบันทึกเข้า Tracker";
    }
  }

  function hideFinalResultIfLocked() {
    let unlocked = false;
    try {
      unlocked = typeof resultUnlocked !== "undefined" && resultUnlocked === true;
    } catch (e) {}

    if (unlocked) {
      styleMainCTA();
      return;
    }

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
    if (decEl) decEl.className = "result-decision empty";
    if (decTxt) decTxt.textContent = "กดดูผลเพื่อตรวจสินค้า";
    if (msg) msg.textContent = "ระบบกรอกข้อมูลให้แล้ว แต่ผลตรวจจะเปิดหลังจากกดดูผลและบันทึกเท่านั้น";

    if (benchmark) benchmark.classList.remove("active");
    if (actionPlan) actionPlan.classList.remove("active");
    if (upsell) upsell.classList.remove("active");

    styleMainCTA();
  }

  if (typeof updateAll === "function" && !window.__legoOneButtonUpdatePatched) {
    const oldUpdateAll = updateAll;

    updateAll = function patchedUpdateAll() {
      const result = oldUpdateAll.apply(this, arguments);
      setTimeout(hideFinalResultIfLocked, 0);
      return result;
    };

    window.__legoOneButtonUpdatePatched = true;
  }

  if (!window.__legoOneButtonInputPatched) {
    document.addEventListener("input", function(e) {
      if (!e.target || !e.target.matches("input")) return;

      try {
        if (typeof resultUnlocked !== "undefined") resultUnlocked = false;
        document.body.classList.add("result-locked");
      } catch (err) {}

      setTimeout(hideFinalResultIfLocked, 0);
    });

    window.__legoOneButtonInputPatched = true;
  }

  if (typeof applyAutofillData === "function" && !window.__legoOneButtonAutofillPatched) {
    const oldApplyAutofillData = applyAutofillData;

    applyAutofillData = function patchedApplyAutofillData() {
      try {
        if (typeof resultUnlocked !== "undefined") resultUnlocked = false;
        document.body.classList.add("result-locked");
      } catch (e) {}

      const result = oldApplyAutofillData.apply(this, arguments);

      try {
        if (typeof resultUnlocked !== "undefined") resultUnlocked = false;
        document.body.classList.add("result-locked");
      } catch (e) {}

      setTimeout(hideFinalResultIfLocked, 0);
      return result;
    };

    window.__legoOneButtonAutofillPatched = true;
  }

  if (typeof saveProduct === "function" && !window.__legoOneButtonSavePatched) {
    const oldSaveProduct = saveProduct;

    saveProduct = function patchedSaveProduct() {
      if (!formReady()) {
        if (typeof showToast === "function") {
          showToast("กรอกข้อมูลให้ครบก่อนดูผล");
        } else {
          alert("กรอกข้อมูลให้ครบก่อนดูผล");
        }
        styleMainCTA();
        return;
      }

      try {
        if (typeof resultUnlocked !== "undefined") resultUnlocked = true;
        document.body.classList.remove("result-locked");
      } catch (e) {}

      if (typeof updateAll === "function") updateAll();

      return oldSaveProduct.apply(this, arguments);
    };

    window.__legoOneButtonSavePatched = true;
  }

  setTimeout(function() {
    styleMainCTA();
    hideFinalResultIfLocked();
  }, 0);

  setInterval(function() {
    hideFinalResultIfLocked();
  }, 500);
})();
`;

if (html.includes("ONE BUTTON RESULT + SAVE PATCH")) {
  console.log("already patched");
} else {
  html = html.replace("</script>", patch + "\n</script>");
  fs.writeFileSync(filePath, html, "utf8");
  console.log("DONE: one button result + save patched");
}
