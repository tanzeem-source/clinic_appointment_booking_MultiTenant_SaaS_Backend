import { Request, Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  CreateDoctorSchema,
  UpdateDoctorSchema,
  SetWeeklyAvailabilitySchema,
  CreateOverrideSchema,
  DoctorIdParamSchema,
  OverrideIdParamSchema,
} from "../schemas/doctor.schemas";
import { ClinicIdRouteParamSchema } from "../schemas/clinic.schemas";
import { computeWeeklyAvailability } from "../services/availability.service";
import {
  createDoctorUnavailableNotification,
  createAppointmentRestoredNotification,
} from "../services/notification.service";

const DOCTOR_FIELD_TO_COLUMN: Record<string, string> = {
  name: "name",
  specialization: "specialization",
  slotDurationMinutes: "slotDurationMinutes",
  appointmentFeePaise: "appointmentFeePaise",
  isActive: "isActive",
};

// Confirms a doctor exists AND belongs to this tenant. Every mutating
// endpoint below calls this first, or one clinic could edit another
// clinic's doctors just by guessing a UUID.
const getOwnedDoctorOrThrow = async (doctorId: string, tenantId: string) => {
  const result = await pool.query(
    'SELECT * FROM "Doctor" WHERE id = $1 AND "tenantId" = $2',
    [doctorId, tenantId],
  );
  const doctor = result.rows[0];
  if (!doctor) throw new AppError("Doctor not found.", 404);
  return doctor;
};

export const createDoctor = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const data = CreateDoctorSchema.parse(req.body);

    const result = await pool.query(
      `INSERT INTO "Doctor" ("tenantId", name, specialization, "slotDurationMinutes", "appointmentFeePaise")
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        tenantId,
        data.name,
        data.specialization ?? null,
        data.slotDurationMinutes,
        data.appointmentFeePaise,
      ],
    );

    return res.status(201).json({ doctor: result.rows[0] });
  },
);

export const listMyDoctors = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const result = await pool.query(
      'SELECT * FROM "Doctor" WHERE "tenantId" = $1 ORDER BY "createdAt" ASC',
      [tenantId],
    );

    return res.status(200).json({ doctors: result.rows });
  },
);

export const updateDoctor = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id } = DoctorIdParamSchema.parse(req.params);

    await getOwnedDoctorOrThrow(id, tenantId);
    const data = UpdateDoctorSchema.parse(req.body);

    const fields = Object.keys(data);
    const setClause = fields
      .map((f, i) => `"${DOCTOR_FIELD_TO_COLUMN[f]}" = $${i + 1}`)
      .join(", ");
    const values = fields.map((f) => (data as any)[f]);

    const result = await pool.query(
      `UPDATE "Doctor" SET ${setClause}, "updatedAt" = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, id],
    );

    return res.status(200).json({ doctor: result.rows[0] });
  },
);

export const setWeeklyAvailability = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id } = DoctorIdParamSchema.parse(req.params);
    await getOwnedDoctorOrThrow(id, tenantId);

    const { ranges } = SetWeeklyAvailabilitySchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        'DELETE FROM "DoctorWeeklyAvailability" WHERE "doctorId" = $1',
        [id],
      );

      for (const r of ranges) {
        await client.query(
          `INSERT INTO "DoctorWeeklyAvailability" ("doctorId", "dayOfWeek", "startTime", "endTime")
         VALUES ($1, $2, $3, $4)`,
          [id, r.dayOfWeek, r.startTime, r.endTime],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const result = await pool.query(
      'SELECT * FROM "DoctorWeeklyAvailability" WHERE "doctorId" = $1 ORDER BY "dayOfWeek" ASC, "startTime" ASC',
      [id],
    );

    return res.status(200).json({ weeklyAvailability: result.rows });
  },
);

