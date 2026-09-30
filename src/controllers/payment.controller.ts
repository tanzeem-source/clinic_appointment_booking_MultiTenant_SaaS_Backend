import { Request, Response } from "express";
import { pool } from "../config/db";
import { env } from "../config/env";
import { razorpay } from "../config/razorpay";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { VerifyPaymentSchema } from "../schemas/payment.schemas";
import {
  activateSubscription,
  isSubscriptionActive,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "../services/payment.service";

export const getSubscription = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const result = await pool.query(
      'SELECT "subscriptionStatus", "subscriptionExpiresAt" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    const tenant = result.rows[0];
    if (!tenant) throw new AppError("Clinic not found.", 404);

    return res.status(200).json({
      subscriptionStatus: tenant.subscriptionStatus,
      subscriptionExpiresAt: tenant.subscriptionExpiresAt,
      isActive: isSubscriptionActive(
        tenant.subscriptionStatus,
        tenant.subscriptionExpiresAt,
      ),
      priceInr: env.SUBSCRIPTION_AMOUNT_PAISE / 100,
      periodDays: env.SUBSCRIPTION_PERIOD_DAYS,
    });
  },
);

export const createSubscriptionOrder = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const order = await razorpay.orders.create({
      amount: env.SUBSCRIPTION_AMOUNT_PAISE,
      currency: "INR",
      receipt: `sub_${tenantId.slice(0, 8)}_${Date.now()}`, // Razorpay caps receipts at 40 chars
      notes: { tenantId, purpose: "SUBSCRIPTION" },
    });

    await pool.query(
      `INSERT INTO "Payment" ("tenantId", purpose, "razorpayOrderId", amount, currency)
     VALUES ($1, 'SUBSCRIPTION', $2, $3, 'INR')`,
      [tenantId, order.id, env.SUBSCRIPTION_AMOUNT_PAISE],
    );

    return res.status(201).json({
      orderId: order.id,
      amount: env.SUBSCRIPTION_AMOUNT_PAISE,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID, // public by design; the secret never leaves the server
    });
  },
);

// Called by the browser after Checkout succeeds.
export const verifySubscriptionPayment = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      VerifyPaymentSchema.parse(req.body);

    // Tenant ownership: a clinic can only confirm orders it created itself.
    const orderRes = await pool.query(
      'SELECT id FROM "Payment" WHERE "razorpayOrderId" = $1 AND "tenantId" = $2',
      [razorpay_order_id, tenantId],
    );
    if (orderRes.rows.length === 0) throw new AppError("Order not found.", 404);

    if (
      !verifyPaymentSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      )
    ) {
      throw new AppError("Payment verification failed.", 400);
    }

    await activateSubscription(razorpay_order_id, razorpay_payment_id);

    return res
      .status(200)
      .json({ message: "Payment verified. Subscription is active." });
  },
);

// Server-to-server call from Razorpay. Needs the RAW body (see server.ts).
export const handleWebhook = asyncHandler(
  async (req: Request, res: Response) => {
    const signature = req.header("x-razorpay-signature");
    const rawBody = req.body as Buffer;

    if (
      !signature ||
      !Buffer.isBuffer(rawBody) ||
      !verifyWebhookSignature(rawBody, signature)
    ) {
      throw new AppError("Invalid webhook signature.", 400);
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (payment?.order_id && payment?.id) {
        const result = await activateSubscription(
          payment.order_id,
          payment.id,
          payment.amount,
        );
        if (result === "AMOUNT_MISMATCH" || result === "UNKNOWN_ORDER") {
          console.warn(`Webhook ${result} for order ${payment.order_id}`);
        }
      }
    }

    // Always 200 for a valid signature so Razorpay doesn't keep retrying
    // events we deliberately ignore. Real failures throw above (-> 500 -> retry).
    return res.status(200).json({ received: true });
  },
);
