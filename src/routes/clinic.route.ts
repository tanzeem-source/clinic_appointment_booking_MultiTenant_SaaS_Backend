import { Router, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  authenticateJWT,
  requireRole,
  requireActiveUser,
  AuthenticatedRequest,
} from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
  getMyClinic,
  updateMyClinic,
  listClinicBookings,
  searchClinics,
  getClinicById,
} from "../controllers/clinic.controller";
import {
  createStaff,
  listStaff,
  updateStaff,
} from "../controllers/staff.controller";
import { markVisitOutcome } from "../controllers/visit.controller";
import { listClinicDoctors } from "../controllers/doctor.controller";
import { listClinicReviews } from "../controllers/review.controller";

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

// Deliberately outside the subscription gate: patients have already paid for
// these appointments, so a lapsed clinic still needs to see who is coming and
// to confirm visits (which is what lets patients review them). Staff can use
// these too, but only while their account is active (checked against the
// database on every request).
router.get(
  "/me/bookings",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN", "CLINIC_STAFF"]),
  requireActiveUser,
  listClinicBookings,
);
router.patch(
  "/me/bookings/:id/visit",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN", "CLINIC_STAFF"]),
  requireActiveUser,
  markVisitOutcome,
);

// Staff management is admin-only. Creating staff needs an active subscription;
// listing and deactivating deliberately don't, so a lapsed clinic can still
// remove someone's access.
router.post(
  "/me/staff",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  createStaff,
);
router.get(
  "/me/staff",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  listStaff,
);
router.patch(
  "/me/staff/:id",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  updateStaff,
);

// TEMP: throwaway route to prove the subscription gate works. Delete it.
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
