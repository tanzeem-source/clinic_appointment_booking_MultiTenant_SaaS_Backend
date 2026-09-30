import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import {
  getSubscription,
  createSubscriptionOrder,
  verifySubscriptionPayment,
} from "../controllers/payment.controller";

const router = Router();

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please try again later." },
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

export default router;
