import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import { config } from "../config.js";

const DEFAULT_DOWNLOAD_URL = "https://api.keshavwithvelo.in/downloads/KESHAVWITHVELO-1.1.7.zip";
const DEFAULT_SUBJECT = "Keshav With Velo Update 1.1.7 is Live";
const REPORT_DIR = path.resolve(process.cwd(), "storage", "bulk-email-reports");
const LICENSE_KEY_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseArgs(argv) {
  const args = {
    csv: "",
    dryRun: false,
    send: false,
    only: "",
    limit: 0,
    skipNoKey: false,
    downloadUrl: DEFAULT_DOWNLOAD_URL
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--csv") args.csv = argv[++i] || "";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--send") args.send = true;
    else if (arg === "--only") args.only = normalizeEmail(argv[++i] || "");
    else if (arg === "--limit") args.limit = Number(argv[++i] || 0);
    else if (arg === "--skip-no-key") args.skipNoKey = true;
    else if (arg === "--download-url") args.downloadUrl = argv[++i] || DEFAULT_DOWNLOAD_URL;
  }

  if (!args.send) args.dryRun = true;
  if (args.send && args.dryRun) {
    throw new Error("Use either --send or --dry-run, not both.");
  }
  if (!args.csv) {
    throw new Error('Missing required --csv "/path/to/emails.csv"');
  }
  if (!fs.existsSync(args.csv)) {
    throw new Error(`CSV not found: ${args.csv}`);
  }
  return args;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function maskEmail(email) {
  const normalized = normalizeEmail(email);
  const [name, domain] = normalized.split("@");
  if (!name || !domain) return normalized;
  return `${name.slice(0, 2)}***@${domain}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.trim());
  return rows.map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] || "";
    });
    return record;
  });
}

function isLicenseEmail(row) {
  const subject = String(row.subject || "").toLowerCase();
  const from = String(row.from || "").toLowerCase();
  const event = String(row.last_event || "").toLowerCase();
  if (subject.includes("hello world")) return false;
  if (!from.includes("keshav")) return false;
  if (event && !["delivered", "sent", "opened", "clicked"].includes(event)) return false;
  return subject.includes("license") || subject.includes("activation");
}

function chooseLatestByEmail(rows) {
  const map = new Map();
  const duplicates = [];

  for (const row of rows) {
    const email = normalizeEmail(row.to);
    if (!EMAIL_PATTERN.test(email)) continue;
    const previous = map.get(email);
    const previousTime = Date.parse(previous?.sent_at || previous?.created_at || "") || 0;
    const currentTime = Date.parse(row.sent_at || row.created_at || "") || 0;
    if (!previous || currentTime >= previousTime) {
      if (previous) duplicates.push({ email, keptId: row.id, skippedId: previous.id });
      map.set(email, row);
    } else {
      duplicates.push({ email, keptId: previous.id, skippedId: row.id });
    }
  }

  return { records: [...map.values()], duplicates };
}

async function fetchResendEmail(id) {
  if (!config.resend.apiKey) return { ok: false, reason: "missing_resend_api_key" };

  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      reason: data.message || data.error || `resend_fetch_failed_${response.status}`,
      status: response.status
    };
  }
  return { ok: true, data };
}

function collectTextValues(value, acc = []) {
  if (value == null) return acc;
  if (typeof value === "string") {
    acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextValues(item, acc));
    return acc;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      if (/html|text|body|content|subject|preview|message/i.test(key)) collectTextValues(item, acc);
    });
  }
  return acc;
}

function extractLicenseKey(emailData) {
  const text = collectTextValues(emailData).join("\n").toUpperCase();
  const matches = [...text.matchAll(LICENSE_KEY_PATTERN)].map((match) => match[0]);
  return matches[0] || "";
}

let dbInstance = null;
let dbLoadError = null;

async function getDb() {
  if (dbInstance || dbLoadError) return dbInstance;
  try {
    const module = await import("../db/connection.js");
    dbInstance = module.db;
  } catch (error) {
    dbLoadError = error;
  }
  return dbInstance;
}

async function getDbMatch(email) {
  const db = await getDb();
  if (!db) return null;
  try {
    return db.prepare(`
      SELECT users.id AS user_id, users.name, users.email,
        licenses.id AS license_id, licenses.license_hint, licenses.status,
        licenses.expiry_date, licenses.created_at
      FROM users
      LEFT JOIN licenses ON licenses.user_id = users.id
      WHERE lower(users.email) = lower(?)
      ORDER BY
        CASE licenses.status WHEN 'active' THEN 0 WHEN 'inactive' THEN 1 ELSE 2 END,
        licenses.created_at DESC
      LIMIT 1
    `).get(email);
  } catch (error) {
    if (String(error.message || "").includes("no such table")) return null;
    throw error;
  }
}

function buildUpdateEmail({ name, email, licenseKey, licenseId, licenseHint, downloadUrl }) {
  const displayName = name || email.split("@")[0] || "there";
  const keyBlockText = licenseKey
    ? `Your activation key:\n${licenseKey}\n`
    : "Activation key: use your original purchase email key. If you lost it, reply with your registered email and License ID.\n";
  const keyBlockHtml = licenseKey
    ? `<p><strong>Your activation key:</strong></p><p style="font-size:20px;font-weight:700;letter-spacing:2px">${licenseKey}</p>`
    : `<p><strong>Activation key:</strong><br>Use your original purchase email key. If you lost it, reply with your registered email and License ID.</p>`;

  const text = `Hi ${displayName},

Keshav With Velo update 1.1.7 is live.

Registered email:
${email}

License ID:
${licenseId || "Not found"}

License hint:
${licenseHint || "Not found"}

${keyBlockText}
Latest download:
${downloadUrl}

Install/update steps:
1. Close After Effects completely.
2. Download the latest ZIP.
3. Replace the old KESHAVWITHVELO extension folder with the new one.
4. Open After Effects again.

Important:
- Your license will remain active on the same device.
- Do not delete Adobe CEP/AppData/Library support folders unless support asks.
- One license is for one device unless reset by admin.

Keshav With Velo Support
`;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
      <h2>Keshav With Velo Update 1.1.7</h2>
      <p>Hi ${escapeHtml(displayName)}, the latest Keshav With Velo update is live.</p>
      <p><strong>Registered email:</strong><br>${escapeHtml(email)}</p>
      <p><strong>License ID:</strong><br>${escapeHtml(licenseId || "Not found")}</p>
      <p><strong>License hint:</strong><br>${escapeHtml(licenseHint || "Not found")}</p>
      ${keyBlockHtml}
      <p><strong>Latest download:</strong><br><a href="${escapeHtml(downloadUrl)}">Download Keshav With Velo 1.1.7</a></p>
      <h3>Install/update steps</h3>
      <ol>
        <li>Close After Effects completely.</li>
        <li>Download the latest ZIP.</li>
        <li>Replace the old <strong>KESHAVWITHVELO</strong> extension folder with the new one.</li>
        <li>Open After Effects again.</li>
      </ol>
      <h3>Important</h3>
      <ul>
        <li>Your license will remain active on the same device.</li>
        <li>Do not delete Adobe CEP/AppData/Library support folders unless support asks.</li>
        <li>One license is for one device unless reset by admin.</li>
      </ul>
      <p>Keshav With Velo Support</p>
    </div>
  `;

  return { subject: DEFAULT_SUBJECT, text, html };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function createTransport() {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass
    }
  });
}

