/**
 * Keystone Logo Engraving Proof — Cloudflare Worker
 *
 * Static files in /public are served automatically (index.html).
 * This Worker handles:
 *   GET  /api/config         public settings for the page (Turnstile site key)
 *   POST /api/send           Turnstile check -> files to R2 (temporary) -> webhook to Zapier
 *   GET  /files/<id>/<name>  lets the Zap download the attachments: signed PDF, sized logo, original logo
 *
 * Files are kept only long enough for Zapier to attach them. Add an R2 lifecycle rule on the
 * bucket to delete objects after a few days (see README).
 *
 * Bindings / variables (wrangler.jsonc or the dashboard):
 *   PROOF_FILES           R2 bucket for the temporary attachments
 *   ZAPIER_HOOK_URL       Secret. The Zap's "Webhooks by Zapier -> Catch Hook" URL
 *   TURNSTILE_SITE_KEY    public site key of the Turnstile widget
 *   TURNSTILE_SECRET_KEY  Secret. Secret key of the same widget
 *   ADMIN_KEY             Secret, optional. Opening the page as /?admin=<ADMIN_KEY> lets Keystone
 *                         staff send a proof without a customer signature.
 */

const MAX_TOTAL_BYTES = 40 * 1048576;          // Gmail attachments: 25 MB total; the page limits logos to 15 MB
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "tif", "tiff", "pdf", "eps", "ai"]);
const CONTENT_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", eps: "application/postscript", ai: "application/postscript",
};
const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "logo-proof";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") {
      const key = String(env.TURNSTILE_SITE_KEY || "");
      const admin = isAdminKey(url.searchParams.get("admin"), env);
      return new Response(JSON.stringify({ turnstileSiteKey: key.startsWith("PASTE_") ? "" : key, admin }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/send") {
      if (request.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
      try {
        return await handleSend(request, env, url);
      } catch (err) {
        console.error("send failed", err?.message || err);
        return json({ ok: false, error: "The proof couldn't be sent" }, 502);
      }
    }
    if (url.pathname.startsWith("/files/")) return handleFile(url, env);
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------- send */

async function handleSend(request, env, url) {
  if (!env.PROOF_FILES) return json({ ok: false, error: "File storage isn't set up on the server" }, 500);
  if (!env.ZAPIER_HOOK_URL) return json({ ok: false, error: "The Zapier webhook isn't set up on the server" }, 500);

  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > MAX_TOTAL_BYTES + 1048576) return json({ ok: false, error: "Upload is too large" }, 413);

  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: "Expected a form upload" }, 400); }
  let meta;
  try { meta = JSON.parse(form.get("meta") || "{}"); } catch { return json({ ok: false, error: "Bad form data" }, 400); }

  // honeypot: bots fill the hidden "website" field. Pretend it worked.
  if (meta.website) return json({ ok: true });

  // Cloudflare Turnstile: nothing goes to Zapier unless Cloudflare confirms the check passed
  const bot = await verifyTurnstile(String(form.get("turnstileToken") || ""), request, env);
  if (!bot.ok) return json({ ok: false, error: bot.error }, bot.status);

  const clean = (v, n = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  const m = {
    company: clean(meta.company, 120),
    customerNumber: clean(meta.customerNumber, 20),
    contact: clean(meta.contact, 120),
  };
  if (!m.company || !m.customerNumber || !m.contact)
    return json({ ok: false, error: "Company, customer number and name are required" }, 400);
  if (!/^\d+$/.test(m.customerNumber)) return json({ ok: false, error: "Customer number must be numbers only" }, 400);

  // signature: required, unless the request came from a valid admin link
  const adminKey = form.get("adminKey");
  const admin = adminKey != null && isAdminKey(String(adminKey), env);
  if (adminKey != null && !admin) return json({ ok: false, error: "This admin link isn't valid" }, 403);
  const signed = meta.signed === true;
  if (!signed && !admin) return json({ ok: false, error: "Sign the proof to approve it" }, 400);

  const proof = form.get("proof");
  const file = form.get("file");
  const sized = form.get("sized");                          // trimmed logo at the chosen size (PNG with DPI set)
  if (!(proof instanceof File) || !proof.size) return json({ ok: false, error: "No signed proof received" }, 400);
  if (!(file instanceof File) || !file.size) return json({ ok: false, error: "No logo file received" }, 400);
  if (!(sized instanceof File) || !sized.size) return json({ ok: false, error: "No sized logo received" }, 400);
  if (proof.size + file.size + sized.size > MAX_TOTAL_BYTES) return json({ ok: false, error: "Files are too large" }, 413);
  const sizedHead = new Uint8Array(await sized.slice(0, 8).arrayBuffer());
  if (!(sizedHead[0] === 0x89 && sizedHead[1] === 0x50 && sizedHead[2] === 0x4e && sizedHead[3] === 0x47)) return json({ ok: false, error: "Sized logo isn't a PNG" }, 415);

  const proofHead = new Uint8Array(await proof.slice(0, 5).arrayBuffer());
  if (new TextDecoder().decode(proofHead) !== "%PDF-") return json({ ok: false, error: "Proof isn't a PDF" }, 415);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return json({ ok: false, error: "File type not accepted" }, 415);
  if (!magicOk(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))) return json({ ok: false, error: "File contents don't match an accepted type" }, 415);

  // ---- summary for the email
  const a = {
    verdict: clean(meta.verdict, 10),
    size: meta.widthFrac && meta.heightFrac ? `${clean(meta.widthFrac, 20)} wide × ${clean(meta.heightFrac, 20)} tall` : "",
    dpi: meta.vector ? "vector (any size)" : meta.effectiveDpi ? `${Number(meta.effectiveDpi).toLocaleString("en-US")} DPI` : "PDF with placed image",
    pixels: meta.logoPixelWidth ? `${meta.logoPixelWidth} × ${meta.logoPixelHeight} px logo` : "",
    padding: Number(meta.paddingTrimmedPct) > 0 ? `${Number(meta.paddingTrimmedPct)}% empty space trimmed from file` : "",
    fileDpi: meta.fileDpi ? `${meta.fileDpi} DPI saved in file` : "no DPI saved in file",
    checks: (Array.isArray(meta.checks) ? meta.checks : []).slice(0, 30).map(c => ({ status: clean(c.status, 8), title: clean(c.title, 160), detail: clean(c.detail, 400) })),
  };
  const lowRes = meta.lowRes === true;
  const short = meta.widthFrac && meta.heightFrac ? ` (${clean(meta.widthFrac, 20)} × ${clean(meta.heightFrac, 20)})` : "";
  const kind = signed ? "Signed logo proof" : "UNSIGNED logo proof (Keystone admin)";
  const subject = `${kind}${lowRes ? " (BELOW 600 DPI)" : ""}: ${m.customerNumber} ${m.company}${short}`;
  const rows = [
    ["Customer #", m.customerNumber], ["Company", m.company], ["Contact", m.contact],
    ["Engraved size", a.size], ["Resolution", a.dpi],
    ["Sized logo", meta.sizedPixels ? `${clean(meta.sizedPixels, 30)} px at ${Number(meta.sizedDpi) || 1200} DPI (opens at the engraved size)` : ""],
    ["Logo file", `${clean(file.name, 120)} (${(file.size / 1048576).toFixed(2)} MB) · ${a.pixels} · ${a.fileDpi}`],
    ["Cropping", a.padding], ["Quality check", a.verdict],
    ["Signed", signed ? `${clean(meta.proofDate, 12)}${admin ? " (on the admin link)" : ""}` : "No customer signature. Sent by Keystone using the admin link."],
  ].filter(([, v]) => v);
  const issues = a.checks.filter(c => c.status === "note" || c.status === "fail");
  const lowResLine = `Below the 600 DPI minimum (${a.dpi} at ${a.size}). The customer was warned and chose to send it anyway. Check the file or ask for a better one before engraving.`;
  const html = `<div style="font:15px/1.45 Arial,Helvetica,sans-serif;color:#1c1f21">
${lowRes ? `<p style="background:#f7e1de;border-left:6px solid #a3241a;padding:10px 12px"><b style="color:#a3241a">${esc(lowResLine)}</b></p>` : ""}
${signed ? "" : `<p style="background:#e8eef4;border-left:6px solid #3d5a73;padding:10px 12px"><b>Not signed by the customer.</b> This proof was sent by Keystone staff using the admin link.</p>`}
<p><b>${esc(m.contact)}</b> at <b>${esc(m.company)}</b> ${signed ? "signed a laser engraving proof" : "sent a laser engraving proof"}. Attached: the ${signed ? "signed " : ""}proof PDF, the logo resized to the engraved size, and the original file.</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #ccc">
${rows.map(([k, v]) => `<tr><td style="background:#f2f3f2;border:1px solid #ccc;font-weight:bold;white-space:nowrap">${esc(k)}</td><td style="border:1px solid #ccc">${esc(v)}</td></tr>`).join("\n")}
</table>
${issues.length ? `<p style="margin-top:16px"><b>Items to review</b></p><ul>${issues.map(c => `<li><b>${c.status === "fail" ? "Problem" : "Note"}: ${esc(c.title)}</b>${c.detail ? `<br>${esc(c.detail)}` : ""}</li>`).join("")}</ul>` : `<p style="margin-top:16px">All automatic checks passed.</p>`}
</div>`;
  const text = [
    ...(lowRes ? [lowResLine.toUpperCase(), ""] : []),
    ...(signed ? [] : ["NOT SIGNED BY THE CUSTOMER. Sent by Keystone staff using the admin link.", ""]),
    `${m.contact} at ${m.company} ${signed ? "signed" : "sent"} a laser engraving proof. Attached: the ${signed ? "signed " : ""}proof PDF, the logo resized to the engraved size, and the original file.`, "",
    ...rows.map(([k, v]) => `${k}: ${v}`), "",
    issues.length ? "Items to review:\n" + issues.map(c => `- ${c.status === "fail" ? "Problem" : "Note"}: ${c.title}${c.detail ? ` (${c.detail})` : ""}`).join("\n") : "All automatic checks passed.",
  ].join("\n");

  // ---- park the two files in R2 under an unguessable id so the Zap can attach them
  const id = crypto.randomUUID();
  const base = slug(`${m.customerNumber} ${m.company}`) || "customer";
  const stamp = new Date().toISOString().slice(0, 10);
  const proofName = `Logo proof - ${base} - ${stamp}.pdf`;
  const logoName = `Logo original - ${base}.${ext}`;
  const sizeTag = meta.widthIn && meta.heightIn ? `${+Number(meta.widthIn).toFixed(3)} x ${+Number(meta.heightIn).toFixed(3)} in` : "sized";
  const sizedName = `Logo ${sizeTag} - ${base}.png`;
  await env.PROOF_FILES.put(`${id}/${proofName}`, proof, { httpMetadata: { contentType: "application/pdf" } });
  await env.PROOF_FILES.put(`${id}/${logoName}`, file, { httpMetadata: { contentType: CONTENT_TYPES[ext] || "application/octet-stream" } });
  await env.PROOF_FILES.put(`${id}/${sizedName}`, sized, { httpMetadata: { contentType: "image/png" } });
  const link = name => `${url.origin}/files/${id}/${encodeURIComponent(name)}`;

  // ---- hand off to Zapier (flat fields so they're easy to map in the Zap)
  const payload = {
    subject, html, text,
    proofUrl: link(proofName), proofName,
    logoUrl: link(logoName), logoName,
    sizedUrl: link(sizedName), sizedName,
    customerNumber: m.customerNumber, company: m.company, contact: m.contact,
    size: a.size, dpi: a.dpi, verdict: a.verdict, lowRes: lowRes ? "yes" : "no",
    fileName: clean(file.name, 120), signed: signed ? clean(meta.proofDate, 12) : "",
    signedByCustomer: signed ? "yes" : "no", submittedBy: admin ? "admin" : "customer",
    notes: issues.map(c => `${c.status === "fail" ? "Problem" : "Note"}: ${c.title}`).join("\n"),
    receivedAt: new Date().toISOString(),
  };
  let ok = false;
  try {
    const r = await fetch(env.ZAPIER_HOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    ok = r.ok;
    if (!ok) console.error("zapier responded", r.status, await r.text().catch(() => ""));
  } catch (err) { console.error("zapier unreachable", err?.message || err); }
  if (!ok) {
    await env.PROOF_FILES.delete([`${id}/${proofName}`, `${id}/${logoName}`, `${id}/${sizedName}`]).catch(() => {});
    return json({ ok: false, error: "The proof couldn't be passed to Keystone" }, 502);
  }
  return json({ ok: true });
}

