import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
  createReview,
  updateReview,
  respondToReview,
  listMyReviews,
} from "../controllers/review.controller";

const router = Router();

const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  "/",
  authenticateJWT,
  requireRole(["PATIENT"]),
  reviewLimiter,
  createReview,
);
router.put("/:id", authenticateJWT, requireRole(["PATIENT"]), updateReview);
router.get("/me", authenticateJWT, requireRole(["PATIENT"]), listMyReviews);
router.post(
  "/:id/respond",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  respondToReview,
);

export default router;