// Marks the doctor unavailable for a whole date. Any confirmed appointment on
// that date that hasn't started yet is flagged "needsReschedule" and its
// patient is told, in the same transaction. The response lists those
// bookings (patient name and phone only) so the admin can start calling.
//
// Every booking for this doctor and date is locked while this runs, so a
// payment confirming at the same moment is either flagged here or refused by
// confirmBooking, and never confirmed without being flagged.
export const addOverride = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id } = DoctorIdParamSchema.parse(req.params);
    await getOwnedDoctorOrThrow(id, tenantId);

    const data = CreateOverrideSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let override;
      try {
        const insertRes = await client.query(
          `INSERT INTO "DoctorDateOverride" ("doctorId", date, "isUnavailable", reason)
         VALUES ($1, $2, TRUE, $3) RETURNING *`,
          [id, data.date, data.reason ?? null],
        );
        override = insertRes.rows[0];
      } catch (err: any) {
        if (err.code === "23505") {
          throw new AppError("An override for this date already exists.", 409);
        }
        throw err;
      }

      const bookingsRes = await client.query(
        `SELECT b.id, b.status, b."visitStatus", b.date, b."startTime", b."endTime",
              u.name AS "patientName", u.phone AS "patientPhone"
       FROM "Booking" b
       JOIN "User" u ON u.id = b."patientId"
       WHERE b."doctorId" = $1 AND b.date = $2
       ORDER BY b."startTime" ASC
       FOR UPDATE OF b`,
        [id, data.date],
      );

      // date and startTime are plain local strings (see the DATE type parser in
      // config/db.ts), so this compares in the same local time as the rest of
      // the app. An appointment that has already started needs an outcome
      // recorded, not a reschedule.
      const now = new Date();
      const affected = bookingsRes.rows.filter(
        (b) =>
          b.status === "CONFIRMED" &&
          !b.visitStatus &&
          new Date(`${b.date}T${b.startTime}`) > now,
      );

      if (affected.length > 0) {
        await client.query(
          `UPDATE "Booking" SET "needsReschedule" = TRUE, "needsRescheduleAt" = NOW() WHERE id = ANY($1::uuid[])`,
          [affected.map((b) => b.id)],
        );

        // Behind a savepoint: if a notification fails, the bookings are still
        // flagged and the admin still sees them in the response.
        await client.query("SAVEPOINT override_notifications");
        try {
          for (const b of affected) {
            await createDoctorUnavailableNotification(client, b.id);
          }
          await client.query("RELEASE SAVEPOINT override_notifications");
        } catch (notifyErr) {
          await client.query("ROLLBACK TO SAVEPOINT override_notifications");
          console.error(
            "Failed to create doctor-unavailable notifications:",
            notifyErr,
          );
        }
      }

      await client.query("COMMIT");

      return res.status(201).json({
        override,
        affectedCount: affected.length,
        affectedBookings: affected.map((b) => ({
          id: b.id,
          date: b.date,
          startTime: String(b.startTime).slice(0, 5),
          endTime: String(b.endTime).slice(0, 5),
          patientName: b.patientName,
          patientPhone: b.patientPhone,
        })),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

// Reopens a day. Bookings that were flagged because of this override are
// cleared, and their patients are told the appointment is back on.
export const removeOverride = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id, overrideId } = OverrideIdParamSchema.parse(req.params);
    await getOwnedDoctorOrThrow(id, tenantId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const deleted = await client.query(
        'DELETE FROM "DoctorDateOverride" WHERE id = $1 AND "doctorId" = $2 RETURNING id, date',
        [overrideId, id],
      );
      if (deleted.rows.length === 0)
        throw new AppError("Override not found.", 404);
      const date = deleted.rows[0].date;

      const restoredRes = await client.query(
        `UPDATE "Booking" SET "needsReschedule" = FALSE, "needsRescheduleAt" = NULL
       WHERE "doctorId" = $1 AND date = $2 AND "needsReschedule" = TRUE AND status = 'CONFIRMED'
       RETURNING id`,
        [id, date],
      );

      if (restoredRes.rows.length > 0) {
        await client.query("SAVEPOINT restore_notifications");
        try {
          for (const b of restoredRes.rows) {
            await createAppointmentRestoredNotification(client, b.id);
          }
          await client.query("RELEASE SAVEPOINT restore_notifications");
        } catch (notifyErr) {
          await client.query("ROLLBACK TO SAVEPOINT restore_notifications");
          console.error(
            "Failed to create appointment-restored notifications:",
            notifyErr,
          );
        }
      }

      await client.query("COMMIT");

      return res
        .status(200)
        .json({
          message: "Override removed.",
          restoredBookings: restoredRes.rows.length,
        });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

// --- Public (patient-facing) ---

export const listClinicDoctors = asyncHandler(
  async (req: Request, res: Response) => {
    const { clinicId } = ClinicIdRouteParamSchema.parse(req.params);

    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d."slotDurationMinutes", d."appointmentFeePaise",
            d."averageRating", d."reviewCount"
     FROM "Doctor" d
     JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE d."tenantId" = $1
       AND d."isActive" = TRUE
       AND t."subscriptionStatus" = 'ACTIVE'
       AND (t."subscriptionExpiresAt" IS NULL OR t."subscriptionExpiresAt" > NOW())
     ORDER BY d.name ASC`,
      [clinicId],
    );

    return res.status(200).json({ doctors: result.rows });
  },
);

export const getDoctorAvailability = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = DoctorIdParamSchema.parse(req.params);

    const doctorRes = await pool.query(
      `SELECT d.*, t."subscriptionStatus", t."subscriptionExpiresAt"
     FROM "Doctor" d
     JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE d.id = $1 AND d."isActive" = TRUE`,
      [id],
    );
    const doctor = doctorRes.rows[0];
    if (!doctor) throw new AppError("Doctor not found.", 404);

    const isClinicActive =
      doctor.subscriptionStatus === "ACTIVE" &&
      (!doctor.subscriptionExpiresAt ||
        new Date(doctor.subscriptionExpiresAt) > new Date());
    if (!isClinicActive) throw new AppError("Doctor not found.", 404);

    const [weeklyRes, overridesRes, takenRes] = await Promise.all([
      pool.query(
        'SELECT "dayOfWeek", "startTime", "endTime" FROM "DoctorWeeklyAvailability" WHERE "doctorId" = $1',
        [id],
      ),
      pool.query(
        'SELECT date, "isUnavailable" FROM "DoctorDateOverride" WHERE "doctorId" = $1',
        [id],
      ),
      pool.query(
        `SELECT date, "startTime" FROM "Booking"
       WHERE "doctorId" = $1 AND (status = 'CONFIRMED' OR (status = 'PENDING_PAYMENT' AND "expiresAt" > NOW()))`,
        [id],
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

    const takenSet = new Set(
      takenRes.rows.map((r) => `${r.date}_${String(r.startTime).slice(0, 5)}`),
    );
    const availabilityWithoutTaken = availability.map((day) => ({
      date: day.date,
      slots: day.slots.filter((slot) => !takenSet.has(`${day.date}_${slot}`)),
    }));

    return res.status(200).json({
      doctor: {
        id: doctor.id,
        name: doctor.name,
        specialization: doctor.specialization,
        slotDurationMinutes: doctor.slotDurationMinutes,
        appointmentFeePaise: doctor.appointmentFeePaise,
        averageRating: doctor.averageRating,
        reviewCount: doctor.reviewCount,
      },
      availability: availabilityWithoutTaken,
    });
  },
);
