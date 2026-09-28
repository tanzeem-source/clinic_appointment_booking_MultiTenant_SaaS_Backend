import { Router, Response } from "express";
import {
  authenticateJWT,
  requireRole,
  AuthenticatedRequest,
} from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
  getMyClinic,
  updateMyClinic,
  getMySubscription,
} from "../controllers/clinic.controller";

const router = Router();

// Profile + subscription status: always reachable for a logged-in clinic admin
router.get("/me", authenticateJWT, requireRole(["CLINIC_ADMIN"]), getMyClinic);
router.put(
  "/me",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  updateMyClinic,
);
router.get(
  "/me/subscription",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  getMySubscription,
);

// TEMP: throwaway route to prove the gate works before slots exist.
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

export default router;
