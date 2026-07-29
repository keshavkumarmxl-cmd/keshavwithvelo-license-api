import fs from "fs";
import path from "path";
import express from "express";
import { db } from "../db/connection.js";
import {
  activateMongoLicense,
  findMongoLicenseByHash,
  getMongoSiteSetting,
  logMongoActivationAttempt,
  mirrorPurchase,
  mongoPurchaseExists,
  verifyMongoLicense
} from "../db/mongoBackup.js";
import { config } from "../config.js";
import { validate } from "../middleware/validate.js";
import { activateSchema, downloadSchema, purchaseSchema, razorpayOrderSchema, verifyLicenseSchema } from "../schemas.js";
import { sendPurchaseEmail } from "../services/emailService.js";
import { createRazorpayOrder, getCheckoutPlans, verifyPayment } from "../services/paymentService.js";
import { createDownloadToken, readDownloadToken } from "../utils/downloadLink.js";
import {
  expiryDate,
  generateLicenseKey,
  hashFingerprint,
  hashLicenseKey,
  isExpired,
  licenseHint,
  normalizeLicenseKey
} from "../utils/license.js";

export const publicRoutes = express.Router();

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function logAttempt(req, { email, licenseKey, deviceHash, result, reason }) {
  db.prepare(`
    INSERT INTO activation_attempts (email, license_hint, device_fingerprint_hash, ip_address, user_agent, result, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(email || null, licenseKey ? licenseHint(licenseKey) : null, deviceHash || null, clientIp(req), req.headers["user-agent"] || "", result, reason || null);
  logMongoActivationAttempt({
    email: email || null,
    licenseHint: licenseKey ? licenseHint(licenseKey) : null,
    deviceHash: deviceHash || null,
    ipAddress: clientIp(req),
    userAgent: req.headers["user-agent"] || "",
    result,
    reason: reason || null
  });
}

function isExternalDownloadUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getActiveDownloadPath() {
  const activeVersion = db.prepare("SELECT * FROM extension_versions WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get();
  return activeVersion?.download_path || config.extensionZipPath;
}

function purchaseDownloadUrl({ email, licenseKey }) {
  const downloadPath = getActiveDownloadPath();
  if (isExternalDownloadUrl(downloadPath)) return downloadPath;

  const downloadToken = createDownloadToken({ email, licenseKey });
  return `${config.publicBaseUrl}/api/download-link?token=${encodeURIComponent(downloadToken)}`;
}

function sendActiveDownload(res) {
  const downloadPath = getActiveDownloadPath();

  if (isExternalDownloadUrl(downloadPath)) {
    return res.redirect(302, downloadPath);
  }

  const filePath = path.resolve(process.cwd(), downloadPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("The extension download is not available yet.");
  }

  return res.download(filePath, "keshav-with-velo.zip");
}

function failedAttemptCount(req, email) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM activation_attempts
    WHERE email = ?
      AND ip_address = ?
      AND result = 'failed'
      AND created_at >= datetime('now', '-1 hour')
  `).get(email, clientIp(req)).count;
}

function clearFailedAttempts(req, email) {
  db.prepare(`
    DELETE FROM activation_attempts
    WHERE email = ?
      AND ip_address = ?
      AND result = 'failed'
  `).run(email, clientIp(req));
}

function repairPermanentLicenseIfNeeded(license) {
  if (!license || license.status === "blocked") return license;
  if (Number(config.licenseExpiryDays) > 0) return license;
  if (!license.expiry_date && license.status !== "expired") return license;

  const nextStatus = license.device_id ? "active" : "inactive";
  db.prepare(`
    UPDATE licenses
    SET status = ?,
        expiry_date = NULL
    WHERE id = ?
  `).run(nextStatus, license.id);

  return {
    ...license,
    status: nextStatus,
    expiry_date: null
  };
}

function shouldRelinkDevice(license) {
  if (config.licenseDevicePolicy === "latest-device") return true;
  return (license.device_rebind_count || 0) < config.maxAutoDeviceRelinks;
}

