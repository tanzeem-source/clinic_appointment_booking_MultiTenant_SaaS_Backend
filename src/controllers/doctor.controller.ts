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
      // Full replace, not a merge — the simplest mental model for an admin
      // editing "my week": submit the whole week, the old ranges are gone.
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

export const addOverride = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id } = DoctorIdParamSchema.parse(req.params);
    await getOwnedDoctorOrThrow(id, tenantId);

    const data = CreateOverrideSchema.parse(req.body);

    try {
      const result = await pool.query(
        `INSERT INTO "DoctorDateOverride" ("doctorId", date, "isUnavailable", reason)
       VALUES ($1, $2, TRUE, $3) RETURNING *`,
        [id, data.date, data.reason ?? null],
      );
      return res.status(201).json({ override: result.rows[0] });
    } catch (err: any) {
      if (err.code === "23505") {
        throw new AppError("An override for this date already exists.", 409);
      }
      throw err;
    }
  },
);

export const removeOverride = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);
    const { id, overrideId } = OverrideIdParamSchema.parse(req.params);
    await getOwnedDoctorOrThrow(id, tenantId);

    const result = await pool.query(
      'DELETE FROM "DoctorDateOverride" WHERE id = $1 AND "doctorId" = $2 RETURNING id',
      [overrideId, id],
    );

    if (result.rows.length === 0)
      throw new AppError("Override not found.", 404);

    return res.status(200).json({ message: "Override removed." });
  },
);

// --- Public (patient-facing) ---

export const listClinicDoctors = asyncHandler(
  async (req: Request, res: Response) => {
    const { clinicId } = ClinicIdRouteParamSchema.parse(req.params);

    // Only doctors at a clinic with an active, unexpired subscription are
    // visible — same rule as clinic search on Day 5.
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d."slotDurationMinutes"
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
      startTime: String(r.startTime).slice(0, 5), // pg TIME comes back as "HH:MM:SS"
      endTime: String(r.endTime).slice(0, 5),
    }));
    const overrides = overridesRes.rows.map((r) => ({
      date: r.date, // already "YYYY-MM-DD" — see setTypeParser in config/db.ts
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
      },
      availability: availabilityWithoutTaken,
    });
  },
);
