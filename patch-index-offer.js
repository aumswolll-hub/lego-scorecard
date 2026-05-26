const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");
const backupPath = path.join(process.cwd(), "index.backup-before-offer-patch.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html — ให้รันไฟล์นี้ใน root project ที่มี index.html");
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

// 1) Replace METHOD URL config + checkout helpers
replaceOnce(
  "METHOD URL config",
`const METHOD_BASE_URL = "https://buy.stripe.com/8x25kEcVqeUw2SL8mo9oc09";
const METHOD_FULL_PRICE_URL = "https://buy.stripe.com/eVqeVe5sYh2E3WPauw9oc04";
const METHOD_PROMO_CODE = "method1990";

// Scanner standalone purchase (paywall option 1)`,
`const METHOD_CHECKOUT_URL = "https://buy.stripe.com/eVqeVe5sYh2E3WPauw9oc04";
const METHOD_CREDIT_CHECKOUT_URL = "https://buy.stripe.com/8x25kEcVqeUw2SL8mo9oc09";
const METHOD_PROMO_CODE = "method1990";

// Keep old names for compatibility
const METHOD_BASE_URL = METHOD_CREDIT_CHECKOUT_URL;
const METHOD_FULL_PRICE_URL = METHOD_CHECKOUT_URL;

// Scanner standalone purchase (paywall option 1)`
);

replaceFunction("methodUrlWithCoupon", `function methodUrlWithCoupon() {
  if (!METHOD_CREDIT_CHECKOUT_URL) return METHOD_CHECKOUT_URL;

  const sep = METHOD_CREDIT_CHECKOUT_URL.includes("?") ? "&" : "?";
  return METHOD_CREDIT_CHECKOUT_URL + sep + "prefilled_promo_code=" + encodeURIComponent(METHOD_PROMO_CODE);
}`);

replaceFunction("methodUrlFullPrice", `function methodUrlFullPrice() {
  return METHOD_CHECKOUT_URL || METHOD_CREDIT_CHECKOUT_URL || "#";
}

function isScannerPaidOnly() {
  if (!usageState) return false;

  return (
    (usageState.plan === "scanner_paid" || usageState.state === "paid_scanner") &&
    !usageState.is_lego_method_student &&
    usageState.plan !== "lego_method" &&
    usageState.plan !== "admin" &&
    !usageState.is_admin
  );
}

function shouldUseMethodCredit() {
  return isScannerPaidOnly() && getCreditRemainingMs() > 0;
}

function getMethodCheckoutUrl() {
  return shouldUseMethodCredit() ? methodUrlWithCoupon() : methodUrlFullPrice();
}`);

// 2) showApp: don't start countdown before usageState is loaded
replaceOnce(
  "remove early initCreditTimer in showApp",
`  initCreditTimer();
  updateDashBanner();`,
`  // initCreditTimer() must run after usageState is loaded
  updateDashBanner();`
);

// 3) applyUsageStateToUI: init countdown after usage state is known
replaceFunction("applyUsageStateToUI", `function applyUsageStateToUI() {
  if (!usageState) return;

  updateScanCounter();
  initCreditTimer();
  updateDashBanner();

  // ถ้าครบ limit + ไม่จ่าย → แสดง paywall
  if (usageState.state === "free_limit_reached") {
    showPaywall();
  }

  // student → ซ่อน hard upsell
  if (usageState.is_lego_method_student) {
    document.querySelectorAll(".upsell-hide-for-student").forEach(el => el.style.display = "none");
  }
}`);

// 4) Countdown logic: only scanner_paid gets upgrade credit
replaceFunction("isCreditActive", `function isCreditActive() {
  return isScannerPaidOnly() && !hasPurchasedMethod() && getCreditRemainingMs() > 0;
}`);

replaceFunction("initCreditTimer", `function initCreditTimer() {
  const banner = document.getElementById("creditBanner");

  if (!isScannerPaidOnly()) {
    if (banner) banner.classList.add("hidden");
    return;
  }

  if (hasPurchasedMethod()) {
    if (banner) banner.classList.add("hidden");
    return;
  }

  getCreditStartTime();
  tickCreditTimer();

  if (!window.__legoCreditTimerStarted) {
    window.__legoCreditTimerStarted = true;
    setInterval(tickCreditTimer, 1000);
  }
}`);