async function sendEmail({ email, subject, text, html }) {
  const failures = [];

  if (config.resend.apiKey) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resend.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: config.resend.from,
          to: email,
          subject,
          text,
          html
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || `Resend failed ${response.status}`);
      return { sent: true, provider: "resend", id: data.id || null };
    } catch (error) {
      failures.push({ provider: "resend", message: error.message });
    }
  }

  const transport = createTransport();
  if (transport) {
    try {
      const info = await transport.sendMail({
        from: config.smtp.from,
        to: email,
        subject,
        text,
        html
      });
      return { sent: true, provider: "smtp", id: info.messageId || null, failedProviders: failures };
    } catch (error) {
      failures.push({ provider: "smtp", message: error.message });
    }
  }

  return { sent: false, failedProviders: failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvRows = parseCsv(fs.readFileSync(args.csv, "utf8"));
  const licenseRows = csvRows.filter(isLicenseEmail);
  const invalidEmailRows = licenseRows.filter((row) => !EMAIL_PATTERN.test(normalizeEmail(row.to)));
  const { records: uniqueRows, duplicates } = chooseLatestByEmail(licenseRows);
  const selectedRows = args.only ? uniqueRows.filter((row) => normalizeEmail(row.to) === args.only) : uniqueRows;
  const limitedRows = args.limit > 0 ? selectedRows.slice(0, args.limit) : selectedRows;

  const recipients = [];
  const skipped = [];

  for (const row of limitedRows) {
    const email = normalizeEmail(row.to);
    if (!EMAIL_PATTERN.test(email)) {
      skipped.push({ email: row.to || "", reason: "invalid_email", id: row.id || "" });
      continue;
    }

    const fetched = await fetchResendEmail(row.id);
    const licenseKey = fetched.ok ? extractLicenseKey(fetched.data) : "";
    if (args.skipNoKey && !licenseKey) {
      skipped.push({ email, reason: fetched.ok ? "license_key_not_found" : fetched.reason, id: row.id || "" });
      continue;
    }

    const match = await getDbMatch(email);
    const emailPayload = buildUpdateEmail({
      name: match?.name,
      email,
      licenseKey,
      licenseId: match?.license_id ? String(match.license_id) : "",
      licenseHint: match?.license_hint || "",
      downloadUrl: args.downloadUrl
    });

    recipients.push({
      email,
      maskedEmail: maskEmail(email),
      resendEmailId: row.id || "",
      sourceSubject: row.subject || "",
      sourceSentAt: row.sent_at || row.created_at || "",
      fetchedOldEmail: fetched.ok,
      fetchReason: fetched.ok ? "" : fetched.reason,
      hasLicenseKey: Boolean(licenseKey),
      dbMatched: Boolean(match),
      licenseId: match?.license_id || null,
      licenseHint: match?.license_hint || "",
      licenseStatus: match?.status || "",
      emailPayload
    });
  }

  let sent = 0;
  let failed = 0;
  if (args.send) {
    for (const recipient of recipients) {
      const delivery = await sendEmail({
        email: recipient.email,
        ...recipient.emailPayload
      });
      recipient.delivery = delivery;
      if (delivery.sent) sent += 1;
      else failed += 1;
    }
  }

  const report = {
    mode: args.send ? "send" : "dry-run",
    generatedAt: new Date().toISOString(),
    csvPath: path.resolve(args.csv),
    downloadUrl: args.downloadUrl,
    totals: {
      csvRows: csvRows.length,
      licenseEmailRows: licenseRows.length,
      invalidEmailRows: invalidEmailRows.length,
      uniqueRecipientEmails: uniqueRows.length,
      duplicateRows: duplicates.length,
      selectedRows: selectedRows.length,
      processedRows: limitedRows.length,
      recipientsPrepared: recipients.length,
      keysParsed: recipients.filter((recipient) => recipient.hasLicenseKey).length,
      dbMatches: recipients.filter((recipient) => recipient.dbMatched).length,
      dbMissing: recipients.filter((recipient) => !recipient.dbMatched).length,
      dbAvailable: Boolean(dbInstance),
      dbLoadError: dbLoadError ? dbLoadError.message : "",
      skipped: skipped.length,
      sent,
      failed
    },
    duplicateRecipients: duplicates.map((item) => ({
      email: maskEmail(item.email),
      keptId: item.keptId,
      skippedId: item.skippedId
    })),
    skipped: skipped.map((item) => ({
      ...item,
      email: EMAIL_PATTERN.test(normalizeEmail(item.email)) ? maskEmail(item.email) : item.email
    })),
    recipients: recipients.map(({ emailPayload, email, ...recipient }) => ({
      ...recipient,
      email: maskEmail(email)
    }))
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `bulk-update-${report.mode}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    mode: report.mode,
    reportPath,
    totals: report.totals,
    sampleRecipients: report.recipients.slice(0, 5)
  }, null, 2));

  if (!args.send) {
    console.log("Dry-run only. No emails were sent. Use --send after reviewing the report.");
  }
}

main()
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (dbInstance) dbInstance.close();
  });
