import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function createAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, email: admin.email, role: "admin" },
    config.jwtSecret,
    { expiresIn: "8h" }
  );
}

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return res.status(401).json({ error: "Missing admin token" });

  try {
    req.admin = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid admin token" });
  }
}

export function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== config.downloadApiKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  return next();
}