replaceFunction("refreshUpgradeButton", `function refreshUpgradeButton() {
  const modalBtn = document.getElementById("modalCreditBtn");
  const modalBox = document.getElementById("modalCreditBox");
  const priceEl  = document.getElementById("modalPriceAmount");
  const promoDisplay = document.getElementById("promoDisplay");
  const disclaimer   = document.getElementById("creditDisclaimer");
  const modalT   = document.getElementById("modalCreditTimer");

  const creditEligible = isScannerPaidOnly();
  const ms = creditEligible ? getCreditRemainingMs() : 0;
  const expired = !creditEligible || ms <= 0;

  const promoText = document.getElementById("promoCodeText");
  if (promoText) promoText.textContent = METHOD_PROMO_CODE;

  if (modalT) {
    if (!creditEligible) modalT.textContent = "ใช้ได้เฉพาะลูกค้า Scanner";
    else modalT.textContent = expired ? "เครดิตหมดอายุแล้ว" : formatCreditTimer(ms);
  }

  if (expired) {
    if (priceEl) priceEl.textContent = METHOD_PRICE_DISPLAY;
    if (modalBox) modalBox.classList.add("expired");
    if (promoDisplay) promoDisplay.classList.add("expired");

    if (modalBtn) {
      modalBtn.setAttribute("href", getMethodCheckoutUrl());
      modalBtn.classList.remove("expired");
      modalBtn.textContent = "เข้า LEGO METHOD →";
    }

    if (disclaimer) {
      disclaimer.textContent = creditEligible
        ? "เครดิตหมดอายุ — สามารถซื้อราคาเต็มได้"
        : "ถ้าคุณต้องการระบบเต็มตั้งแต่เลือกสินค้าไปจนถึงทำคลิป ให้เข้า LEGO METHOD";
    }
  } else {
    if (priceEl) priceEl.textContent = "7,000";
    if (modalBox) modalBox.classList.remove("expired");
    if (promoDisplay) promoDisplay.classList.remove("expired");

    if (modalBtn) {
      modalBtn.setAttribute("href", getMethodCheckoutUrl());
      modalBtn.textContent = "ใช้เครดิตเข้า LEGO METHOD →";
    }

    if (disclaimer) disclaimer.textContent = "ไม่ใช่ส่วนลด — คือเงิน Scanner ที่คุณจ่ายไปแล้ว ใช้ต่อให้คุ้ม";
  }
}`);

// 5) Paywall link + copy logic
replaceFunction("showPaywall", `function showPaywall() {
  const sp = document.getElementById("pwScannerPrice");
  const mp = document.getElementById("pwMethodPrice");
  const scannerBtn = document.getElementById("pwScannerBtn");
  const methodBtn = document.getElementById("pwMethodBtn");

  if (sp) sp.textContent = SCANNER_PRICE;

  const hasCredit = shouldUseMethodCredit();

  if (mp) mp.textContent = hasCredit ? "7,000" : METHOD_PRICE_DISPLAY;

  if (scannerBtn) {
    scannerBtn.setAttribute("href", SCANNER_CHECKOUT_URL || "#");
  }

  if (methodBtn) {
    methodBtn.setAttribute("href", getMethodCheckoutUrl() || "#");
    methodBtn.textContent = hasCredit
      ? "ใช้เครดิตเข้า LEGO METHOD →"
      : "เข้า LEGO METHOD →";
  }

  const tag = document.querySelector(".paywall-tag");
  const title = document.querySelector(".paywall-title");
  const sub = document.querySelector(".paywall-sub");

  if (usageState?.plan === "scanner_paid" || usageState?.state === "paid_scanner") {
    if (tag) tag.textContent = "ถึงเวลาต่อยอด";
    if (title) title.innerHTML = \`คุณเลือกสินค้าได้แล้ว<em> อย่าจบแค่ Scanner</em>\`;
    if (sub) sub.textContent = "ใช้เครดิต Scanner ที่จ่ายไปแล้ว อัปเกรดเป็น LEGO METHOD เพื่อได้ระบบทำคลิปเต็ม";
  } else {
    if (tag) tag.textContent = "ใช้ครบ 3 SCANS ฟรีแล้ว";
    if (title) title.innerHTML = \`เลือกสินค้าต่อ<em> แบบไม่เดา</em>\`;
    if (sub) sub.textContent = "ถ้าจะคัดสินค้าต่อแบบจริงจัง เลือกแผนที่ใช่สำหรับคุณ";
  }

  document.getElementById("paywallOverlay").classList.add("active");
  document.body.style.overflow = "hidden";

  trackEvent("scanner_paywall_viewed", {
    plan: usageState?.plan || "unknown",
    state: usageState?.state || "unknown",
    credit_active: hasCredit
  });
}`);

