import { Response } from "express";
import { pool } from "../config/db";
import { env } from "../config/env";
import { razorpay } from "../config/razorpay";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  ReserveBookingSchema,
  VerifyBookingSchema,
} from "../schemas/booking.schemas";
import { computeWeeklyAvailability } from "../services/availability.service";
import { reserveBooking, confirmBooking } from "../services/booking.service";
import { verifyPaymentSignature } from "../services/payment.service";

export const createBookingReservation = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    const { doctorId, date, startTime } = ReserveBookingSchema.parse(req.body);

    const doctorRes = await pool.query(
      `SELECT d.*, t."subscriptionStatus", t."subscriptionExpiresAt"
     FROM "Doctor" d JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE d.id = $1 AND d."isActive" = TRUE`,
      [doctorId],
    );
    const doctor = doctorRes.rows[0];
    if (!doctor) throw new AppError("Doctor not found.", 404);

    const clinicActive =
      doctor.subscriptionStatus === "ACTIVE" &&
      (!doctor.subscriptionExpiresAt ||
        new Date(doctor.subscriptionExpiresAt) > new Date());
    if (!clinicActive) throw new AppError("Doctor not found.", 404);

    // Re-derive this doctor's legitimate availability server-side — never
    // trust a client-supplied date/time without checking it against the
    // actual weekly template and overrides. Whether the slot is currently
    // taken is checked atomically inside reserveBooking() below, not here —
    // checking it twice risks this check seeing stale data and masking the
    // more specific "it's your own pending hold" case that reserveBooking
    // knows how to report correctly.
    const [weeklyRes, overridesRes] = await Promise.all([
      pool.query(
        'SELECT "dayOfWeek", "startTime", "endTime" FROM "DoctorWeeklyAvailability" WHERE "doctorId" = $1',
        [doctorId],
      ),
      pool.query(
        'SELECT date, "isUnavailable" FROM "DoctorDateOverride" WHERE "doctorId" = $1',
        [doctorId],
      ),
    ]);

    const weeklyRanges = weeklyRes.rows.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startTime: String(r.startTime).slice(0, 5),
      endTime: String(r.endTime).slice(0, 5),
    }));
    const overrides = overridesRes.rows.map((r) => ({
      date: r.date,
      isUnavailable: r.isUnavailable,
    }));

    const availability = computeWeeklyAvailability(
      weeklyRanges,
      overrides,
      doctor.slotDurationMinutes,
    );
    const day = availability.find((d) => d.date === date);
    // Note: this only validates the slot exists in the doctor's template —
    // it does NOT check whether it's already taken. That's deliberately left
    // to the atomic reserveBooking() call below.
    if (!day || !day.slots.includes(startTime)) {
      throw new AppError("This slot is not available.", 422);
    }

    const [h, m] = startTime.split(":").map(Number);
    const endMinutes = h * 60 + m + doctor.slotDurationMinutes;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;

    const result = await reserveBooking(
      doctorId,
      doctor.tenantId,
      patientId,
      date,
      startTime,
      endTime,
      doctor.appointmentFeePaise,
    );

    if (!result.ok) {
      const messages: Record<string, string> = {
        SLOT_TAKEN: "This slot has already been booked.",
        SLOT_RESERVED:
          "This slot is currently being reserved by another patient. Please try again shortly.",
        ALREADY_PENDING_SAME_PATIENT:
          "You already have a pending reservation for this slot.",
      };
      throw new AppError(messages[result.reason], 409);
    }

    const booking = result.booking;

    const order = await razorpay.orders.create({
      amount: doctor.appointmentFeePaise,
      currency: "INR",
      receipt: `bkg_${booking.id.slice(0, 8)}_${Date.now()}`,
      notes: { bookingId: booking.id, doctorId, patientId },
    });

    await pool.query(
      'UPDATE "Booking" SET "razorpayOrderId" = $1 WHERE id = $2',
      [order.id, booking.id],
    );

    return res.status(201).json({
      bookingId: booking.id,
      orderId: order.id,
      amount: doctor.appointmentFeePaise,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID,
      holdExpiresAt: booking.expiresAt,
      date,
      startTime,
      endTime,
    });
  },
);

export const verifyBookingPayment = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      VerifyBookingSchema.parse(req.body);

    const bookingRes = await pool.query(
      'SELECT id FROM "Booking" WHERE "razorpayOrderId" = $1 AND "patientId" = $2',
      [razorpay_order_id, patientId],
    );
    if (bookingRes.rows.length === 0)
      throw new AppError("Booking not found.", 404);

    if (
      !verifyPaymentSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      )
    ) {
      throw new AppError("Payment verification failed.", 400);
    }

    const result = await confirmBooking(razorpay_order_id, razorpay_payment_id);

    if (result === "EXPIRED") {
      throw new AppError(
        "Payment was received but the reservation window had already expired. This needs a manual refund — contact support.",
        410,
      );
    }
    if (result === "UNKNOWN_ORDER")
      throw new AppError("Booking not found.", 404);
    if (result === "AMOUNT_MISMATCH")
      throw new AppError("Payment amount mismatch.", 400);

    return res.status(200).json({ message: "Booking confirmed." });
  },
);

export const listMyBookings = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    const result = await pool.query(
      `SELECT b.*, d.name AS "doctorName", t.name AS "clinicName"
     FROM "Booking" b
     JOIN "Doctor" d ON d.id = b."doctorId"
     JOIN "Tenant" t ON t.id = b."tenantId"
     WHERE b."patientId" = $1
       AND (b.status = 'CONFIRMED' OR (b.status = 'PENDING_PAYMENT' AND b."expiresAt" > NOW()))
     ORDER BY b.date ASC, b."startTime" ASC`,
      [patientId],
    );

    return res.status(200).json({ bookings: result.rows });
  },
);
