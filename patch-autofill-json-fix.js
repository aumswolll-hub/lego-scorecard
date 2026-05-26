const fs = require("fs");
const path = require("path");

const filePath = path.join(process.cwd(), "index.html");
const backupPath = path.join(process.cwd(), "index.backup-before-autofill-json-fix.html");

if (!fs.existsSync(filePath)) {
  throw new Error("ไม่เจอ index.html");
}

let html = fs.readFileSync(filePath, "utf8");

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, html, "utf8");
  console.log("backup created:", backupPath);
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
    throw new Error("cannot find end for " + functionName);
  }

  html = html.slice(0, start) + replacement + html.slice(end);
  console.log("patched function:", functionName);
}

replaceFunction("fileToBase64", `function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));

    reader.onload = () => {
      const img = new Image();

      img.onerror = () => reject(new Error("ไฟล์รูปนี้เปิดไม่ได้ ลองใช้ JPG/PNG หรือ screenshot ใหม่"));

      img.onload = () => {
        const MAX = 1100;
        let { width, height } = img;

        if (width > MAX || height > MAX) {
          if (width > height) {
            height = Math.round(height * MAX / width);
            width = MAX;
          } else {
            width = Math.round(width * MAX / height);
            height = MAX;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
        const base64 = dataUrl.split(",")[1];

        if (!base64 || base64.length < 1000) {
          reject(new Error("แปลงรูปไม่สำเร็จ ลองใช้ screenshot ใหม่"));
          return;
        }

        resolve({
          media_type: "image/jpeg",
          data: base64
        });
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}`);

replaceFunction("handleAutofillFiles", `async function handleAutofillFiles(files) {
  if (!currentSession?.token) {
    afStatus("error", "⚠ ต้อง login ก่อนใช้ auto-fill");
    return;
  }

  const fileArr = Array.from(files).slice(0, 2);
  if (fileArr.length === 0) return;

  if (typeof lockResult === "function") lockResult();

  afStatus("loading", \`<span class="autofill-spinner">⟳</span> กำลังอ่านภาพ \${fileArr.length} ภาพ...\`);

  try {
    const images = await Promise.all(fileArr.map(fileToBase64));

    console.log("[autofill] images prepared:", images.length, "sizes:", images.map(i => Math.round(i.data.length / 1024) + "KB"));

    const res = await fetch("/api/analyze-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": currentSession.token
      },
      body: JSON.stringify({ images }),
    });

    console.log("[autofill] response status:", res.status);

    const rawText = await res.text();
    let result = null;

    try {
      result = rawText ? JSON.parse(rawText) : null;
    } catch (parseErr) {
      console.error("[autofill] non-JSON response:", {
        status: res.status,
        contentType: res.headers.get("content-type"),
        rawPreview: rawText.slice(0, 500)
      });

      let readable = "Server ส่ง response ที่ไม่ใช่ JSON กลับมา";

      if (res.status === 413 || rawText.includes("Payload Too Large")) {
        readable = "รูปใหญ่เกินไป — ลองอัปโหลดทีละ 1 รูป หรือ crop ให้เหลือเฉพาะส่วน Promotion Info";
      } else if (res.status === 504 || rawText.includes("FUNCTION_INVOCATION_TIMEOUT")) {
        readable = "ระบบอ่านภาพใช้เวลานานเกินไป — ลองอัปโหลดรูปที่ชัดและเล็กลง";
      } else if (res.status >= 500) {
        readable = "API อ่านภาพมีปัญหาชั่วคราว — ดู Vercel Logs ที่ /api/analyze-image";
      } else if (res.status === 404) {
        readable = "ไม่เจอ /api/analyze-image — เช็คว่าไฟล์ api/analyze-image.js ยังอยู่";
      }

      afStatus("error",
        \`⚠ อ่านภาพไม่สำเร็จ: \${readable}<br>\` +
        \`<span style="font-size:11px;opacity:0.7">status: \${res.status} · ลอง crop รูปให้ชัด หรือกรอกมือได้ตามปกติ</span>\`
      );
      return;
    }

    console.log("[autofill] result:", result);

    if (res.status === 429) {
      afStatus("error",
        \`⚠ \${result?.message || "ใช้ครบจำนวนครั้งแล้ว"}<br>\` +
        \`<span class="af-upsell" onclick="goToUpgrade(event)">เข้า LEGO METHOD เพื่อใช้ระบบเต็ม →</span>\`
      );
      return;
    }

    if (res.status === 401) {
      afStatus("error", "⚠ Session หมดอายุ — logout แล้ว login ใหม่");
      return;
    }

    if (!res.ok || !result || !result.ok) {
      const detail = result?.message || result?.error || result?.detail || \`status \${res.status}\`;
      afStatus("error",
        \`⚠ อ่านภาพไม่สำเร็จ: \${detail}<br>\` +
        \`<span style="font-size:11px;opacity:0.7">กรอกมือได้ตามปกติ หรือ crop รูปให้เห็นเฉพาะ Promotion Info</span>\`
      );
      return;
    }

    const filled = applyAutofillData(result.data || {});

    let usageTxt = "";
    if (result.usage && !result.usage.unlimited) {
      usageTxt = \`<div class="af-usage">ใช้ไป \${result.usage.used}/\${result.usage.limit} ครั้งเดือนนี้</div>\`;
    } else if (result.usage && result.usage.unlimited) {
      usageTxt = \`<div class="af-usage">✦ Admin — Unlimited</div>\`;
    }

    const legend = \`<div class="autofill-legend"><span><span class="dot gold"></span>ช่องที่ AI กรอกให้</span><span><span class="dot red"></span>ช่องที่ AI ไม่มั่นใจ — เช็คก่อน</span></div>\`;

    if (filled === 0) {
      afStatus("error", \`⚠ อ่านภาพได้ แต่ไม่เจอตัวเลขที่ต้องการ — ลองภาพที่ชัดกว่า หรือกรอกมือ\${usageTxt}\`);
    } else {
      const conf = result.data?.confidence;
      const uncertainCount = (result.data?.uncertain_fields || []).length;

      let confNote = "";

      if (conf === "low" || uncertainCount >= 3) {
        confNote = \` <strong style="color:#F0A8A4">⚠ ภาพอาจไม่ชัด — ตรวจตัวเลขให้ดีก่อนดูผล</strong>\`;
      } else if (conf === "medium" || uncertainCount > 0) {
        confNote = \` — มี \${uncertainCount} ช่องที่ควรเช็ค\`;
      }

      afStatus("success", \`✓ กรอกให้แล้ว \${filled} ช่อง\${confNote}\${legend}\${usageTxt}\`);
    }

    if (typeof applyResultGateUI === "function") applyResultGateUI();

  } catch (e) {
    console.error("[autofill] error:", e);
    afStatus("error", \`⚠ เกิดข้อผิดพลาด: \${e.message || e} — ลอง crop รูปให้เล็กลง หรือกรอกมือ\`);
  }
}`);

fs.writeFileSync(filePath, html, "utf8");

console.log("");
console.log("DONE: autofill JSON fix patched");
console.log("Backup:", backupPath);