replaceFunction("handlePaywallMethod", `function handlePaywallMethod(e) {
  if (e) e.preventDefault();

  trackEvent("lego_method_checkout_clicked", {
    plan: usageState?.plan || "unknown",
    state: usageState?.state || "unknown",
    credit_active: shouldUseMethodCredit()
  });

  const url = getMethodCheckoutUrl();

  if (url && url !== "#") {
    window.open(url, "_blank", "noopener");
  } else if (LINE_FALLBACK_URL) {
    window.open(LINE_FALLBACK_URL, "_blank", "noopener");
  } else {
    showToast("ระบบชำระเงินกำลังเชื่อมต่อ กรุณาทัก LINE เพื่อสมัคร LEGO METHOD");
  }

  return false;
}`);

// 6) Upgrade modal button click guard
replaceFunction("handleUpgradeClick", `function handleUpgradeClick(e) {
  refreshUpgradeButton();

  const btn = document.getElementById("modalCreditBtn");
  const url = btn.getAttribute("href") || getMethodCheckoutUrl();

  console.log("Upgrade button clicked", {
    plan: usageState?.plan || "unknown",
    state: usageState?.state || "unknown",
    credit_active: shouldUseMethodCredit(),
    url
  });

  if (!url || url === "#") {
    e.preventDefault();
    const fallback = getMethodCheckoutUrl();
    window.open(fallback, "_blank", "noopener");
    return false;
  }

  return true;
}`);

// 7) Paywall benefits copy
replaceOnce(
  "Scanner paywall benefits",
`<ul class="pc-benefits">
          <li>สแกนสินค้าได้ <strong>100 scans/เดือน</strong></li>
          <li>เห็นคะแนนเต็มทั้ง 7 จุด</li>
          <li>บันทึกประวัติสินค้า + Tracker</li>
          <li>เรียงลำดับสินค้าที่ควรทำก่อน</li>
          <li>ดูความแม่นในการเลือกสินค้า</li>
          <li>ใช้ข้ามเครื่อง ข้อมูลไม่หาย</li>
        </ul>`,
`<ul class="pc-benefits">
          <li>สแกนสินค้าได้ <strong>100 scans/เดือน</strong></li>
          <li>เห็นคะแนนเต็มทั้ง 7 จุด</li>
          <li>บันทึกประวัติสินค้า + Tracker</li>
          <li>เรียงลำดับสินค้าที่ควรทำก่อน</li>
          <li>ลดความเสี่ยงก่อนเสียเวลาถ่ายคลิป</li>
          <li>เหมาะกับคนที่อยากคัดสินค้าให้แม่นขึ้น</li>
        </ul>`
);

replaceOnce(
  "Method paywall benefits",
`<ul class="pc-benefits">
          <li><strong>ได้ LEGO SCANNER 300 scans/เดือน</strong></li>
          <li>ระบบเลือกสินค้า test / scale / drop</li>
          <li>ระบบคิดมุมคลิปจากสินค้า</li>
          <li>โครงสร้าง Hook / Body / CTA</li>
          <li>ระบบ test 3-5 คลิปต่อสินค้า</li>
          <li>อ่านสัญญาณว่าควรหยุดหรือ scale</li>
        </ul>`,
`<ul class="pc-benefits">
          <li><strong>ได้ LEGO SCANNER 300 scans/เดือน</strong></li>
          <li>เรียนระบบเลือกสินค้าแบบไม่เดา</li>
          <li>เรียนวิธีแตกสินค้าเป็น angle ที่ขายได้</li>
          <li>ได้โครงสร้าง Hook / Body / CTA สำหรับคลิปขายของ</li>
          <li>ได้ระบบทำ 3-5 คลิปทดสอบต่อสินค้า</li>
          <li>เรียนวิธีอ่านผลหลังลงคลิป ว่าควรหยุดหรือ scale</li>
          <li>เรียนผ่านวิดีโอ + ตัวอย่างจริง + framework ที่ทำตามได้</li>
          <li>เหมาะกับคนที่ไม่อยากแค่สแกน แต่อยากทำเงินจริงจากสินค้านั้น</li>
        </ul>`
);

