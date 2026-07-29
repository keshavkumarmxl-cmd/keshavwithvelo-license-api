import crypto from "crypto";
import { config } from "../config.js";

function signature(payload) {
  return crypto.createHmac("sha256", config.downloadLinkSecret).update(payload).digest("base64url");
}

export function createDownloadToken({ email, licenseKey }) {
  const expiresAt = config.downloadLinkExpiryHours > 0
    ? Date.now() + (config.downloadLinkExpiryHours * 60 * 60 * 1000)
    : null;
  const payload = Buffer.from(JSON.stringify({ email, licenseKey, expiresAt })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function readDownloadToken(token) {
  const [payload, receivedSignature] = String(token || "").split(".");
  if (!payload || !receivedSignature) return null;

  const expectedSignature = signature(payload);
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(receivedSignature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.email || !data.licenseKey) return null;
    if (data.expiresAt !== null && (!Number.isFinite(data.expiresAt) || data.expiresAt < Date.now())) return null;
    return data;
  } catch {
    return null;
  }
}
