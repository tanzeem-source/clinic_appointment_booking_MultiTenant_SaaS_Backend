import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import {
  createBookingReservation,
  verifyBookingPayment,
  listMyBookings,
} from "../controllers/booking.controller";

const router = Router();

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many booking attempts. Please try again later." },
});

router.post(
  "/",
  authenticateJWT,
  requireRole(["PATIENT"]),
  bookingLimiter,
  createBookingReservation,
);
router.post(
  "/verify",
  authenticateJWT,
  requireRole(["PATIENT"]),
  verifyBookingPayment,
);
router.get("/me", authenticateJWT, requireRole(["PATIENT"]), listMyBookings);

export default router;