// 8) Upgrade modal explanation
replaceOnce(
  "Method explanation paragraph",
`      <h2 class="serif">ระบบเต็มของ <em>LEGO METHOD</em></h2>
      <div class="modules-grid">`,
`      <h2 class="serif">ระบบเต็มของ <em>LEGO METHOD</em></h2>
      <p><strong>LEGO METHOD ไม่ใช่คอร์สที่ให้ดูเฉย ๆ แล้วจบ</strong> แต่เป็นระบบปฏิบัติการสำหรับ TikTok Shop affiliate ที่พาคุณไล่ตั้งแต่เลือกสินค้า → วิเคราะห์สัญญาณ → คิดมุมคลิป → เขียน hook → ทำคลิปทดสอบ → อ่านผล → ตัดสินใจว่าจะ scale หรือทิ้ง</p>
      <p>คุณจะเรียนเป็นวิดีโอสั้น ๆ แบบลงมือทำตามได้ ใช้คู่กับ SCANNER และ Tracker เพื่อเอาสินค้าที่ผ่านคะแนนไปต่อเป็นแผนคอนเทนต์จริง ไม่ใช่แค่รู้ว่าสินค้าน่าเล่นแล้วจบ</p>
      <div class="modules-grid">`
);

replaceOnce(
  "FAQ method learning",
`      <h2 class="serif">คำถามที่<em> เจอบ่อย</em></h2>
      <div class="faq-item">
        <div class="faq-q">ถ้าซื้อ LEGO METHOD ตอนนี้ จะได้ทุกอย่างใน SCANNER ด้วยมั้ย?</div>`,
`      <h2 class="serif">คำถามที่<em> เจอบ่อย</em></h2>
      <div class="faq-item">
        <div class="faq-q">เรียน LEGO METHOD ยังไง?</div>
        <div class="faq-a">เรียนผ่านวิดีโอ + framework + ตัวอย่างจริง คุณดูเป็นลำดับ แล้วเอาสินค้าที่ผ่านจาก SCANNER ไปทำตามระบบ ตั้งแต่แตก angle, เขียน hook, วาง script, ทำ 3-5 คลิปทดสอบ และอ่านผลหลังลง</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">ซื้อ METHOD แล้วต้องทำอะไรต่อ?</div>
        <div class="faq-a">เริ่มจากใช้ SCANNER เลือกสินค้า 1 ตัวที่ผ่าน จากนั้นเข้า module Content Architecture เพื่อแตก angle แล้วใช้ Speed-to-Post ทำคลิปชุดแรกภายใน 48 ชั่วโมง แล้วกลับมาอ่านผลด้วยระบบ Test & Evaluate</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">ต่างจากซื้อ Scanner อย่างเดียวตรงไหน?</div>
        <div class="faq-a">Scanner บอกว่าสินค้าไหนควรทำ แต่ METHOD สอนว่าหลังจากเจอสินค้าที่ควรทำแล้ว ต้องทำคลิปยังไง ทดสอบยังไง และ scale ยังไง Scanner คือเครื่องมือเลือกสนามรบ ส่วน METHOD คือระบบทำให้คุณเล่นเกมนั้นเป็น</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">ถ้าซื้อ LEGO METHOD ตอนนี้ จะได้ทุกอย่างใน SCANNER ด้วยมั้ย?</div>`
);

// 9) Auto-fill usage text: remove "unlimited" for paid plans
replaceOnce(
  "autofill unlimited copy",
`    } else if (result.usage && result.usage.unlimited) {
      usageTxt = \`<div class="af-usage">✦ METHOD member — ไม่จำกัด</div>\`;
    }`,
`    } else if (result.usage && result.usage.unlimited) {
      usageTxt = \`<div class="af-usage">✦ Admin — Unlimited</div>\`;
    }`
);

// 10) Optional: improve Scanner paid sidebar copy subtly without touching layout
replaceOnce(
  "scanner sidebar tagline",
`        <div class="upsell-tagline">ระบบที่นักขายจริงใช้</div>`,
`        <div class="upsell-tagline">Scanner คือจุดเริ่ม — Method คือระบบที่พาไปขายจริง</div>`
);

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("✅ DONE: index.html patched successfully");
console.log("✅ Backup:", backupPath);
console.log("");
console.log("Next:");
console.log("1) Deploy / Redeploy Vercel");
console.log("2) Test free user after 3 scans → LEGO METHOD button should open checkout");
console.log("3) Test scanner_paid user → credit countdown should show");
console.log("4) Test free/admin/lego_method → countdown should NOT show unless scanner_paid");
