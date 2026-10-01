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

const router = Router();

// Clinic-admin routes — behind the subscription gate, since managing
// doctors and schedules is a paid feature.
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
router.post(
  "/:id/overrides",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  addOverride,
);
router.delete(
  "/:id/overrides/:overrideId",
  authenticateJWT,
  requireRole(["CLINIC_ADMIN"]),
  requireActiveSubscription,
  removeOverride,
);

// Public — a GET on the same "/:id/availability" path as the admin PUT
// above; Express distinguishes them by method, so this is safe.
router.get("/:id/availability", getDoctorAvailability);

export default router;
