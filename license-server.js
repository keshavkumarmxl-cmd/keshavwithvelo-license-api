const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-KWV-App-Id, X-KWV-API-Version, X-KWV-Timestamp, X-KWV-Nonce, X-KWV-Signature");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

const licenses = new Map();
const sessions = new Map();
const nonces = new Set();

function sha256(value) {
    return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function licenseHash(rawKey) {
    return sha256("kwv-license-key:" + String(rawKey || "").trim());
}

function seedDemoLicense() {
    const email = String(process.env.DEMO_LICENSE_EMAIL || "keshavv.aep@gmail.com").trim().toLowerCase();
    const key = String(process.env.DEMO_LICENSE_KEY || "KWV-D4B2C-9F9CF-FCBFE-06FC2-6044F-B69D1").trim();
    licenses.set(licenseHash(key), {
        id: "lic_demo",
        email,
        status: "active",
        subscriptionStatus: "active",
        expiresAt: null,
        deviceId: "",
        activation: null
    });
    console.log(`Demo license: ${email} / ${key}`);
}

function reject(res, status, code, message) {
    return res.status(status).json({ code, message });
}

function makeOfflineToken(payload) {
    // Production: sign this as RS256/JWS with a private key and publish only the public key to the extension.
    return Buffer.from(JSON.stringify(payload)).toString("base64url") + ".replace-with-real-signature";
}

function createSession(license, activationId) {
    const sessionToken = randomToken();
    const requestSigningSecret = randomToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    sessions.set(sha256(sessionToken), {
        licenseHash: license.licenseKeyHash,
        activationId,
        requestSigningSecret,
        requestSecretHash: sha256(requestSigningSecret),
        expiresAt
    });
    return { sessionToken, requestSigningSecret, expiresAt };
}

function verifySignature(req, session) {
    const signature = String(req.get("X-KWV-Signature") || "");
    const timestamp = String(req.get("X-KWV-Timestamp") || "");
    const nonce = String(req.get("X-KWV-Nonce") || "");
    const appId = String(req.get("X-KWV-App-Id") || "");
    if (!signature || !timestamp || !nonce || !appId) return false;
    if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60 * 1000) return false;
    const nonceKey = `${appId}:${nonce}`;
    if (nonces.has(nonceKey)) return false;
    nonces.add(nonceKey);

    const body = req.body ? JSON.stringify(req.body) : "";
    const apiPath = req.path.replace(/^\/v1/, "");
    const canonical = [req.method.toUpperCase(), apiPath, timestamp, nonce, sha256(body)].join("\n");
    const expected = "sha256=" + crypto.createHmac("sha256", session.requestSigningSecret).update(canonical, "utf8").digest("hex");
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function assertLicenseUsable(license, deviceId) {
    if (!license) return "License key is invalid.";
    if (license.status !== "active") return "License is not active.";
    if (!["active", "lifetime"].includes(license.subscriptionStatus)) return "Subscription is not active.";
    if (license.expiresAt && Date.now() >= Date.parse(license.expiresAt)) return "License has expired.";
    if (license.deviceId && license.deviceId !== deviceId) return "This license is already activated on another device.";
    return "";
}

app.post("/v1/licenses/activate", (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const deviceId = String(body.deviceId || "");
    const keyHash = body.licenseKey ? licenseHash(body.licenseKey) : String(body.licenseKeyHash || "");
    const license = licenses.get(keyHash);
    const problem = assertLicenseUsable(license, deviceId);

    if (!license || problem) {
        const code = problem === "This license is already activated on another device." ? "DEVICE_ALREADY_BOUND" : "ACTIVATION_REJECTED";
        return reject(res, code === "DEVICE_ALREADY_BOUND" ? 409 : 403, code, problem || "License key is invalid.");
    }
    if (license.email !== email) return reject(res, 403, "EMAIL_NOT_REGISTERED", "Email does not match this license.");

    if (!license.deviceId) {
        license.deviceId = deviceId;
        license.activation = {
            id: randomToken(12),
            fingerprintVersion: body.fingerprintVersion,
            signalsHash: body.signalsHash,
            extensionVersion: body.extensionVersion,
            activatedAt: new Date().toISOString()
        };
    }

    license.licenseKeyHash = keyHash;
    license.lastVerifiedAt = new Date().toISOString();
    const session = createSession(license, license.activation.id);
    const offlineUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    res.json({
        active: true,
        sessionToken: session.sessionToken,
        requestSigningSecret: session.requestSigningSecret,
        offlineToken: makeOfflineToken({ deviceId, exp: Math.floor(Date.parse(offlineUntil) / 1000) }),
        activationDate: license.activation.activatedAt,
        lastVerificationAt: license.lastVerifiedAt,
        offlineUntil,
        licenseStatus: license.status,
        subscriptionStatus: license.subscriptionStatus,
        expiresAt: license.expiresAt
    });
});

app.post("/v1/licenses/verify", (req, res) => {
    const bearer = String(req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(sha256(bearer));
    if (!session || Date.now() >= Date.parse(session.expiresAt)) return reject(res, 401, "SESSION_INVALID", "License session expired.");
    if (!verifySignature(req, session)) return reject(res, 401, "BAD_SIGNATURE", "Request signature is invalid.");

    const body = req.body || {};
    const license = licenses.get(String(body.licenseKeyHash || ""));
    const problem = assertLicenseUsable(license, String(body.deviceId || ""));
    if (problem) return reject(res, 403, problem.indexOf("another device") >= 0 ? "DEVICE_ALREADY_BOUND" : "VERIFY_REJECTED", problem);

    license.lastVerifiedAt = new Date().toISOString();
    const offlineUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    res.json({
        active: true,
        lastVerificationAt: license.lastVerifiedAt,
        offlineUntil,
        offlineToken: makeOfflineToken({ deviceId: body.deviceId, exp: Math.floor(Date.parse(offlineUntil) / 1000) }),
        licenseStatus: license.status,
        subscriptionStatus: license.subscriptionStatus,
        expiresAt: license.expiresAt
    });
});

app.get("/health", (req, res) => {
    res.json({ ok: true, service: "kwv-license-server" });
});

seedDemoLicense();
app.listen(process.env.PORT || 8787, () => {
    console.log(`License API listening on ${process.env.PORT || 8787}`);
});
