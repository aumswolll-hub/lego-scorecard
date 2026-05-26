const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

const backupPath = path.join(process.cwd(), "index.backup-before-remove-save-confirm.html");
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
}

// Remove native confirm popup after saveProduct()
const patterns = [
  /if \(confirm\(`บันทึก "\$\{name\}" แล้ว ✓\\n\\nผลลัพธ์: \$\{record\.decision\} \(\$\{record\.total\}\/\$\{record\.max\} = \$\{Math\.round\(record\.pct\*100\)\}%\)\\n\\nต้องการล้างข้อมูลเพื่อตรวจสินค้าตัวต่อไปมั้ย\?`\)\) clearForm\(\);/g,
  /if \(confirm\(`บันทึก "\$\{name\}" แล้ว ✓[\s\S]*?clearForm\(\);/g
];

let changed = false;

for (const p of patterns) {
  if (p.test(html)) {
    html = html.replace(p, `// confirm popup removed for cleaner UX`);
    changed = true;
  }
}

if (!changed) {
  console.log("ไม่เจอ confirm แบบเดิม — จะใส่ patch ปิด confirm เฉพาะ saveProduct แทน");

  const jsPatch = `
/* ── REMOVE SAVE CONFIRM POPUP PATCH ── */
(function removeSaveConfirmPopupPatch() {
  if (typeof saveProduct === "function" && !window.__removeSaveConfirmPatched) {
    const originalSaveProductForNoConfirm = saveProduct;

    saveProduct = function patchedSaveProductNoConfirm() {
      const originalConfirm = window.confirm;

      window.confirm = function(message) {
        if (typeof message === "string" && message.includes("ต้องการล้างข้อมูล")) {
          return false;
        }
        return originalConfirm.apply(window, arguments);
      };

      try {
        return originalSaveProductForNoConfirm.apply(this, arguments);
      } finally {
        setTimeout(function() {
          window.confirm = originalConfirm;
        }, 0);
      }
    };

    window.__removeSaveConfirmPatched = true;
  }
})();
`;

  if (!html.includes("REMOVE SAVE CONFIRM POPUP PATCH")) {
    html = html.replace("</script>", jsPatch + "\n</script>");
    changed = true;
  }
}

fs.writeFileSync(filePath, html, "utf8");
console.log("DONE: removed save confirm popup");
console.log("Backup:", backupPath);
