import dotenv from "dotenv";

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:4000",
  frontendOrigins: String(process.env.FRONTEND_ORIGIN || "https://website-0fny.onrender.com")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  databasePath: process.env.DATABASE_PATH || "./data/licensing.sqlite",
  jwtSecret: process.env.JWT_SECRET || "dev-only-change-me",
  licenseHashSecret: process.env.LICENSE_HASH_SECRET || "dev-only-license-secret",
  adminEmail: process.env.ADMIN_EMAIL || "admin@example.com",
  adminPassword: process.env.ADMIN_PASSWORD || "change-this-admin-password",
  downloadApiKey: process.env.DOWNLOAD_API_KEY || "dev-download-api-key",
  downloadLinkSecret: process.env.DOWNLOAD_LINK_SECRET || process.env.LICENSE_HASH_SECRET || "dev-only-download-link-secret",
  downloadLinkExpiryHours: Number(process.env.DOWNLOAD_LINK_EXPIRY_HOURS || 168),
  masterLicense: {
    email: String(process.env.MASTER_LICENSE_EMAIL || "").trim().toLowerCase(),
    key: String(process.env.MASTER_LICENSE_KEY || "").trim().toUpperCase()
  },
  productId: process.env.EXTENSION_PRODUCT_ID || "keshav-with-velo",
  extensionZipPath: process.env.EXTENSION_DOWNLOAD_URL || process.env.EXTENSION_ZIP_PATH || "https://drive.google.com/file/d/1K5rCClmg6j5LRqVHrXgPpvLtYfN_sf0o/view?usp=sharing",
  licenseExpiryDays: Number(process.env.LICENSE_EXPIRY_DAYS || 365),
  maxFailedActivationsPerHour: Number(process.env.MAX_FAILED_ACTIVATIONS_PER_HOUR || 8),
  maxAutoDeviceRelinks: Number(process.env.MAX_AUTO_DEVICE_RELINKS || 3),
  licenseDevicePolicy: String(process.env.LICENSE_DEVICE_POLICY || "latest-device").trim().toLowerCase(),
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "Keshav With Velo <no-reply@example.com>"
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || "",
    from: process.env.RESEND_FROM || process.env.SMTP_FROM || "Keshav With Velo <no-reply@example.com>"
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    priceId: process.env.STRIPE_PRICE_ID || ""
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || ""
  },
  mongo: {
    uri: process.env.MONGODB_URI || "",
    dbName: process.env.MONGODB_DB_NAME || "keshavwithvelo_licensing_backup"
  }
};
