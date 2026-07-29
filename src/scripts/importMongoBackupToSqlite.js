import { MongoClient } from "mongodb";
import { config } from "../config.js";
import { db } from "../db/connection.js";
import "../db/init.js";

function iso(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function emptyPurchaseHistory() {
  return JSON.stringify([]);
}

if (!config.mongo.uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10000 });
await client.connect();

try {
  const mongoDb = client.db(config.mongo.dbName);
  const mongoLicenses = await mongoDb.collection("licenses").find({}).toArray();
  const mongoUsers = await mongoDb.collection("users").find({}).toArray();
  const userNames = new Map(mongoUsers.map((user) => [
    String(user.email || "").trim().toLowerCase(),
    user.name || String(user.email || "").split("@")[0] || "Customer"
  ]));

  const tx = db.transaction((licenses) => {
    let usersInserted = 0;
    let licensesInserted = 0;
    let licensesUpdated = 0;

    for (const license of licenses) {
      const email = String(license.email || "").trim().toLowerCase();
      const licenseHash = String(license.licenseHash || "").trim();
      const licenseHint = String(license.licenseHint || "----").trim() || "----";
      if (!email || !licenseHash) continue;

      let user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (!user) {
        const result = db.prepare(`
          INSERT INTO users (name, email, purchase_history, created_at)
          VALUES (?, ?, ?, ?)
        `).run(userNames.get(email) || email.split("@")[0] || "Customer", email, emptyPurchaseHistory(), iso(license.createdAt));
        user = { id: result.lastInsertRowid };
        usersInserted += 1;
      }

      const existing = db.prepare("SELECT id FROM licenses WHERE license_hash = ?").get(licenseHash);
      const status = license.status === "blocked" ? "blocked" : "inactive";
      const expiryDate = null;

      if (existing) {
        db.prepare(`
          UPDATE licenses
          SET user_id = ?, license_hint = ?, status = ?, expiry_date = ?, license_type = ?
          WHERE id = ?
        `).run(user.id, licenseHint, status, expiryDate, license.licenseType || "standard", existing.id);
        licensesUpdated += 1;
      } else {
        db.prepare(`
          INSERT INTO licenses (license_hash, license_hint, user_id, status, expiry_date, license_type, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          licenseHash,
          licenseHint,
          user.id,
          status,
          expiryDate,
          license.licenseType || "standard",
          iso(license.createdAt)
        );
        licensesInserted += 1;
      }
    }

    return { usersInserted, licensesInserted, licensesUpdated };
  });

  const result = tx(mongoLicenses);
  console.log(JSON.stringify({
    mongoLicenses: mongoLicenses.length,
    ...result
  }, null, 2));
} finally {
  await client.close();
}
