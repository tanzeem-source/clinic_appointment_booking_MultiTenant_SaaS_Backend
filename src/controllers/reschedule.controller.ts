import { Response } from "express";
import { Pool, PoolClient } from "pg";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { BookingIdParamSchema } from "../schemas/visit.schemas";
import {
  RescheduleBookingSchema,
  RescheduleOptionsQuerySchema,
} from "../schemas/reschedule.schemas";
import { getSlotsForDate } from "../services/availability.service";
import { processRefund } from "../services/booking.service";
import {
  createBookingRescheduledNotification,
  createBookingCancelledNotification,
} from "../services/notification.service";

type Db = Pool | PoolClient;

const addMinutes = (hhmm: string, minutes: number): string => {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

// The doctor a booking is being moved to: it must belong to this clinic and be
// active. Moving to a DIFFERENT doctor is only allowed if they charge the same
// fee that was paid; otherwise the patient would be over- or under-charged.
// (Staying with the same doctor is always allowed, even if their fee has
// changed since the booking was made.)
const loadTargetDoctor = async (
  db: Db,
  tenantId: string,
  booking: any,
  requestedDoctorId?: string,
) => {
  const doctorId = requestedDoctorId ?? booking.doctorId;

  const res = await db.query(
    'SELECT * FROM "Doctor" WHERE id = $1 AND "tenantId" = $2 AND "isActive" = TRUE',
    [doctorId, tenantId],
  );
  const doctor = res.rows[0];
  if (!doctor) throw new AppError("Doctor not found.", 404);

  if (
    doctor.id !== booking.doctorId &&
    doctor.appointmentFeePaise !== booking.amount
  ) {
    throw new AppError(
      "That doctor charges a different fee, so this booking can only move to a doctor with the same fee. " +
        "Otherwise cancel it with a refund instead.",
      422,
    );
  }
  return doctor;
};

// Start times on one date that a booking could be moved to: slots from the
// doctor's weekly hours, not overridden, still in the future, and with no
// booking row at all. Any existing row (even an expired unpaid hold or a
// cancelled booking) counts as occupied, because a slot can only ever have one
// row and a paid booking can't be moved onto someone else's.
const getFreeSlots = async (
  db: Db,
  doctor: any,
  dateStr: string,
): Promise<string[]> => {
  const [weeklyRes, overridesRes, existingRes] = await Promise.all([
    db.query(
      'SELECT "dayOfWeek", "startTime", "endTime" FROM "DoctorWeeklyAvailability" WHERE "doctorId" = $1',
      [doctor.id],
    ),
    db.query(
      'SELECT date, "isUnavailable" FROM "DoctorDateOverride" WHERE "doctorId" = $1',
      [doctor.id],
    ),
    db.query(
      'SELECT "startTime" FROM "Booking" WHERE "doctorId" = $1 AND date = $2',
      [doctor.id, dateStr],
    ),
  ]);

  const weeklyRanges = weeklyRes.rows.map((r: any) => ({
    dayOfWeek: r.dayOfWeek,
    startTime: String(r.startTime).slice(0, 5),
    endTime: String(r.endTime).slice(0, 5),
  }));
  const overrides = overridesRes.rows.map((r: any) => ({
    date: r.date,
    isUnavailable: r.isUnavailable,
  }));

  const slots = getSlotsForDate(
    weeklyRanges,
    overrides,
    doctor.slotDurationMinutes,
    dateStr,
  );
  const occupied = new Set(
    existingRes.rows.map((r: any) => String(r.startTime).slice(0, 5)),
  );
  const now = new Date();

  // date and startTime are plain local strings (see the DATE type parser in
  // config/db.ts), so this compares in the same local time as the rest of the app.
  return slots.filter(
    (s) => !occupied.has(s) && new Date(`${dateStr}T${s}`) > now,
  );
};

const assertWaitingForReschedule = (booking: any) => {
  if (booking.status !== "CONFIRMED") {
    throw new AppError("Only confirmed bookings can be rescheduled.", 409);
  }
  if (!booking.needsReschedule) {
    throw new AppError("This booking is not waiting to be rescheduled.", 409);
  }
};

export const getRescheduleOptions = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { id } = BookingIdParamSchema.parse(req.params);
    const { date, doctorId } = RescheduleOptionsQuerySchema.parse(req.query);

    const bookingRes = await pool.query(
      'SELECT * FROM "Booking" WHERE id = $1 AND "tenantId" = $2',
      [id, tenantId],
    );
    const booking = bookingRes.rows[0];
    if (!booking) throw new AppError("Booking not found.", 404);
    assertWaitingForReschedule(booking);

    const doctor = await loadTargetDoctor(pool, tenantId, booking, doctorId);
    const slots = await getFreeSlots(pool, doctor, date);

    return res.status(200).json({
      doctor: {
        id: doctor.id,
        name: doctor.name,
        slotDurationMinutes: doctor.slotDurationMinutes,
      },
      date,
      slots,
    });
  },
);

