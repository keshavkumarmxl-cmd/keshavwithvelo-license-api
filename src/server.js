import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import "./db/init.js";
import { publicRoutes } from "./routes/publicRoutes.js";
import { adminRoutes } from "./routes/adminRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false
}));

const allowedOrigins = new Set([
  ...config.frontendOrigins,
  "https://api.keshavwithvelo.in",
  "https://keshavwithvelo.in",
  "https://www.keshavwithvelo.in",
  "https://website-0fny.onrender.com",
  "http://localhost:8080",
  "file://"
].filter(Boolean));

app.use(cors({
  origin: config.nodeEnv === "production"
    ? (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        if (origin === "null") return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    : true,
  credentials: true
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 220,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", publicRoutes);
app.use("/api/admin", adminRoutes);
app.get("/admin.php", (req, res) => {
  res.sendFile(path.join(__dirname, "../admin/index.html"));
});
app.use("/admin", express.static(path.join(__dirname, "../admin")));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((error, req, res, next) => {
  console.error(error);
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal server error" : error.message,
    message: config.nodeEnv === "production" ? undefined : error.message
  });
});

app.listen(config.port, () => {
  console.log(`Licensing API running on http://localhost:${config.port}`);
});
