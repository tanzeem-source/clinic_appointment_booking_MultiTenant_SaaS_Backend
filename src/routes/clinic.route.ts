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

const router = Router();

const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Clinic-admin routes — specific paths, registered before the generic /:id below.
router.get("/me", authenticateJWT, requireRole(["CLINIC_ADMIN"]), getMyClinic);
router.put(
  "/me",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  updateMyClinic,
);

// TEMP: throwaway route to prove the subscription gate works before slots exist.
// Delete once the slots routes are behind requireActiveSubscription.
router.get(
  "/me/gate-check",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  (_req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({ message: "Subscription active. Gate passed." });
  },
);

// Public routes — no auth.
router.get("/search", searchLimiter, searchClinics);
router.get("/:id", searchLimiter, getClinicById);

export default router;
