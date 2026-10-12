import { Router, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  authenticateJWT,
  requireRole,
  AuthenticatedRequest,
} from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
  getMyClinic,
  updateMyClinic,
  searchClinics,
  getClinicById,
} from "../controllers/clinic.controller";
import { listClinicDoctors } from "../controllers/doctor.controller";
import { listClinicReviews } from "../controllers/review.controller";

const router = Router();

const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/me", authenticateJWT, requireRole(["CLINIC_ADMIN"]), getMyClinic);
router.put(
  "/me",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  updateMyClinic,
);

router.get(
  "/me/gate-check",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  (_req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({ message: "Subscription active. Gate passed." });
  },
);

router.get("/search", searchLimiter, searchClinics);
router.get("/:clinicId/doctors", searchLimiter, listClinicDoctors);
router.get("/:id/reviews", searchLimiter, listClinicReviews);
router.get("/:id", searchLimiter, getClinicById);

export default router;
