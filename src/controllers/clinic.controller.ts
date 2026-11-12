import { Request, Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  UpdateClinicSchema,
  SearchClinicsSchema,
  ClinicIdParamSchema,
  ListClinicBookingsQuerySchema,
} from "../schemas/clinic.schemas";
import { ACTIVE_CLINIC_SQL, containsPattern } from "../services/search.service";

const FIELD_TO_COLUMN = {
  clinicName: "name",
  city: "city",
  address: "address",
  contactInfo: "contactInfo",
} as const;

// Columns safe to expose publicly. "email" is the clinic ADMIN's login
// email — never returned from a public endpoint.
const PUBLIC_CLINIC_COLUMNS = `id, name, city, address, "contactInfo", photos, "averageRating", "reviewCount", "createdAt"`;

// The ORDER BY text comes only from this fixed map, never from the request,
// and every option ends in t.id so paging is stable when values tie.
const CLINIC_SORTS = {
  rating: `t."averageRating" DESC, t."reviewCount" DESC, t.name ASC, t.id ASC`,
  reviews: `t."reviewCount" DESC, t."averageRating" DESC, t.name ASC, t.id ASC`,
  name: `t.name ASC, t.id ASC`,
} as const;

// Today's date in the server's local time, as YYYY-MM-DD. The rest of the
// app treats dates as local, and the database clock is UTC, so using
// CURRENT_DATE would give the wrong day for part of every Indian morning.
const localDateString = (d: Date = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const getMyClinic = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const result = await pool.query('SELECT * FROM "Tenant" WHERE id = $1', [
      tenantId,
    ]);
    const clinic = result.rows[0];

    if (!clinic) throw new AppError("Clinic not found.", 404);

    return res.status(200).json({ clinic });
  },
);

export const updateMyClinic = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const data = UpdateClinicSchema.parse(req.body);

    const fields = Object.keys(data) as Array<keyof typeof FIELD_TO_COLUMN>;
    const setClause = fields
      .map((field, i) => `"${FIELD_TO_COLUMN[field]}" = $${i + 1}`)
      .join(", ");
    const values = fields.map((field) => data[field]);

    const result = await pool.query(
      `UPDATE "Tenant" SET ${setClause}, "updatedAt" = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, tenantId],
    );

    if (result.rows.length === 0) throw new AppError("Clinic not found.", 404);

    return res
      .status(200)
      .json({ message: "Clinic profile updated.", clinic: result.rows[0] });
  },
);

// The clinic's own confirmed appointments, scoped to the tenant in the
// login token. Shows only what the clinic needs to run the day and to
// reach a patient after a schedule change: the patient's name and phone.
// No email, no payment details, no patient id.
//
// The SQL below is assembled only from fixed fragments; every value from the
// request goes in as a bound parameter.
export const listClinicBookings = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { doctorId, from, to, visitStatus, needsReschedule, page, limit } =
      ListClinicBookingsQuerySchema.parse(req.query);
    const offset = (page - 1) * limit;

    const params: unknown[] = [tenantId, from ?? localDateString()];
    let where = `b."tenantId" = $1 AND b.status = 'CONFIRMED' AND b.date >= $2`;

    if (to) {
      params.push(to);
      where += ` AND b.date <= $${params.length}`;
    }
    if (doctorId) {
      params.push(doctorId);
      where += ` AND b."doctorId" = $${params.length}`;
    }
    if (visitStatus === "PENDING") {
      where += ` AND b."visitStatus" IS NULL`;
    } else if (visitStatus) {
      params.push(visitStatus);
      where += ` AND b."visitStatus" = $${params.length}`;
    }
    if (needsReschedule === true) {
      where += ` AND b."needsReschedule" = TRUE`;
    } else if (needsReschedule === false) {
      where += ` AND b."needsReschedule" = FALSE`;
    }

    const filterParams = [...params];
    params.push(limit, offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT b.id, b."doctorId", d.name AS "doctorName", b.date, b."startTime", b."endTime",
              b."confirmedAt", b."visitStatus", b."needsReschedule",
              u.name AS "patientName", u.phone AS "patientPhone"
       FROM "Booking" b
       JOIN "Doctor" d ON d.id = b."doctorId"
       JOIN "User" u ON u.id = b."patientId"
       WHERE ${where}
       ORDER BY b.date ASC, b."startTime" ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM "Booking" b WHERE ${where}`,
        filterParams,
      ),
    ]);

    const bookings = rowsRes.rows.map((r) => ({
      id: r.id,
      doctorId: r.doctorId,
      doctorName: r.doctorName,
      date: r.date,
      startTime: String(r.startTime).slice(0, 5),
      endTime: String(r.endTime).slice(0, 5),
      confirmedAt: r.confirmedAt,
      visitStatus: r.visitStatus,
      needsReschedule: r.needsReschedule,
      patientName: r.patientName,
      patientPhone: r.patientPhone,
    }));

    const total = countRes.rows[0].total;

    return res.status(200).json({
      bookings,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);

// Public. Only clinics with an active, unexpired subscription appear.
export const searchClinics = asyncHandler(
  async (req: Request, res: Response) => {
    const { city, q, specialization, minRating, sort, page, limit } =
      SearchClinicsSchema.parse(req.query);
    const offset = (page - 1) * limit;

    const params: unknown[] = [containsPattern(city)];
    let where = `${ACTIVE_CLINIC_SQL} AND t.city ILIKE $1`;

    if (q) {
      params.push(containsPattern(q));
      where += ` AND t.name ILIKE $${params.length}`;
    }
    if (minRating !== undefined) {
      params.push(minRating);
      where += ` AND t."averageRating" >= $${params.length}`;
    }
    if (specialization) {
      params.push(specialization);
      where += ` AND EXISTS (
      SELECT 1 FROM "Doctor" d
      WHERE d."tenantId" = t.id AND d."isActive" = TRUE AND d.specialization = $${params.length}
    )`;
    }

    const filterParams = [...params];
    params.push(limit, offset);

    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT ${PUBLIC_CLINIC_COLUMNS}
       FROM "Tenant" t
       WHERE ${where}
       ORDER BY ${CLINIC_SORTS[sort]}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM "Tenant" t WHERE ${where}`,
        filterParams,
      ),
    ]);

    const total = countResult.rows[0].total;

    return res.status(200).json({
      clinics: rowsResult.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);

export const getClinicById = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = ClinicIdParamSchema.parse(req.params);

    const result = await pool.query(
      `SELECT ${PUBLIC_CLINIC_COLUMNS}
     FROM "Tenant"
     WHERE id = $1
       AND "subscriptionStatus" = 'ACTIVE'
       AND ("subscriptionExpiresAt" IS NULL OR "subscriptionExpiresAt" > NOW())`,
      [id],
    );
    const clinic = result.rows[0];

    if (!clinic) throw new AppError("Clinic not found.", 404);

    return res.status(200).json({ clinic });
  },
);
