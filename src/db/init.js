import bcrypt from "bcryptjs";
import { db } from "./connection.js";
import { config } from "../config.js";

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  purchase_history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  payment_provider TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount INTEGER,
  currency TEXT,
  status TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_provider, payment_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_hash TEXT NOT NULL UNIQUE,
  license_hint TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  activation_date TEXT,
  device_id INTEGER,
  device_rebind_count INTEGER NOT NULL DEFAULT 0,
  last_verification TEXT,
  expiry_date TEXT,
  license_type TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  hardware_fingerprint_hash TEXT NOT NULL,
  activation_timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(license_id, hardware_fingerprint_hash),
  FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  license_hint TEXT,
  device_fingerprint_hash TEXT,
  ip_address TEXT,
  user_agent TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS extension_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  download_path TEXT NOT NULL,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_plans (
  plan_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  license_type TEXT NOT NULL DEFAULT 'standard',
  description TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent', 'fixed')),
  discount_value INTEGER NOT NULL,
  currency TEXT,
  max_redemptions INTEGER,
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_licenses_user_id ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_license_id ON devices(license_id);
CREATE INDEX IF NOT EXISTS idx_activation_attempts_created ON activation_attempts(created_at);
`);

try {
  db.prepare("ALTER TABLE licenses ADD COLUMN device_rebind_count INTEGER NOT NULL DEFAULT 0").run();
} catch (error) {
  if (!String(error.message || "").includes("duplicate column")) throw error;
}

if (Number(config.licenseExpiryDays) <= 0) {
  db.prepare(`
    UPDATE licenses
    SET expiry_date = NULL,
        status = CASE
          WHEN status = 'expired' AND device_id IS NULL THEN 'inactive'
          WHEN status = 'expired' AND device_id IS NOT NULL THEN 'active'
          ELSE status
        END
    WHERE status != 'blocked'
  `).run();
}

db.prepare(`
  DELETE FROM activation_attempts
  WHERE created_at < datetime('now', '-2 hours')
`).run();

const admin = db.prepare("SELECT id FROM admins WHERE email = ?").get(config.adminEmail);
if (!admin) {
  db.prepare("INSERT INTO admins (email, password_hash) VALUES (?, ?)").run(
    config.adminEmail,
    bcrypt.hashSync(config.adminPassword, 12)
  );
}

const activeVersion = db.prepare("SELECT id, download_path FROM extension_versions WHERE is_active = 1").get();
if (!activeVersion) {
  db.prepare(`
    INSERT OR IGNORE INTO extension_versions (version, download_path, notes, is_active)
    VALUES (?, ?, ?, 1)
  `).run("1.0.0", config.extensionZipPath, "Initial extension ZIP");
} else if (activeVersion.download_path === "./storage/extensions/keshav-with-velo.zip" && /^https?:\/\//.test(config.extensionZipPath)) {
  db.prepare("UPDATE extension_versions SET download_path = ? WHERE id = ?").run(config.extensionZipPath, activeVersion.id);
}

const plans = [
  ["India Launch", "India Launch", 9900, "INR", "standard", "Keshav With Velo India Launch"],
  ["International", "International", 100, "USD", "standard", "Keshav With Velo International"]
];

for (const plan of plans) {
  db.prepare(`
    INSERT OR IGNORE INTO product_plans (plan_key, title, amount, currency, license_type, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(...plan);
}

console.log("Database initialized.");