// Moves a paid booking to a new slot. The same booking row and payment are
// kept; only the doctor, date and time change, and a history row records the
// move. Admin only, and only for bookings that were flagged by a doctor
// override.
export const rescheduleBooking = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.userId;
    if (!tenantId || !userId)
      throw new AppError("No clinic associated with this account.", 400);

    const { id } = BookingIdParamSchema.parse(req.params);
    const { doctorId, date, startTime } = RescheduleBookingSchema.parse(
      req.body,
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const bookingRes = await client.query(
        'SELECT * FROM "Booking" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE',
        [id, tenantId],
      );
      const booking = bookingRes.rows[0];
      if (!booking) throw new AppError("Booking not found.", 404);
      assertWaitingForReschedule(booking);

      const doctor = await loadTargetDoctor(
        client,
        tenantId,
        booking,
        doctorId,
      );

      const freeSlots = await getFreeSlots(client, doctor, date);
      if (!freeSlots.includes(startTime)) {
        throw new AppError(
          "That slot is not available. Check the free slots for that date and pick one of them.",
          422,
        );
      }

      const endTime = addMinutes(startTime, doctor.slotDurationMinutes);
      const previousDate: string = booking.date;
      const previousStartTime = String(booking.startTime).slice(0, 5);

      let updated;
      try {
        const updateRes = await client.query(
          `UPDATE "Booking"
         SET "doctorId" = $1, date = $2, "startTime" = $3, "endTime" = $4,
             "needsReschedule" = FALSE, "needsRescheduleAt" = NULL
         WHERE id = $5
         RETURNING id, "doctorId", date, "startTime", "endTime"`,
          [doctor.id, date, startTime, endTime, id],
        );
        updated = updateRes.rows[0];
      } catch (err: any) {
        // Someone reserved that slot between the check above and this update.
        if (err.code === "23505") {
          throw new AppError(
            "That slot was just taken. Please pick another.",
            409,
          );
        }
        throw err;
      }

      await client.query(
        `INSERT INTO "BookingReschedule"
         ("bookingId", "fromDoctorId", "fromDate", "fromStartTime", "toDoctorId", "toDate", "toStartTime", "rescheduledBy")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          booking.doctorId,
          previousDate,
          previousStartTime,
          doctor.id,
          date,
          startTime,
          userId,
        ],
      );

      // Keep the payment record pointing at the booking's current slot.
      await client.query(
        `UPDATE "BookingPayment" SET "doctorId" = $1, date = $2, "startTime" = $3 WHERE "bookingId" = $4`,
        [doctor.id, date, startTime, id],
      );

      // Behind a savepoint, like the other notifications: if the message fails,
      // the move still happens.
      await client.query("SAVEPOINT reschedule_notification");
      try {
        await createBookingRescheduledNotification(client, id, {
          date: previousDate,
          startTime: previousStartTime,
        });
        await client.query("RELEASE SAVEPOINT reschedule_notification");
      } catch (notifyErr) {
        await client.query("ROLLBACK TO SAVEPOINT reschedule_notification");
        console.error("Failed to create reschedule notification:", notifyErr);
      }

      await client.query("COMMIT");

      return res.status(200).json({
        booking: {
          id: updated.id,
          doctorId: updated.doctorId,
          doctorName: doctor.name,
          date: updated.date,
          startTime: String(updated.startTime).slice(0, 5),
          endTime: String(updated.endTime).slice(0, 5),
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

// For a patient who can't be moved to a new time: cancels the booking, tells
// the patient, and refunds the full amount through the same refund code used
// for late payments. Only bookings flagged by a doctor override qualify, so
// this can't be used to refund an ordinary booking. If the refund fails, run
// the same request again to retry it.
export const cancelBookingWithRefund = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { id } = BookingIdParamSchema.parse(req.params);

    const client = await pool.connect();
    let orderId: string | null = null;

    try {
      await client.query("BEGIN");

      const bookingRes = await client.query(
        'SELECT * FROM "Booking" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE',
        [id, tenantId],
      );
      const booking = bookingRes.rows[0];
      if (!booking) throw new AppError("Booking not found.", 404);

      if (booking.status === "CANCELLED") {
        // Already cancelled: only retry a refund that hasn't gone through yet.
        const pendingRes = await client.query(
          `SELECT "razorpayOrderId" FROM "BookingPayment" WHERE "bookingId" = $1 AND status = 'REFUND_PENDING'`,
          [id],
        );
        orderId = pendingRes.rows[0]?.razorpayOrderId ?? null;

        if (!orderId) {
          await client.query("COMMIT");
          return res.status(200).json({
            booking: { id, status: "CANCELLED" },
            refund: "REFUNDED",
            message: "This booking was already cancelled and refunded.",
          });
        }
      } else {
        if (booking.status !== "CONFIRMED") {
          throw new AppError("Only confirmed bookings can be cancelled.", 409);
        }
        if (!booking.needsReschedule) {
          throw new AppError(
            "Only bookings waiting to be rescheduled can be cancelled with a refund. " +
              "Mark the doctor unavailable for that date first.",
            409,
          );
        }

        const paymentRes = await client.query(
          `SELECT * FROM "BookingPayment" WHERE "bookingId" = $1 AND status = 'CONFIRMED' FOR UPDATE`,
          [id],
        );
        const payment = paymentRes.rows[0];
        if (!payment || !payment.razorpayPaymentId) {
          throw new AppError(
            "No confirmed payment was found for this booking.",
            409,
          );
        }

        await client.query(
          `UPDATE "BookingPayment" SET status = 'REFUND_PENDING' WHERE id = $1`,
          [payment.id],
        );
        await client.query(
          `UPDATE "Booking" SET status = 'CANCELLED', "needsReschedule" = FALSE, "needsRescheduleAt" = NULL WHERE id = $1`,
          [id],
        );

        await client.query("SAVEPOINT cancel_notification");
        try {
          await createBookingCancelledNotification(client, id, payment.amount);
          await client.query("RELEASE SAVEPOINT cancel_notification");
        } catch (notifyErr) {
          await client.query("ROLLBACK TO SAVEPOINT cancel_notification");
          console.error(
            "Failed to create cancellation notification:",
            notifyErr,
          );
        }

        orderId = payment.razorpayOrderId;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (!orderId) throw new AppError("No payment found to refund.", 409);

    const refund = await processRefund(orderId);

    if (refund === "REFUNDED") {
      return res.status(200).json({
        booking: { id, status: "CANCELLED" },
        refund: "REFUNDED",
        message: "Booking cancelled and the patient has been refunded in full.",
      });
    }

    return res.status(200).json({
      booking: { id, status: "CANCELLED" },
      refund: "PENDING",
      message:
        "Booking cancelled, but the refund could not be completed yet. Send this request again to retry it.",
    });
  },
);
