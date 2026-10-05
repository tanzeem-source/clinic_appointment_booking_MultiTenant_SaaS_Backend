import { pool } from "../config/db";
import { env } from "../config/env";

export type ReserveResult =
  | { ok: true; booking: any }
  | {
      ok: false;
      reason: "SLOT_TAKEN" | "SLOT_RESERVED" | "ALREADY_PENDING_SAME_PATIENT";
    };

// Atomically reserves a slot for payment. A row for (doctorId, date,
// startTime) is unique forever — an expired PENDING_PAYMENT row is
// reclaimed in place (UPDATE), not deleted and reinserted, which keeps a
// single UNIQUE constraint sufficient without needing a non-immutable
// partial index on expiry.
export const reserveBooking = async (
  doctorId: string,
  tenantId: string,
  patientId: string,
  date: string,
  startTime: string,
  endTime: string,
  amount: number,
): Promise<ReserveResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingRes = await client.query(
      `SELECT * FROM "Booking" WHERE "doctorId" = $1 AND date = $2 AND "startTime" = $3 FOR UPDATE`,
      [doctorId, date, startTime],
    );
    const existing = existingRes.rows[0];
    const now = Date.now();

    if (existing) {
      if (existing.status === "CONFIRMED") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "SLOT_TAKEN" };
      }

      const stillLive = new Date(existing.expiresAt).getTime() > now;
      if (stillLive) {
        await client.query("ROLLBACK");
        if (existing.patientId === patientId) {
          return { ok: false, reason: "ALREADY_PENDING_SAME_PATIENT" };
        }
        return { ok: false, reason: "SLOT_RESERVED" };
      }

      // Expired hold — reclaim this row for the new patient.
      const expiresAt = new Date(now + env.BOOKING_HOLD_MINUTES * 60 * 1000);
      const updateRes = await client.query(
        `UPDATE "Booking"
         SET "patientId" = $1, status = 'PENDING_PAYMENT', amount = $2,
             "razorpayOrderId" = NULL, "razorpayPaymentId" = NULL,
             "expiresAt" = $3, "createdAt" = NOW(), "confirmedAt" = NULL
         WHERE id = $4 RETURNING *`,
        [patientId, amount, expiresAt, existing.id],
      );
      await client.query("COMMIT");
      return { ok: true, booking: updateRes.rows[0] };
    }

    const expiresAt = new Date(now + env.BOOKING_HOLD_MINUTES * 60 * 1000);
    const insertRes = await client.query(
      `INSERT INTO "Booking" ("doctorId", "tenantId", "patientId", date, "startTime", "endTime", amount, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        doctorId,
        tenantId,
        patientId,
        date,
        startTime,
        endTime,
        amount,
        expiresAt,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, booking: insertRes.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export type ConfirmResult =
  | "CONFIRMED"
  | "ALREADY_CONFIRMED"
  | "UNKNOWN_ORDER"
  | "AMOUNT_MISMATCH"
  | "EXPIRED";

// The ONLY place a booking becomes CONFIRMED. Called from both the
// browser-confirmation path and the webhook, same pattern as
// activateSubscription on Day 4. EXPIRED is a genuine edge case: payment
// arrived after the hold window lapsed. No auto-refund is built for this
// yet — it needs a manual refund, flagged here rather than silently
// confirming a booking whose slot may already belong to someone else.
export const confirmBooking = async (
  orderId: string,
  paymentId: string,
  paidAmount?: number,
): Promise<ConfirmResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      'SELECT * FROM "Booking" WHERE "razorpayOrderId" = $1 FOR UPDATE',
      [orderId],
    );
    const booking = res.rows[0];

    if (!booking) {
      await client.query("COMMIT");
      return "UNKNOWN_ORDER";
    }
    if (booking.status === "CONFIRMED") {
      await client.query("COMMIT");
      return "ALREADY_CONFIRMED";
    }
    if (paidAmount !== undefined && paidAmount !== booking.amount) {
      await client.query("COMMIT");
      return "AMOUNT_MISMATCH";
    }
    if (new Date(booking.expiresAt).getTime() < Date.now()) {
      await client.query("COMMIT");
      return "EXPIRED";
    }

    await client.query(
      `UPDATE "Booking" SET status = 'CONFIRMED', "razorpayPaymentId" = $1, "confirmedAt" = NOW() WHERE id = $2`,
      [paymentId, booking.id],
    );
    await client.query("COMMIT");
    return "CONFIRMED";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};
