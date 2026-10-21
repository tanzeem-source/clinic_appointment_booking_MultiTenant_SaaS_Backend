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

const FIELD_TO_COLUMN = {
  clinicName: "name",
  city: "city",
  address: "address",
  contactInfo: "contactInfo",
} as const;

// Columns safe to expose publicly. "email" is the clinic ADMIN's login
// email — never returned from a public endpoint.
const PUBLIC_CLINIC_COLUMNS = `id, name, city, address, "contactInfo", photos, "averageRating", "reviewCount", "createdAt"`;

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

    const { doctorId, from, to, page, limit } =
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

    const filterParams = [...params];
    params.push(limit, offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT b.id, b."doctorId", d.name AS "doctorName", b.date, b."startTime", b."endTime",
              b."confirmedAt", u.name AS "patientName", u.phone AS "patientPhone"
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

export const searchClinics = asyncHandler(
  async (req: Request, res: Response) => {
    const { city, page, limit } = SearchClinicsSchema.parse(req.query);
    const offset = (page - 1) * limit;
    const cityPattern = `%${city}%`;

    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT ${PUBLIC_CLINIC_COLUMNS}
       FROM "Tenant"
       WHERE "subscriptionStatus" = 'ACTIVE'
         AND ("subscriptionExpiresAt" IS NULL OR "subscriptionExpiresAt" > NOW())
         AND city ILIKE $1
       ORDER BY "averageRating" DESC, name ASC
       LIMIT $2 OFFSET $3`,
        [cityPattern, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
       FROM "Tenant"
       WHERE "subscriptionStatus" = 'ACTIVE'
         AND ("subscriptionExpiresAt" IS NULL OR "subscriptionExpiresAt" > NOW())
         AND city ILIKE $1`,
        [cityPattern],
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