function relinkLicenseDevice({ license, deviceHash }) {
  return db.transaction(() => {
    const existingDevice = db.prepare(`
      SELECT id FROM devices WHERE license_id = ? AND hardware_fingerprint_hash = ?
    `).get(license.id, deviceHash);
    const deviceId = existingDevice?.id || db.prepare(`
      INSERT INTO devices (license_id, hardware_fingerprint_hash)
      VALUES (?, ?)
    `).run(license.id, deviceHash).lastInsertRowid;

    db.prepare(`
      UPDATE licenses
      SET status = 'active',
          device_id = ?,
          device_rebind_count = COALESCE(device_rebind_count, 0) + 1,
          last_verification = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(deviceId, license.id);
    db.prepare("UPDATE devices SET last_activity = CURRENT_TIMESTAMP WHERE id = ?").run(deviceId);
    return deviceId;
  })();
}

function isMasterLicense({ email, licenseKey }) {
  return Boolean(
    config.masterLicense.email &&
    config.masterLicense.key &&
    String(email || "").trim().toLowerCase() === config.masterLicense.email &&
    normalizeLicenseKey(licenseKey) === config.masterLicense.key
  );
}

function isMasterLicenseKey(licenseKey) {
  return Boolean(
    config.masterLicense.key &&
    normalizeLicenseKey(licenseKey) === config.masterLicense.key
  );
}

function createLicenseForUser(userId, licenseType, expiryDays = config.licenseExpiryDays) {
  for (let i = 0; i < 8; i += 1) {
    const key = generateLicenseKey();
    const hash = hashLicenseKey(key);

    try {
      db.prepare(`
        INSERT INTO licenses (license_hash, license_hint, user_id, status, expiry_date, license_type)
        VALUES (?, ?, ?, 'inactive', ?, ?)
      `).run(hash, licenseHint(key), userId, expiryDate(expiryDays), licenseType);

      return key;
    } catch (error) {
      if (!String(error.message).includes("UNIQUE")) throw error;
    }
  }

  throw new Error("Could not generate a unique license key");
}

function upsertUser({ name, email }) {
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (existing) return existing;

  const result = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(name, email);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
}

function appendPurchaseHistory(userId, purchase) {
  const user = db.prepare("SELECT purchase_history FROM users WHERE id = ?").get(userId);
  const history = JSON.parse(user.purchase_history || "[]");
  history.push(purchase);
  db.prepare("UPDATE users SET purchase_history = ? WHERE id = ?").run(JSON.stringify(history), userId);
}

publicRoutes.get("/health", (req, res) => {
  res.json({ status: "ok", service: "licensing", time: new Date().toISOString() });
});

publicRoutes.get("/site-settings/tutorial", async (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("tutorial_youtube_url");
  const mongoSetting = await getMongoSiteSetting("tutorial_youtube_url");
  res.json({
    youtubeUrl: row?.value || mongoSetting?.value || "",
    updatedAt: row?.updated_at || mongoSetting?.updatedAt || null
  });
});

publicRoutes.get("/site-settings/offer-banner", async (req, res) => {
  const text = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("offer_banner_text");
  const active = db.prepare("SELECT value FROM site_settings WHERE key = ?").get("offer_banner_active");
  const mongoText = await getMongoSiteSetting("offer_banner_text");
  const mongoActive = await getMongoSiteSetting("offer_banner_active");
  res.json({
    text: text?.value || mongoText?.value || "",
    isActive: active ? active.value === "1" : (mongoActive ? mongoActive.value === "1" : true),
    updatedAt: text?.updated_at || mongoText?.updatedAt || null
  });
});

publicRoutes.get("/site-settings/maintenance", async (req, res) => {
  const active = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("maintenance_active");
  const message = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("maintenance_message");
  const mongoActive = await getMongoSiteSetting("maintenance_active");
  const mongoMessage = await getMongoSiteSetting("maintenance_message");
  res.json({
    isActive: active ? active.value === "1" : (mongoActive ? mongoActive.value === "1" : false),
    message: message?.value || mongoMessage?.value || "",
    updatedAt: active?.updated_at || message?.updated_at || mongoActive?.updatedAt || mongoMessage?.updatedAt || null
  });
});

publicRoutes.get("/pricing", (req, res) => {
  res.json({ plans: getCheckoutPlans().filter((plan) => plan.isActive) });
});

publicRoutes.post("/razorpay/order", validate(razorpayOrderSchema), async (req, res, next) => {
  try {
    const body = req.body;
    if (body.productId !== config.productId) {
      return res.status(400).json({ status: "failed", reason: "Unknown product" });
    }

    const order = await createRazorpayOrder({
      plan: body.plan,
      productId: body.productId,
      name: body.name,
      email: body.email,
      couponCode: body.couponCode
    });

    return res.status(201).json({
      status: "success",
      order
    });
  } catch (error) {
    return next(error);
  }
});

publicRoutes.post("/purchase", validate(purchaseSchema), async (req, res, next) => {
  try {
    const body = req.body;
    if (body.productId !== config.productId) {
      return res.status(400).json({ status: "failed", reason: "Unknown product" });
    }

    const existingPurchase = db.prepare(`
      SELECT id FROM purchases WHERE payment_provider = ? AND payment_id = ?
    `).get(body.paymentProvider, body.paymentId);

    if (existingPurchase) {
      return res.status(409).json({ status: "failed", reason: "Payment was already used" });
    }

    const existingMongoPurchase = await mongoPurchaseExists(body.paymentProvider, body.paymentId);
    if (existingMongoPurchase) {
      return res.status(409).json({ status: "failed", reason: "Payment was already used" });
    }

    const payment = await verifyPayment(body);
    if (!payment.verified) {
      return res.status(402).json({ status: "failed", reason: payment.reason || "Payment verification failed" });
    }

    const buyerEmail = body.email || payment.raw?.email;
    const buyerName = body.name || payment.raw?.notes?.name || payment.raw?.contact || "Razorpay Customer";
    const couponCode = String(payment.raw?.notes?.couponCode || (body.paymentProvider === "manual" ? body.couponCode : "") || "").trim().toUpperCase();

    if (!buyerEmail) {
      return res.status(400).json({
        status: "failed",
        reason: "Razorpay did not return a buyer email. Enable email collection in Razorpay checkout."
      });
    }

    const tx = db.transaction(() => {
      const user = upsertUser({ name: buyerName, email: buyerEmail });
      const key = createLicenseForUser(user.id, body.licenseType);

      const purchase = {
        productId: body.productId,
        paymentProvider: body.paymentProvider,
        paymentId: body.paymentId,
        amount: payment.amount,
        currency: payment.currency,
        couponCode,
        date: new Date().toISOString()
      };

      db.prepare(`
        INSERT INTO purchases (user_id, product_id, payment_provider, payment_id, amount, currency, status, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, 'paid', ?)
      `).run(user.id, body.productId, body.paymentProvider, body.paymentId, payment.amount || null, payment.currency || null, JSON.stringify(payment.raw || {}));

      appendPurchaseHistory(user.id, purchase);
      if (couponCode) {
        db.prepare("UPDATE coupons SET redeemed_count = redeemed_count + 1, updated_at = CURRENT_TIMESTAMP WHERE code = ?").run(couponCode);
      }
      return { user, key, purchase };
    });

    const { user, key, purchase } = tx();
    const licenseHash = hashLicenseKey(key);
    const licenseRow = db.prepare("SELECT * FROM licenses WHERE license_hash = ?").get(licenseHash);
    await mirrorPurchase({
      user,
      license: {
        licenseHash,
        licenseHint: licenseHint(key),
        status: licenseRow?.status || "inactive",
        licenseType: licenseRow?.license_type || body.licenseType,
        expiryDate: licenseRow?.expiry_date || null
      },
      purchase: {
        ...purchase,
        licenseHint: licenseHint(key)
      }
    });

    const downloadUrl = purchaseDownloadUrl({ email: user.email, licenseKey: key });
    let emailDelivery = { sent: false };
    try {
      emailDelivery = await sendPurchaseEmail({ name: user.name, email: user.email, licenseKey: key, downloadUrl });
    } catch (emailError) {
      console.error("[purchase email failed]", emailError);
      emailDelivery = { sent: false, error: "email_failed" };
    }

    return res.status(201).json({
      status: "success",
      message: emailDelivery.sent
        ? "Purchase confirmed. License generated and email sent."
        : "Purchase confirmed. License generated. Email delivery needs manual follow-up.",
      email: user.email,
      downloadUrl,
      emailDelivery
    });
  } catch (error) {
    return next(error);
  }
});

async function handleActivate(req, res) {
  const { licenseKey, deviceFingerprint } = req.body;
  const email = String(req.body.email || "").trim().toLowerCase();
  const normalizedKey = normalizeLicenseKey(licenseKey);
  const licenseHash = hashLicenseKey(normalizedKey);
  const deviceHash = hashFingerprint(deviceFingerprint);

  if (isMasterLicense({ email, licenseKey: normalizedKey })) {
    logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "success", reason: "Master license activated" });
    return res.json({ status: "success", message: "Master license activated" });
  }

  let license = db.prepare(`
    SELECT licenses.*, users.email
    FROM licenses
    JOIN users ON users.id = licenses.user_id
    WHERE licenses.license_hash = ?
  `).get(licenseHash);

  if (!license || String(license.email || "").trim().toLowerCase() !== email) {
    const mongoActivation = await activateMongoLicense({ licenseHash, email, deviceHash });
    if (mongoActivation?.status === "success") {
      clearFailedAttempts(req, email);
      logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "success", reason: "Activated from Mongo backup" });
      return res.json({ status: "success", message: "License activated" });
    }
    if (mongoActivation?.status === "blocked") {
      logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "License blocked in Mongo backup" });
      return res.status(403).json({ status: "blocked", reason: "License is blocked" });
    }
    if (mongoActivation?.status === "expired") {
      logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "License expired in Mongo backup" });
      return res.status(403).json({ status: "expired", reason: "License is expired" });
    }
    if (mongoActivation?.status === "device_mismatch") {
      logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "Mongo backup license already activated on another device" });
      return res.status(409).json({ status: "failed", reason: "License already activated on another device" });
    }

    if (failedAttemptCount(req, email) >= config.maxFailedActivationsPerHour) {
      logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "Too many failed attempts" });
      return res.status(429).json({ status: "failed", reason: "Too many failed activation attempts. Try again later." });
    }

    logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "Invalid email or license" });
    return res.status(404).json({ status: "failed", reason: "Invalid email or license key" });
  }

  if (license.status === "blocked") {
    logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "License blocked" });
    return res.status(403).json({ status: "blocked", reason: "License is blocked" });
  }

  license = repairPermanentLicenseIfNeeded(license);

  if (isExpired(license.expiry_date)) {
    db.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").run(license.id);
    logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "License expired" });
    return res.status(403).json({ status: "expired", reason: "License is expired" });
  }

  if (license.device_id) {
    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(license.device_id);
    if (device?.hardware_fingerprint_hash !== deviceHash) {
      if (shouldRelinkDevice(license)) {
        relinkLicenseDevice({ license, deviceHash });
        clearFailedAttempts(req, email);
        logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "success", reason: "Auto-relinked license device" });
        return res.json({ status: "success", message: "License re-linked to this device" });
      }

      logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "failed", reason: "License already activated on another device" });
      return res.status(409).json({
        status: "failed",
        reason: "License already activated on another device"
      });
    }

    db.prepare("UPDATE devices SET last_activity = CURRENT_TIMESTAMP WHERE id = ?").run(device.id);
    db.prepare("UPDATE licenses SET last_verification = CURRENT_TIMESTAMP WHERE id = ?").run(license.id);
    clearFailedAttempts(req, email);
    logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "success", reason: "Already active on this device" });
    return res.json({ status: "success", message: "License already active on this device" });
  }

  const tx = db.transaction(() => {
    const deviceResult = db.prepare(`
      INSERT INTO devices (license_id, hardware_fingerprint_hash)
      VALUES (?, ?)
    `).run(license.id, deviceHash);

    db.prepare(`
      UPDATE licenses
      SET status = 'active',
          activation_date = CURRENT_TIMESTAMP,
          device_id = ?,
          last_verification = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(deviceResult.lastInsertRowid, license.id);
  });

  tx();
  await activateMongoLicense({ licenseHash, email, deviceHash });
  clearFailedAttempts(req, email);
  logAttempt(req, { email, licenseKey: normalizedKey, deviceHash, result: "success", reason: "Activated" });
  return res.json({ status: "success", message: "License activated" });
}

publicRoutes.post("/activate", validate(activateSchema), handleActivate);
publicRoutes.post("/licenses/activate", validate(activateSchema), handleActivate);

async function handleVerifyLicense(req, res) {
  if (isMasterLicenseKey(req.body.licenseKey)) {
    return res.json({
      status: "valid",
      licenseType: "master",
      expiryDate: null
    });
  }

  const licenseHash = hashLicenseKey(req.body.licenseKey);
  const deviceHash = hashFingerprint(req.body.deviceFingerprint);

  let license = db.prepare("SELECT * FROM licenses WHERE license_hash = ?").get(licenseHash);
  if (!license) {
    const mongoResult = await verifyMongoLicense({ licenseHash, deviceHash });
    if (!mongoResult) return res.status(404).json({ status: "invalid" });
    if (mongoResult.status === "valid") return res.json(mongoResult);
    if (mongoResult.status === "blocked") return res.status(403).json({ status: "blocked" });
    if (mongoResult.status === "expired") return res.status(403).json({ status: "expired" });
    return res.status(403).json(mongoResult);
  }
  if (license.status === "blocked") return res.status(403).json({ status: "blocked" });
  license = repairPermanentLicenseIfNeeded(license);
  if (isExpired(license.expiry_date) || license.status === "expired") {
    db.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").run(license.id);
    return res.status(403).json({ status: "expired" });
  }

  if (!license.device_id) return res.status(403).json({ status: "invalid", reason: "License is not activated" });

  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(license.device_id);
  if (!device || device.hardware_fingerprint_hash !== deviceHash) {
    return res.status(403).json({ status: "invalid", reason: "Device mismatch" });
  }

  db.prepare("UPDATE devices SET last_activity = CURRENT_TIMESTAMP WHERE id = ?").run(device.id);
  db.prepare("UPDATE licenses SET last_verification = CURRENT_TIMESTAMP WHERE id = ?").run(license.id);
  await verifyMongoLicense({ licenseHash, deviceHash });

  return res.json({
    status: "valid",
    licenseType: license.license_type,
    expiryDate: license.expiry_date
  });
}

publicRoutes.post("/verify-license", validate(verifyLicenseSchema), handleVerifyLicense);
publicRoutes.post("/licenses/verify", validate(verifyLicenseSchema), handleVerifyLicense);

publicRoutes.post("/download", validate(downloadSchema), async (req, res) => {
  if (isMasterLicense({ email: req.body.email, licenseKey: req.body.licenseKey })) {
    return sendActiveDownload(res);
  }

  const licenseHash = hashLicenseKey(req.body.licenseKey);
  const license = db.prepare(`
    SELECT licenses.*, users.email
    FROM licenses
    JOIN users ON users.id = licenses.user_id
    WHERE licenses.license_hash = ?
  `).get(licenseHash);

  if (!license || license.email !== req.body.email) {
    const mongoLicense = await findMongoLicenseByHash(licenseHash);
    if (!mongoLicense || mongoLicense.email !== req.body.email) {
      return res.status(404).json({ status: "failed", reason: "Invalid email or license key" });
    }
    if (mongoLicense.status === "blocked") return res.status(403).json({ status: "blocked" });
    if (mongoLicense.expiryDate && new Date(mongoLicense.expiryDate).getTime() < Date.now()) return res.status(403).json({ status: "expired" });

    return sendActiveDownload(res);
  }

  if (license.status === "blocked") return res.status(403).json({ status: "blocked" });
  if (isExpired(license.expiry_date)) return res.status(403).json({ status: "expired" });

  return sendActiveDownload(res);
});

publicRoutes.get("/download-link", async (req, res) => {
  const token = readDownloadToken(req.query.token);
  if (!token) return res.status(403).send("This download link is invalid or has expired.");

  const licenseHash = hashLicenseKey(token.licenseKey);
  const license = db.prepare(`
    SELECT licenses.*, users.email
    FROM licenses
    JOIN users ON users.id = licenses.user_id
    WHERE licenses.license_hash = ?
  `).get(licenseHash);

  if (!license || license.email !== token.email || license.status === "blocked" || isExpired(license.expiry_date)) {
    const mongoLicense = await findMongoLicenseByHash(licenseHash);
    if (!mongoLicense || mongoLicense.email !== token.email || mongoLicense.status === "blocked" || (mongoLicense.expiryDate && new Date(mongoLicense.expiryDate).getTime() < Date.now())) {
      return res.status(403).send("This download is no longer available.");
    }
  }

  return sendActiveDownload(res);
});
