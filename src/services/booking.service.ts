import { pool } from "../config/db";
import { env } from "../config/env";
import { razorpay } from "../config/razorpay";
import { AppError } from "../middlewares/error.middleware";

export type ReserveResult =
  | { ok: true; booking: any }
  | {
      ok: false;
      reason: "SLOT_TAKEN" | "SLOT_RESERVED" | "ALREADY_PENDING_SAME_PATIENT";
    };

// Atomically reserves a slot for payment. A row for (doctorId, date,
// startTime) is unique forever — an expired PENDING_PAYMENT row is
// reclaimed in place (UPDATE), never deleted and reinserted.
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
    const expiresAt = new Date(now + env.BOOKING_HOLD_MINUTES * 60 * 1000);

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

      // Expired hold — reclaim in place. The WHERE re-checks "still pending
      // AND still expired" so this can never overwrite a fresh hold, even if
      // the code above is refactored. (It uses the database clock; if it
      // disagrees with the app clock by a hair, the safe outcome is a
      // harmless SLOT_RESERVED and a retry.) The previous order id is
      // cleared here, but its history lives on in "BookingPayment".
      const updateRes = await client.query(
        `UPDATE "Booking"
         SET "patientId" = $1, status = 'PENDING_PAYMENT', amount = $2,
             "razorpayOrderId" = NULL, "razorpayPaymentId" = NULL,
             "expiresAt" = $3, "createdAt" = NOW(), "confirmedAt" = NULL
         WHERE id = $4 AND status = 'PENDING_PAYMENT' AND "expiresAt" <= NOW()
         RETURNING *`,
        [patientId, amount, expiresAt, existing.id],
      );
      if (updateRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "SLOT_RESERVED" };
      }
      await client.query("COMMIT");
      return { ok: true, booking: updateRes.rows[0] };
    }

    // No row exists yet, so there was nothing to lock above: two requests can
    // both reach this INSERT. The unique constraint picks the winner; the
    // loser lands in the catch below.
    try {
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
    } catch (err: any) {
      if (err.code === "23505") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "SLOT_RESERVED" };
      }
      throw err;
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// Records a freshly created Razorpay order: sets it as the booking's current
// order AND writes the permanent payment record, in one transaction.
export const attachOrderToBooking = async (
  booking: any,
  orderId: string,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const updateRes = await client.query(
      `UPDATE "Booking" SET "razorpayOrderId" = $1
       WHERE id = $2 AND "patientId" = $3 AND status = 'PENDING_PAYMENT'
       RETURNING id`,
      [orderId, booking.id, booking.patientId],
    );
    if (updateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new AppError(
        "Your reservation is no longer valid. Please try again.",
        409,
      );
    }

    await client.query(
      `INSERT INTO "BookingPayment" ("bookingId", "patientId", "doctorId", date, "startTime", "razorpayOrderId", amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        booking.id,
        booking.patientId,
        booking.doctorId,
        booking.date,
        booking.startTime,
        orderId,
        booking.amount,
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export type ConfirmResult =
  | "CONFIRMED"
  | "ALREADY_CONFIRMED"
  | "REFUND_NEEDED" // money captured but the slot can't be honoured
  | "REFUNDED" // already refunded earlier
  | "UNKNOWN_ORDER";

// The ONLY place a booking becomes CONFIRMED. Called from the browser
// confirmation and the webhook; safe to call repeatedly for the same order.
//
// A late payment is honoured if the booking row still belongs to this very
// order (nobody reclaimed the slot). Otherwise — or if the paid amount
// doesn't match the order — the payment is marked REFUND_PENDING and the
// caller runs processRefund().
//
// Lock order is Booking first, then BookingPayment. reserveBooking only
// locks Booking, so the two can't deadlock.
export const confirmBooking = async (
  orderId: string,
  paymentId: string,
  paidAmount?: number,
): Promise<ConfirmResult> => {
  const peek = await pool.query(
    'SELECT "bookingId" FROM "BookingPayment" WHERE "razorpayOrderId" = $1',
    [orderId],
  );
  if (peek.rows.length === 0) return "UNKNOWN_ORDER";
  const bookingId = peek.rows[0].bookingId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const bookingRes = await client.query(
      'SELECT * FROM "Booking" WHERE id = $1 FOR UPDATE',
      [bookingId],
    );
    const bpRes = await client.query(
      'SELECT * FROM "BookingPayment" WHERE "razorpayOrderId" = $1 FOR UPDATE',
      [orderId],
    );
    const booking = bookingRes.rows[0];
    const bp = bpRes.rows[0];

    if (!bp) {
      await client.query("COMMIT");
      return "UNKNOWN_ORDER";
    }
    if (bp.status === "CONFIRMED") {
      await client.query("COMMIT");
      return "ALREADY_CONFIRMED";
    }
    if (bp.status === "REFUNDED") {
      await client.query("COMMIT");
      return "REFUNDED";
    }
    if (bp.status === "REFUND_PENDING") {
      await client.query("COMMIT");
      return "REFUND_NEEDED";
    }

    // status === 'CREATED'
    const amountOk = paidAmount === undefined || paidAmount === bp.amount;
    const slotStillOurs =
      !!booking &&
      booking.razorpayOrderId === orderId &&
      booking.patientId === bp.patientId &&
      booking.status === "PENDING_PAYMENT";

    if (amountOk && slotStillOurs) {
      await client.query(
        `UPDATE "Booking" SET status = 'CONFIRMED', "razorpayPaymentId" = $1, "confirmedAt" = NOW() WHERE id = $2`,
        [paymentId, booking.id],
      );
      await client.query(
        `UPDATE "BookingPayment" SET status = 'CONFIRMED', "razorpayPaymentId" = $1, "paidAt" = NOW() WHERE id = $2`,
        [paymentId, bp.id],
      );
      await client.query("COMMIT");
      return "CONFIRMED";
    }

    await client.query(
      `UPDATE "BookingPayment" SET status = 'REFUND_PENDING', "razorpayPaymentId" = $1, "paidAt" = NOW() WHERE id = $2`,
      [paymentId, bp.id],
    );
    await client.query("COMMIT");
    return "REFUND_NEEDED";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// Refunds a REFUND_PENDING payment in full. The row lock is held across the
// Razorpay calls so the browser path and the webhook can't both refund;
// whichever arrives second waits, then sees REFUNDED. This is a rare path,
// so holding one connection briefly is fine. Never throws on a Razorpay
// failure: it records the error, leaves the row REFUND_PENDING and returns
// 'FAILED' so the caller can decide whether to retry.
export const processRefund = async (
  orderId: string,
): Promise<"REFUNDED" | "FAILED"> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const bpRes = await client.query(
      'SELECT * FROM "BookingPayment" WHERE "razorpayOrderId" = $1 FOR UPDATE',
      [orderId],
    );
    const bp = bpRes.rows[0];

    if (!bp || !bp.razorpayPaymentId) {
      await client.query("COMMIT");
      return "FAILED";
    }
    if (bp.status === "REFUNDED") {
      await client.query("COMMIT");
      return "REFUNDED";
    }
    if (bp.status !== "REFUND_PENDING") {
      await client.query("COMMIT");
      return "FAILED";
    }

    try {
      // If an earlier attempt refunded at Razorpay but our DB update failed,
      // don't refund twice — just record it.
      const rp: any = await razorpay.payments.fetch(bp.razorpayPaymentId);
      let refundId: string | null = null;

      if (!(Number(rp.amount_refunded) >= Number(rp.amount))) {
        const refund: any = await razorpay.payments.refund(
          bp.razorpayPaymentId,
          {
            notes: {
              reason: "Slot no longer available",
              bookingId: bp.bookingId,
            },
          },
        );
        refundId = refund.id;
      }

      await client.query(
        `UPDATE "BookingPayment"
         SET status = 'REFUNDED', "refundId" = $1, "refundedAt" = NOW(), "refundError" = NULL
         WHERE id = $2`,
        [refundId, bp.id],
      );
      await client.query("COMMIT");
      return "REFUNDED";
    } catch (err: any) {
      const message =
        err?.error?.description || err?.message || "Unknown refund error";
      console.error(`Refund failed for order ${orderId}:`, message);
      await client.query(
        `UPDATE "BookingPayment" SET "refundError" = $1 WHERE id = $2`,
        [message, bp.id],
      );
      await client.query("COMMIT");
      return "FAILED";
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
