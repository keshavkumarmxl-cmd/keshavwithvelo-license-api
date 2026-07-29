import bcrypt from "bcryptjs";
import express from "express";
import { config } from "../config.js";
import { db } from "../db/connection.js";
import {
  deleteMongoCoupon,
  getMongoCoupons,
  getMongoProductPlans,
  getMongoSiteSetting,
  mirrorCoupon,
  mirrorProductPlan,
  mirrorSiteSetting
} from "../db/mongoBackup.js";
import { validate } from "../middleware/validate.js";
import { createAdminToken, requireAdmin } from "../middleware/auth.js";
import { adminLoginSchema, couponSchema, maintenanceSchema, manualLicenseSchema, offerBannerSchema, planSchema, tutorialVideoSchema, versionSchema } from "../schemas.js";
import { expiryDate, generateLicenseKey, hashLicenseKey, licenseHint } from "../utils/license.js";

export const adminRoutes = express.Router();

function siteSettingResponse(row, mongoSetting) {
  const value = row?.value || mongoSetting?.value || "";
  return {
    value,
    updatedAt: row?.updated_at || mongoSetting?.updatedAt || null
  };
}

function mapPlanRow(row, index = 0) {
  return {
    key: row.plan_key,
    title: row.title,
    amount: row.amount,
    currency: row.currency,
    licenseType: row.license_type,
    description: row.description,
    isActive: Boolean(row.is_active),
    updatedAt: row.updated_at,
    rowOrder: index
  };
}

