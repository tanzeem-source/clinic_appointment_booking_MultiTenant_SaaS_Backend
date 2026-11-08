import { Router } from "express";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
  createDoctor,
  listMyDoctors,
  updateDoctor,
  setWeeklyAvailability,
  addOverride,
  removeOverride,
  getDoctorAvailability,
} from "../controllers/doctor.controller";
import { listDoctorReviews } from "../controllers/review.controller";

const router = Router();

// Clinic-admin routes that change what a clinic offers need an active
// subscription.
router.post(
  "/",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  createDoctor,
);
router.get(
  "/me",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  listMyDoctors,
);
router.put(
  "/:id",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  updateDoctor,
);
router.put(
  "/:id/availability",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  setWeeklyAvailability,
);

// Marking a doctor unavailable (and reopening the day) deliberately does NOT
// need an active subscription. An override only removes slots, it never
// creates bookings, and a lapsed clinic must still be able to flag patients
// who have already paid so it can move or refund them.
router.post(
  "/:id/overrides",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  addOverride,
);
router.delete(
  "/:id/overrides/:overrideId",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  removeOverride,
);

// Public — a GET on the same "/:id/availability" path as the admin PUT
// above; Express distinguishes them by method, so this is safe.
router.get("/:id/availability", getDoctorAvailability);
router.get("/:id/reviews", listDoctorReviews);

export default router;
