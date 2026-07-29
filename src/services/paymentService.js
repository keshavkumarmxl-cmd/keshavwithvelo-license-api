import crypto from "crypto";
import Razorpay from "razorpay";
import Stripe from "stripe";
import { config } from "../config.js";
import { db } from "../db/connection.js";

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;
const razorpay = config.razorpay.keyId && config.razorpay.keySecret
  ? new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret })
  : null;

export const checkoutPlans = {
  "India Launch": {
    amount: 9900,
    currency: "INR",
    licenseType: "standard",
    description: "Keshav With Velo India Launch"
  },
  International: {
    amount: 100,
    currency: "USD",
    licenseType: "standard",
    description: "Keshav With Velo International"
  }
};

function formatPrice(amount, currency) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 100 === 0 ? 0 : 2
  }).format(amount / 100).replace("₹", "Rs ");
}

function rowToPlan(row) {
  return {
    key: row.plan_key,
    title: row.title,
    amount: row.amount,
    currency: row.currency,
    price: formatPrice(row.amount, row.currency),
    licenseType: row.license_type,
    description: row.description,
    isActive: Boolean(row.is_active)
  };
}

export function getCheckoutPlans() {
  const rows = db.prepare("SELECT * FROM product_plans ORDER BY rowid").all();
  return rows.map(rowToPlan);
}

function getPlan(planKey) {
  const row = db.prepare("SELECT * FROM product_plans WHERE plan_key = ? AND is_active = 1").get(planKey);
  if (row) return rowToPlan(row);

  const fallback = checkoutPlans[planKey] || checkoutPlans["India Launch"];
  return {
    key: planKey in checkoutPlans ? planKey : "India Launch",
    title: planKey in checkoutPlans ? planKey : "India Launch",
    amount: fallback.amount,
    currency: fallback.currency,
    price: formatPrice(fallback.amount, fallback.currency),
    licenseType: fallback.licenseType,
    description: fallback.description,
    isActive: true
  };
}

function normalizeCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

export function calculateCheckout({ plan, couponCode }) {
  const details = getPlan(plan);
  const code = normalizeCouponCode(couponCode);
  let discount = null;
  let finalAmount = details.amount;

  if (code) {
    const coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(code);
    const now = new Date();
    const expired = coupon?.expires_at && new Date(coupon.expires_at) < now;
    const limitReached = coupon?.max_redemptions && coupon.redeemed_count >= coupon.max_redemptions;
    const currencyMismatch = coupon?.currency && coupon.currency !== details.currency;

    if (!coupon || !coupon.is_active || expired || limitReached || currencyMismatch) {
      console.warn("[checkout coupon ignored]", {
        code,
        reason: !coupon
          ? "not_found"
          : !coupon.is_active
            ? "inactive"
            : expired
              ? "expired"
              : limitReached
                ? "limit_reached"
                : "currency_mismatch"
      });
      return {
        ...details,
        originalAmount: details.amount,
        amount: details.amount,
        price: formatPrice(details.amount, details.currency),
        originalPrice: formatPrice(details.amount, details.currency),
        discount: null,
        couponWarning: "Coupon ignored because it is invalid or expired."
      };
    }

    const discountAmount = coupon.discount_type === "percent"
      ? Math.floor(details.amount * Math.min(coupon.discount_value, 100) / 100)
      : Math.min(coupon.discount_value, details.amount);

    finalAmount = Math.max(100, details.amount - discountAmount);
    discount = {
      code,
      type: coupon.discount_type,
      value: coupon.discount_value,
      amount: discountAmount,
      label: `-${formatPrice(discountAmount, details.currency)}`
    };
  }

  return {
    ...details,
    originalAmount: details.amount,
    amount: finalAmount,
    price: formatPrice(finalAmount, details.currency),
    originalPrice: formatPrice(details.amount, details.currency),
    discount
  };
}

export async function createRazorpayOrder({ plan, productId, name, email, couponCode }) {
  if (!razorpay) {
    const error = new Error("Razorpay is not configured");
    error.statusCode = 503;
    throw error;
  }

  const details = calculateCheckout({ plan, couponCode });
  const receipt = `${productId}-${Date.now()}`.slice(0, 40);

  const order = await razorpay.orders.create({
    amount: details.amount,
    currency: details.currency,
    receipt,
    notes: {
      productId,
      plan,
      name,
      email,
      couponCode: details.discount?.code || ""
    }
  });

  return {
    keyId: config.razorpay.keyId,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    receipt: order.receipt,
    plan: details.key,
    couponCode: details.discount?.code || "",
    originalAmount: details.originalAmount,
    finalAmount: details.amount,
    discount: details.discount,
    licenseType: details.licenseType,
    description: details.description
  };
}

export async function verifyPayment({ paymentProvider, paymentId, razorpayOrderId, razorpaySignature }) {
  if (config.nodeEnv !== "production" && paymentProvider === "manual") {
    return { verified: true, amount: 9900, currency: "INR", raw: { mode: "manual-dev" } };
  }

  if (paymentProvider === "stripe") {
    if (!stripe) return { verified: false, reason: "Stripe is not configured" };

    const session = await stripe.checkout.sessions.retrieve(paymentId);
    if (session.payment_status !== "paid") {
      return { verified: false, reason: "Stripe payment is not paid" };
    }

    return {
      verified: true,
      amount: session.amount_total,
      currency: session.currency,
      raw: session
    };
  }

  if (paymentProvider === "razorpay") {
    if (!razorpay) return { verified: false, reason: "Razorpay is not configured" };

    const expected = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${razorpayOrderId}|${paymentId}`)
      .digest("hex");

    if (expected !== razorpaySignature) {
      return { verified: false, reason: "Razorpay signature verification failed" };
    }

    const payment = await razorpay.payments.fetch(paymentId);
    if (!["captured", "authorized"].includes(payment.status)) {
      return { verified: false, reason: "Razorpay payment is not captured" };
    }

    return {
      verified: true,
      amount: payment.amount,
      currency: payment.currency,
      raw: payment
    };
  }

  return { verified: false, reason: "Unsupported payment provider" };
}