function mapCouponRow(row) {
  return {
    code: row.code,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    currency: row.currency || "",
    maxRedemptions: row.max_redemptions,
    redeemedCount: row.redeemed_count,
    expiresAt: row.expires_at,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function saveSiteSettingLocal(key, value) {
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value || "");
}

function hydratePlanLocal(plan) {
  db.prepare(`
    INSERT INTO product_plans (plan_key, title, amount, currency, license_type, description, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(plan_key) DO UPDATE SET
      title = excluded.title,
      amount = excluded.amount,
      currency = excluded.currency,
      license_type = excluded.license_type,
      description = excluded.description,
      is_active = excluded.is_active,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    plan.key,
    plan.title,
    plan.amount,
    plan.currency,
    plan.licenseType || "standard",
    plan.description,
    plan.isActive ? 1 : 0
  );
}

function hydrateCouponLocal(coupon) {
  db.prepare(`
    INSERT INTO coupons (code, discount_type, discount_value, currency, max_redemptions, redeemed_count, expires_at, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET
      discount_type = excluded.discount_type,
      discount_value = excluded.discount_value,
      currency = excluded.currency,
      max_redemptions = excluded.max_redemptions,
      redeemed_count = excluded.redeemed_count,
      expires_at = excluded.expires_at,
      is_active = excluded.is_active,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    coupon.code,
    coupon.discountType,
    coupon.discountValue,
    coupon.currency || null,
    coupon.maxRedemptions || null,
    coupon.redeemedCount || 0,
    coupon.expiresAt || null,
    coupon.isActive ? 1 : 0
  );
}

adminRoutes.post("/login", validate(adminLoginSchema), (req, res) => {
  const admin = db.prepare("SELECT * FROM admins WHERE email = ?").get(req.body.email);
  if (!admin || !bcrypt.compareSync(req.body.password, admin.password_hash)) {
    return res.status(401).json({ error: "Invalid admin credentials" });
  }

  return res.json({ token: createAdminToken(admin) });
});

adminRoutes.use(requireAdmin);

adminRoutes.get("/settings/tutorial", async (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("tutorial_youtube_url");
  const mongoSetting = await getMongoSiteSetting("tutorial_youtube_url");
  if (!row && mongoSetting) saveSiteSettingLocal("tutorial_youtube_url", mongoSetting.value || "");
  const setting = siteSettingResponse(row, mongoSetting);
  res.json({
    youtubeUrl: setting.value,
    updatedAt: setting.updatedAt
  });
});

adminRoutes.post("/settings/tutorial", validate(tutorialVideoSchema), async (req, res) => {
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES ('tutorial_youtube_url', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(req.body.youtubeUrl || "");

  await mirrorSiteSetting("tutorial_youtube_url", req.body.youtubeUrl || "");
  res.json({ status: "success", youtubeUrl: req.body.youtubeUrl || "" });
});

adminRoutes.get("/settings/offer-banner", async (req, res) => {
  const text = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("offer_banner_text");
  const active = db.prepare("SELECT value FROM site_settings WHERE key = ?").get("offer_banner_active");
  const mongoText = await getMongoSiteSetting("offer_banner_text");
  const mongoActive = await getMongoSiteSetting("offer_banner_active");
  if (!text && mongoText) saveSiteSettingLocal("offer_banner_text", mongoText.value || "");
  if (!active && mongoActive) saveSiteSettingLocal("offer_banner_active", mongoActive.value || "1");
  const textSetting = siteSettingResponse(text, mongoText);
  res.json({
    text: textSetting.value,
    isActive: active ? active.value === "1" : (mongoActive ? mongoActive.value === "1" : true),
    updatedAt: textSetting.updatedAt
  });
});

adminRoutes.post("/settings/offer-banner", validate(offerBannerSchema), async (req, res) => {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('offer_banner_text', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.body.text || "");

    db.prepare(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('offer_banner_active', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.body.isActive ? "1" : "0");
  });

  tx();
  await Promise.all([
    mirrorSiteSetting("offer_banner_text", req.body.text || ""),
    mirrorSiteSetting("offer_banner_active", req.body.isActive ? "1" : "0")
  ]);
  res.json({ status: "success", text: req.body.text || "", isActive: req.body.isActive });
});

adminRoutes.get("/settings/maintenance", async (req, res) => {
  const active = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("maintenance_active");
  const message = db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").get("maintenance_message");
  const mongoActive = await getMongoSiteSetting("maintenance_active");
  const mongoMessage = await getMongoSiteSetting("maintenance_message");
  if (!active && mongoActive) saveSiteSettingLocal("maintenance_active", mongoActive.value || "0");
  if (!message && mongoMessage) saveSiteSettingLocal("maintenance_message", mongoMessage.value || "");

  res.json({
    isActive: active ? active.value === "1" : (mongoActive ? mongoActive.value === "1" : false),
    message: message?.value || mongoMessage?.value || "",
    updatedAt: active?.updated_at || message?.updated_at || mongoActive?.updatedAt || mongoMessage?.updatedAt || null
  });
});

adminRoutes.post("/settings/maintenance", validate(maintenanceSchema), async (req, res) => {
  const maintenanceMessage = req.body.message || "";
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('maintenance_active', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.body.isActive ? "1" : "0");

    db.prepare(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('maintenance_message', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(maintenanceMessage);
  });

  tx();
  await Promise.all([
    mirrorSiteSetting("maintenance_active", req.body.isActive ? "1" : "0"),
    mirrorSiteSetting("maintenance_message", maintenanceMessage)
  ]);
  res.json({ status: "success", isActive: req.body.isActive, message: maintenanceMessage });
});

adminRoutes.get("/pricing/plans", async (req, res) => {
  const mongoPlans = await getMongoProductPlans();
  if (mongoPlans?.length) {
    mongoPlans.forEach(hydratePlanLocal);
    return res.json(mongoPlans);
  }

  res.json(db.prepare("SELECT * FROM product_plans ORDER BY rowid").all().map(mapPlanRow));
});

adminRoutes.put("/pricing/plans/:key", validate(planSchema), async (req, res) => {
  const result = db.prepare(`
    UPDATE product_plans
    SET title = ?, amount = ?, currency = ?, license_type = ?, description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE plan_key = ?
  `).run(
    req.body.title,
    req.body.amount,
    req.body.currency,
    req.body.licenseType,
    req.body.description,
    req.body.isActive ? 1 : 0,
    req.params.key
  );

  if (!result.changes) return res.status(404).json({ error: "Plan not found" });
  await mirrorProductPlan({
    key: req.params.key,
    title: req.body.title,
    amount: req.body.amount,
    currency: req.body.currency,
    licenseType: req.body.licenseType,
    description: req.body.description,
    isActive: req.body.isActive
  });
  return res.json({ status: "success" });
});

adminRoutes.get("/pricing/coupons", async (req, res) => {
  const rows = db.prepare("SELECT * FROM coupons ORDER BY created_at DESC").all();
  if (rows.length) return res.json(rows.map(mapCouponRow));

  const mongoCoupons = await getMongoCoupons() || [];
  mongoCoupons.forEach(hydrateCouponLocal);
  res.json(mongoCoupons);
});

adminRoutes.post("/pricing/coupons", validate(couponSchema), async (req, res) => {
  db.prepare(`
    INSERT INTO coupons (code, discount_type, discount_value, currency, max_redemptions, expires_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      discount_type = excluded.discount_type,
      discount_value = excluded.discount_value,
      currency = excluded.currency,
      max_redemptions = excluded.max_redemptions,
      expires_at = excluded.expires_at,
      is_active = excluded.is_active,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    req.body.code,
    req.body.discountType,
    req.body.discountValue,
    req.body.currency || null,
    req.body.maxRedemptions || null,
    req.body.expiresAt || null,
    req.body.isActive ? 1 : 0
  );

  const row = db.prepare("SELECT * FROM coupons WHERE code = ?").get(req.body.code);
  await mirrorCoupon(mapCouponRow(row));
  res.status(201).json({ status: "success" });
});

adminRoutes.post("/pricing/coupons/:code/toggle", async (req, res) => {
  const result = db.prepare(`
    UPDATE coupons
    SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END,
      updated_at = CURRENT_TIMESTAMP
    WHERE code = ?
  `).run(String(req.params.code || "").trim().toUpperCase());

  if (!result.changes) return res.status(404).json({ error: "Coupon not found" });
  const row = db.prepare("SELECT * FROM coupons WHERE code = ?").get(String(req.params.code || "").trim().toUpperCase());
  if (row) await mirrorCoupon(mapCouponRow(row));
  res.json({ status: "success" });
});

adminRoutes.delete("/pricing/coupons/:code", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const result = db.prepare("DELETE FROM coupons WHERE code = ?").run(code);

  if (!result.changes) return res.status(404).json({ error: "Coupon not found" });
  await deleteMongoCoupon(code);
  res.json({ status: "success" });
});

adminRoutes.get("/users", (req, res) => {
  const rows = db.prepare(`
    SELECT users.id, users.name, users.email, users.purchase_history, users.created_at,
      COUNT(licenses.id) AS license_count
    FROM users
    LEFT JOIN licenses ON licenses.user_id = users.id
    GROUP BY users.id
    ORDER BY users.created_at DESC
  `).all();

  res.json(rows.map((row) => ({ ...row, purchase_history: JSON.parse(row.purchase_history || "[]") })));
});

adminRoutes.get("/licenses", (req, res) => {
  const q = `%${String(req.query.q || "").trim()}%`;
  const rows = db.prepare(`
    SELECT licenses.id, licenses.license_hint, licenses.status, licenses.activation_date,
      licenses.device_id, licenses.last_verification, licenses.expiry_date, licenses.license_type,
      licenses.created_at, users.name, users.email
    FROM licenses
    JOIN users ON users.id = licenses.user_id
    WHERE users.email LIKE ? OR users.name LIKE ? OR licenses.license_hint LIKE ?
    ORDER BY licenses.created_at DESC
  `).all(q, q, q);

  res.json(rows);
});

adminRoutes.post("/licenses/:id/block", (req, res) => {
  db.prepare("UPDATE licenses SET status = 'blocked' WHERE id = ?").run(req.params.id);
  res.json({ status: "success" });
});

adminRoutes.post("/licenses/:id/unblock", (req, res) => {
  db.prepare("UPDATE licenses SET status = CASE WHEN device_id IS NULL THEN 'inactive' ELSE 'active' END WHERE id = ?").run(req.params.id);
  res.json({ status: "success" });
});

adminRoutes.post("/licenses/:id/reset-device", (req, res) => {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM devices WHERE license_id = ?").run(req.params.id);
    db.prepare(`
      UPDATE licenses
      SET status = 'inactive', device_id = NULL, device_rebind_count = 0, activation_date = NULL, last_verification = NULL
      WHERE id = ?
    `).run(req.params.id);
  });
  tx();
  res.json({ status: "success" });
});

adminRoutes.get("/activation-attempts", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM activation_attempts
    ORDER BY created_at DESC
    LIMIT 250
  `).all();
  res.json(rows);
});

adminRoutes.post("/manual-license", validate(manualLicenseSchema), (req, res) => {
  const { name, email, licenseType, expiryDays } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const userId = user
    ? user.id
    : db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(name, email).lastInsertRowid;

  for (let i = 0; i < 8; i += 1) {
    const key = generateLicenseKey();
    try {
      db.prepare(`
        INSERT INTO licenses (license_hash, license_hint, user_id, status, expiry_date, license_type)
        VALUES (?, ?, ?, 'inactive', ?, ?)
      `).run(hashLicenseKey(key), licenseHint(key), userId, expiryDate(expiryDays ?? config.licenseExpiryDays), licenseType);
      return res.status(201).json({ status: "success", email, licenseKey: key });
    } catch (error) {
      if (!String(error.message).includes("UNIQUE")) throw error;
    }
  }

  return res.status(500).json({ error: "Could not generate manual license" });
});

adminRoutes.get("/versions", (req, res) => {
  res.json(db.prepare("SELECT * FROM extension_versions ORDER BY created_at DESC").all());
});

adminRoutes.post("/versions", validate(versionSchema), (req, res) => {
  const tx = db.transaction(() => {
    if (req.body.isActive) {
      db.prepare("UPDATE extension_versions SET is_active = 0").run();
    }

    db.prepare(`
      INSERT INTO extension_versions (version, download_path, notes, is_active)
      VALUES (?, ?, ?, ?)
    `).run(req.body.version, req.body.downloadPath, req.body.notes || null, req.body.isActive ? 1 : 0);
  });

  tx();
  res.status(201).json({ status: "success" });
});
