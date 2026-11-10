import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import {
  getSubscription,
  createSubscriptionOrder,
  verifySubscriptionPayment,
} from "../controllers/payment.controller";
import {
  listSubscriptionInvoices,
  downloadSubscriptionInvoice,
} from "../controllers/invoice.controller";

const router = Router();

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please try again later." },
});

const pdfLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many downloads. Please try again later." },
});

// Deliberately NOT behind requireActiveSubscription: an unpaid clinic has
// to be able to reach these, or it could never pay.
router.get(
  "/subscription",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  getSubscription,
);
router.post(
  "/subscription/order",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  orderLimiter,
  createSubscriptionOrder,
);
router.post(
  "/subscription/verify",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  verifySubscriptionPayment,
);

// Receipts for subscription payments. Admin-only (billing), and outside the
// subscription gate so a lapsed clinic can still get its records.
router.get(
  "/subscription/invoices",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  listSubscriptionInvoices,
);
router.get(
  "/subscription/invoices/:id/pdf",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  pdfLimiter,
  downloadSubscriptionInvoice,
);

export default router;
