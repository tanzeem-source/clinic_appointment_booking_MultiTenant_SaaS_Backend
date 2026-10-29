import { Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  MarkVisitSchema,
  BookingIdParamSchema,
} from "../schemas/visit.schemas";
import { createReviewRequestNotification } from "../services/notification.service";

const shapeBooking = (b: any) => ({
  id: b.id,
  date: b.date,
  startTime: String(b.startTime).slice(0, 5),
  endTime: String(b.endTime).slice(0, 5),
  visitStatus: b.visitStatus,
  visitMarkedAt: b.visitMarkedAt,
});

// Staff or admin records whether a patient's visit took place. Scoped to the
// clinic in the login token: another clinic's booking looks like "not found".
export const markVisitOutcome = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.userId;
    const role = req.user?.role;
    if (!tenantId || !userId)
      throw new AppError("No clinic associated with this account.", 400);

    const { id } = BookingIdParamSchema.parse(req.params);
    const { outcome } = MarkVisitSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the row so two people recording at once can't both succeed.
      const bookingRes = await client.query(
        `SELECT * FROM "Booking" WHERE id = $1 AND "tenantId" = $2 AND status = 'CONFIRMED' FOR UPDATE`,
        [id, tenantId],
      );
      const booking = bookingRes.rows[0];
      if (!booking) throw new AppError("Booking not found.", 404);

      // date and startTime are plain local strings (see the DATE type parser in
      // config/db.ts), so this compares in the same local time as the rest of
      // the app.
      const appointmentStart = new Date(`${booking.date}T${booking.startTime}`);
      if (appointmentStart > new Date()) {
        throw new AppError(
          "You can record the outcome once the appointment has started.",
          422,
        );
      }

      // Recording the same outcome again changes nothing.
      if (booking.visitStatus === outcome) {
        await client.query("COMMIT");
        return res.status(200).json({ booking: shapeBooking(booking) });
      }

      if (booking.visitStatus) {
        // Already recorded as something else: only the admin may change it.
        if (role !== "CLINIC_ADMIN") {
          throw new AppError(
            "This visit has already been recorded. Ask the clinic administrator to change it.",
            409,
          );
        }
        // And not once a review exists, or a review would sit on a visit that
        // is now recorded as not having happened.
        const reviewRes = await client.query(
          'SELECT 1 FROM "Review" WHERE "bookingId" = $1 LIMIT 1',
          [id],
        );
        if (reviewRes.rows.length > 0) {
          throw new AppError(
            "A review has already been written for this visit, so its outcome can no longer be changed.",
            409,
          );
        }
      }

      const updateRes = await client.query(
        `UPDATE "Booking"
       SET "visitStatus" = $1, "visitMarkedAt" = NOW(), "visitMarkedBy" = $2
       WHERE id = $3
       RETURNING id, date, "startTime", "endTime", "visitStatus", "visitMarkedAt"`,
        [outcome, userId, id],
      );

      if (outcome === "COMPLETED") {
        // Behind a savepoint, like the booking confirmation: if the notification
        // code ever fails, the outcome is still recorded.
        await client.query("SAVEPOINT review_request_notification");
        try {
          await createReviewRequestNotification(client, id);
          await client.query("RELEASE SAVEPOINT review_request_notification");
        } catch (notifyErr) {
          await client.query(
            "ROLLBACK TO SAVEPOINT review_request_notification",
          );
          console.error(
            "Failed to create review request notification:",
            notifyErr,
          );
        }
      }

      await client.query("COMMIT");
      return res.status(200).json({ booking: shapeBooking(updateRes.rows[0]) });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);
