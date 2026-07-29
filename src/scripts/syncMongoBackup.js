import { MongoClient } from "mongodb";
import { config } from "../config.js";
import { db } from "../db/connection.js";

if (!config.mongo.uri) {
  console.error("MONGODB_URI is not configured.");
  process.exit(1);
}

const client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10000 });
const mongo = client.db(config.mongo.dbName);

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

try {
  await client.connect();

  await Promise.all([
    mongo.collection("users").createIndex({ email: 1 }, { unique: true }),
    mongo.collection("licenses").createIndex({ licenseHash: 1 }, { unique: true }),
    mongo.collection("licenses").createIndex({ email: 1 }),
    mongo.collection("purchases").createIndex({ paymentProvider: 1, paymentId: 1 }, { unique: true }),
    mongo.collection("devices").createIndex({ licenseHash: 1, deviceHash: 1 }, { unique: true })
  ]);

  const users = db.prepare("SELECT * FROM users").all();
  const licenses = db.prepare(`
    SELECT licenses.*, users.email
    FROM licenses
    JOIN users ON users.id = licenses.user_id
  `).all();
  const purchases = db.prepare(`
    SELECT purchases.*, users.email
    FROM purchases
    JOIN users ON users.id = purchases.user_id
  `).all();
  const devices = db.prepare(`
    SELECT devices.*, licenses.license_hash
    FROM devices
    JOIN licenses ON licenses.id = devices.license_id
  `).all();

  for (const user of users) {
    await mongo.collection("users").updateOne(
      { email: user.email },
      {
        $set: {
          name: user.name,
          email: user.email,
          purchaseHistory: parseJson(user.purchase_history, []),
          sqliteId: user.id,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: user.created_at ? new Date(user.created_at) : new Date()
        }
      },
      { upsert: true }
    );
  }

  for (const license of licenses) {
    await mongo.collection("licenses").updateOne(
      { licenseHash: license.license_hash },
      {
        $set: {
          licenseHash: license.license_hash,
          licenseHint: license.license_hint,
          email: license.email,
          status: license.status,
          licenseType: license.license_type,
          expiryDate: license.expiry_date || null,
          activationDate: license.activation_date || null,
          lastVerification: license.last_verification || null,
          sqliteId: license.id,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: license.created_at ? new Date(license.created_at) : new Date()
        }
      },
      { upsert: true }
    );
  }

  for (const device of devices) {
    await mongo.collection("devices").updateOne(
      { licenseHash: device.license_hash, deviceHash: device.hardware_fingerprint_hash },
      {
        $set: {
          licenseHash: device.license_hash,
          deviceHash: device.hardware_fingerprint_hash,
          lastActivity: device.last_activity ? new Date(device.last_activity) : new Date(),
          sqliteId: device.id
        },
        $setOnInsert: {
          activationTimestamp: device.activation_timestamp ? new Date(device.activation_timestamp) : new Date()
        }
      },
      { upsert: true }
    );
  }

  for (const purchase of purchases) {
    await mongo.collection("purchases").updateOne(
      { paymentProvider: purchase.payment_provider, paymentId: purchase.payment_id },
      {
        $set: {
          email: purchase.email,
          productId: purchase.product_id,
          paymentProvider: purchase.payment_provider,
          paymentId: purchase.payment_id,
          amount: purchase.amount,
          currency: purchase.currency,
          status: purchase.status,
          rawPayload: parseJson(purchase.raw_payload, {}),
          sqliteId: purchase.id,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: purchase.created_at ? new Date(purchase.created_at) : new Date()
        }
      },
      { upsert: true }
    );
  }

  console.log(`Mongo backup sync complete: ${users.length} users, ${licenses.length} licenses, ${devices.length} devices, ${purchases.length} purchases.`);
} finally {
  await client.close();
}

