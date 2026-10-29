import { Request, Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  CreateReviewSchema,
  UpdateReviewSchema,
  RespondToReviewSchema,
  ReviewIdParamSchema,
  ListReviewsQuerySchema,
} from "../schemas/review.schemas";
import { ClinicIdParamSchema } from "../schemas/clinic.schemas";
import { DoctorIdParamSchema } from "../schemas/doctor.schemas";
import {
  recomputeTenantRating,
  recomputeDoctorRating,
} from "../services/review.service";

// patientId and bookingId are deliberately excluded: a review shown to the
// public, or returned to the clinic admin who responds to it, must never
// identify who wrote it. (bookingId would, once a clinic can see its own
// bookings.)
const PUBLIC_REVIEW_COLUMNS = `id, target, rating, text, "clinicResponse", "clinicResponseAt", "createdAt", "updatedAt"`;

export const createReview = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    const { bookingId, target, rating, text } = CreateReviewSchema.parse(
      req.body,
    );

    const bookingRes = await pool.query(
      'SELECT * FROM "Booking" WHERE id = $1 AND "patientId" = $2',
      [bookingId, patientId],
    );
    const booking = bookingRes.rows[0];
    if (!booking) throw new AppError("Booking not found.", 404);

    if (booking.status !== "CONFIRMED") {
      throw new AppError("Only completed appointments can be reviewed.", 422);
    }

    // A visit can be reviewed only once the clinic has recorded that it took
    // place. This replaces the old "appointment time has passed" rule, which let
    // a patient review a visit they never attended.
    if (booking.visitStatus === "NO_SHOW") {
      throw new AppError("Only visits that took place can be reviewed.", 422);
    }
    if (booking.visitStatus !== "COMPLETED") {
      throw new AppError(
        "The clinic has not confirmed this visit yet. You can review it once they do.",
        422,
      );
    }

    const doctorId = target === "DOCTOR" ? booking.doctorId : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let review;
      try {
        const insertRes = await client.query(
          `INSERT INTO "Review" ("bookingId", "patientId", "tenantId", "doctorId", target, rating, text)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PUBLIC_REVIEW_COLUMNS}`,
          [
            bookingId,
            patientId,
            booking.tenantId,
            doctorId,
            target,
            rating,
            text ?? null,
          ],
        );
        review = insertRes.rows[0];
      } catch (err: any) {
        if (err.code === "23505") {
          throw new AppError(
            `You have already submitted a ${target.toLowerCase()} review for this appointment.`,
            409,
          );
        }
        throw err;
      }

      if (target === "CLINIC") {
        await recomputeTenantRating(client, booking.tenantId);
      } else {
        await recomputeDoctorRating(client, booking.doctorId);
      }

      await client.query("COMMIT");
      return res.status(201).json({ review });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

export const updateReview = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);
    const { id } = ReviewIdParamSchema.parse(req.params);

    const existingRes = await pool.query(
      'SELECT * FROM "Review" WHERE id = $1 AND "patientId" = $2',
      [id, patientId],
    );
    const existing = existingRes.rows[0];
    if (!existing) throw new AppError("Review not found.", 404);

    const data = UpdateReviewSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const updateRes = await client.query(
        `UPDATE "Review" SET rating = COALESCE($1, rating), text = COALESCE($2, text), "updatedAt" = NOW()
       WHERE id = $3 RETURNING ${PUBLIC_REVIEW_COLUMNS}`,
        [data.rating ?? null, data.text ?? null, id],
      );
      const review = updateRes.rows[0];

      if (existing.target === "CLINIC") {
        await recomputeTenantRating(client, existing.tenantId);
      } else {
        await recomputeDoctorRating(client, existing.doctorId);
      }

      await client.query("COMMIT");
      return res.status(200).json({ review });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

export const respondToReview = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id } = ReviewIdParamSchema.parse(req.params);

    const { response } = RespondToReviewSchema.parse(req.body);

    // One atomic UPDATE: succeeds only if this review belongs to the clinic
    // AND has no response yet, so two simultaneous replies can't both win.
    const result = await pool.query(
      `UPDATE "Review" SET "clinicResponse" = $1, "clinicResponseAt" = NOW()
     WHERE id = $2 AND "tenantId" = $3 AND "clinicResponse" IS NULL
     RETURNING ${PUBLIC_REVIEW_COLUMNS}`,
      [response, id, tenantId],
    );

    if (result.rows.length === 0) {
      // Distinguish "not yours / doesn't exist" from "already answered".
      const existsRes = await pool.query(
        'SELECT 1 FROM "Review" WHERE id = $1 AND "tenantId" = $2',
        [id, tenantId],
      );
      if (existsRes.rows.length === 0)
        throw new AppError("Review not found.", 404);
      throw new AppError("This review has already been responded to.", 409);
    }

    return res.status(200).json({ review: result.rows[0] });
  },
);

// The patient's own reviews: the one place ids are returned, because the
// patient already knows they wrote them.
export const listMyReviews = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    const result = await pool.query(
      `SELECT r.*, d.name AS "doctorName", t.name AS "clinicName"
     FROM "Review" r
     JOIN "Tenant" t ON t.id = r."tenantId"
     LEFT JOIN "Doctor" d ON d.id = r."doctorId"
     WHERE r."patientId" = $1
     ORDER BY r."createdAt" DESC`,
      [patientId],
    );

    return res.status(200).json({ reviews: result.rows });
  },
);

// --- Public ---

export const listClinicReviews = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = ClinicIdParamSchema.parse(req.params);
    const { page, limit } = ListReviewsQuerySchema.parse(req.query);
    const offset = (page - 1) * limit;

    const tenantRes = await pool.query(
      `SELECT id FROM "Tenant" WHERE id = $1 AND "subscriptionStatus" = 'ACTIVE'
       AND ("subscriptionExpiresAt" IS NULL OR "subscriptionExpiresAt" > NOW())`,
      [id],
    );
    if (tenantRes.rows.length === 0)
      throw new AppError("Clinic not found.", 404);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT ${PUBLIC_REVIEW_COLUMNS} FROM "Review"
       WHERE target = 'CLINIC' AND "tenantId" = $1
       ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM "Review" WHERE target = 'CLINIC' AND "tenantId" = $1`,
        [id],
      ),
    ]);

    const total = countRes.rows[0].total;
    return res.status(200).json({
      reviews: rowsRes.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);

export const listDoctorReviews = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = DoctorIdParamSchema.parse(req.params);
    const { page, limit } = ListReviewsQuerySchema.parse(req.query);
    const offset = (page - 1) * limit;

    const doctorRes = await pool.query(
      `SELECT d.id FROM "Doctor" d JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE d.id = $1 AND d."isActive" = TRUE AND t."subscriptionStatus" = 'ACTIVE'
       AND (t."subscriptionExpiresAt" IS NULL OR t."subscriptionExpiresAt" > NOW())`,
      [id],
    );
    if (doctorRes.rows.length === 0)
      throw new AppError("Doctor not found.", 404);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT ${PUBLIC_REVIEW_COLUMNS} FROM "Review"
       WHERE target = 'DOCTOR' AND "doctorId" = $1
       ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM "Review" WHERE target = 'DOCTOR' AND "doctorId" = $1`,
        [id],
      ),
    ]);

    const total = countRes.rows[0].total;
    return res.status(200).json({
      reviews: rowsRes.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);
