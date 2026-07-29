import { z } from "zod";

function isYoutubeUrl(value) {
  if (!value) return true;
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return true;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host);
  } catch (error) {
    return false;
  }
}

const emailSchema = z.string()
  .transform((value) => String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u034F\u061C\u180E]/g, "").trim().toLowerCase())
  .pipe(z.string().email());

const licenseKeySchema = z.string()
  .transform((value) => String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u034F\u061C\u180E]/g, "").trim())
  .pipe(z.string().min(16).max(80));

export const purchaseSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  email: emailSchema.optional(),
  productId: z.string().trim().min(2),
  paymentProvider: z.enum(["manual", "stripe", "razorpay"]),
  paymentId: z.string().trim().min(2),
  razorpayOrderId: z.string().trim().optional(),
  razorpaySignature: z.string().trim().optional(),
  couponCode: z.string().trim().max(40).optional(),
  licenseType: z.enum(["standard", "lifetime", "trial"]).default("standard")
});

export const razorpayOrderSchema = z.object({
  productId: z.string().trim().min(2),
  plan: z.enum(["India Launch", "International"]).default("India Launch"),
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  couponCode: z.string().trim().max(40).optional()
});

export const activateSchema = z.object({
  email: emailSchema,
  licenseKey: licenseKeySchema,
  deviceFingerprint: z.string().trim().min(8).max(512)
});

export const verifyLicenseSchema = z.object({
  licenseKey: licenseKeySchema,
  deviceFingerprint: z.string().trim().min(8).max(512)
});

export const downloadSchema = z.object({
  email: emailSchema,
  licenseKey: licenseKeySchema
});

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(8)
});

export const manualLicenseSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  licenseType: z.enum(["standard", "lifetime", "trial"]).default("standard"),
  expiryDays: z.number().int().min(0).max(3650).optional()
});

export const versionSchema = z.object({
  version: z.string().trim().min(1).max(40),
  downloadPath: z.string().trim().min(3),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().default(false)
});

export const tutorialVideoSchema = z.object({
  youtubeUrl: z.string().trim().max(300).refine(isYoutubeUrl, "Enter a valid YouTube link or video ID")
});

export const offerBannerSchema = z.object({
  text: z.string().trim().max(220),
  isActive: z.boolean().default(true)
});

export const maintenanceSchema = z.object({
  isActive: z.boolean().default(false),
  message: z.string().trim().max(220).optional()
});

export const planSchema = z.object({
  title: z.string().trim().min(2).max(80),
  amount: z.number().int().min(100).max(99999999),
  currency: z.string().trim().min(3).max(3).transform((value) => value.toUpperCase()),
  licenseType: z.enum(["standard", "lifetime", "trial"]).default("standard"),
  description: z.string().trim().min(2).max(160),
  isActive: z.boolean().default(true)
});

export const couponSchema = z.object({
  code: z.string().trim().min(2).max(40).transform((value) => value.toUpperCase()),
  discountType: z.enum(["percent", "fixed"]),
  discountValue: z.number().int().min(1).max(99999999),
  currency: z.string().trim().max(3).optional().transform((value) => value ? value.toUpperCase() : ""),
  maxRedemptions: z.number().int().min(1).max(1000000).optional().nullable(),
  expiresAt: z.string().trim().max(40).optional().nullable(),
  isActive: z.boolean().default(true)
});
