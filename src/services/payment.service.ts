import crypto from "crypto";
import { pool } from "../config/db";
import { env } from "../config/env";

export type ActivationResult =
  | "ACTIVATED"
  | "ALREADY_PAID"
  | "UNKNOWN_ORDER"
  | "AMOUNT_MISMATCH";

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

// Signature Razorpay Checkout returns to the browser after a payment.
export const verifyPaymentSignature = (
  orderId: string,
  paymentId: string,
  signature: string,
): boolean => {
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqual(expected, signature);
};

// Webhook signatures are computed over the RAW request body, so this takes
// the Buffer, not parsed JSON.
export const verifyWebhookSignature = (
  rawBody: Buffer,
  signature: string,
): boolean => {
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return safeEqual(expected, signature);
};

export const isSubscriptionActive = (
  status: string,
  expiresAt: Date | string | null,
): boolean => {
  if (status !== "ACTIVE") return false;
  if (!expiresAt) return true; // manually-activated rows (testing) have no expiry
  return new Date(expiresAt).getTime() > Date.now();
};

// The ONLY place subscriptionStatus becomes ACTIVE. Callers must have
// verified a signature first. Safe to call twice for the same order (the
// browser confirmation and the webhook can both arrive): the row lock plus
// the PAID check make the second call a no-op.
export const activateSubscription = async (
  orderId: string,
  paymentId: string,
  paidAmount?: number,
): Promise<ActivationResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const paymentRes = await client.query(
      'SELECT * FROM "Payment" WHERE "razorpayOrderId" = $1 FOR UPDATE',
      [orderId],
    );
    const payment = paymentRes.rows[0];

    if (!payment) {
      await client.query("COMMIT");
      return "UNKNOWN_ORDER";
    }
    if (payment.status === "PAID") {
      await client.query("COMMIT");
      return "ALREADY_PAID";
    }
    if (paidAmount !== undefined && paidAmount !== payment.amount) {
      await client.query("COMMIT");
      return "AMOUNT_MISMATCH";
    }

    await client.query(
      `UPDATE "Payment" SET status = 'PAID', "razorpayPaymentId" = $1, "paidAt" = NOW() WHERE id = $2`,
      [paymentId, payment.id],
    );

    // Renewals extend from the current expiry if it's still in the future.
    await client.query(
      `UPDATE "Tenant"
       SET "subscriptionStatus" = 'ACTIVE',
           "subscriptionExpiresAt" = GREATEST(COALESCE("subscriptionExpiresAt", NOW()), NOW()) + make_interval(days => $1),
           "updatedAt" = NOW()
       WHERE id = $2`,
      [env.SUBSCRIPTION_PERIOD_DAYS, payment.tenantId],
    );

    await client.query("COMMIT");
    return "ACTIVATED";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};