/* ------------------------------------------------------------------ files */

async function handleFile(url, env) {
  const parts = url.pathname.split("/");                    // ["", "files", id, name]
  if (parts.length !== 4 || !ID_RE.test(parts[2]) || !env.PROOF_FILES) return new Response("Not found", { status: 404 });
  let name;
  try { name = decodeURIComponent(parts[3]); } catch { return new Response("Not found", { status: 404 }); }
  if (!name || name.includes("/") || name.includes("..")) return new Response("Not found", { status: 404 });
  const obj = await env.PROOF_FILES.get(`${parts[2]}/${name}`);
  if (!obj) return new Response("This file has expired or doesn't exist.", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-disposition", `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex");
  return new Response(obj.body, { headers });
}

/* ---------------------------------------------------------------- helpers */

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, status: 500, error: "The security check isn't set up on the server" };
  if (!token || token.length > 2048) return { ok: false, status: 403, error: "Complete the security check" };
  let v;
  try {
    const r = await fetch(env.TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    v = await r.json();
  } catch (err) {
    console.error("turnstile verify failed", err);
    return { ok: false, status: 502, error: "Couldn't reach the security check. Try again" };
  }
  if (!v.success) {
    console.warn("turnstile rejected", v["error-codes"]);
    const expired = (v["error-codes"] || []).some(c => c === "timeout-or-duplicate");
    return { ok: false, status: 403, error: expired ? "The security check expired. Complete it again" : "The security check failed. Complete it again" };
  }
  if (v.action && v.action !== TURNSTILE_ACTION) return { ok: false, status: 403, error: "The security check failed. Complete it again" };
  return { ok: true };
}
function magicOk(b) {
  const s = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0x89 && s(1, 3) === "PNG") return true;
  if (b[0] === 0xff && b[1] === 0xd8) return true;
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return true;
  if (s(0, b.length).includes("%PDF-")) return true;
  if (s(0, 4) === "%!PS") return true;
  if (b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6) return true;
  return false;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const SLUG_TRANSLIT = { "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ı": "i", "&": " and " };
function slug(s) {                                          // filename-safe: letters, digits, spaces
  const t = [...String(s || "")].map(ch => SLUG_TRANSLIT[ch] ?? ch).join("");
  return t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, " ").trim().slice(0, 60).trim();
}
function isAdminKey(given, env) {                           // constant-time compare against the ADMIN_KEY secret
  const want = String(env.ADMIN_KEY || "");
  if (!given || want.length < 12) return false;
  const a = new TextEncoder().encode(String(given)), b = new TextEncoder().encode(want);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
function asciiName(s) {
  return String(s || "file").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 150);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
