import { Request, Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  UpdateClinicSchema,
  SearchClinicsSchema,
  ClinicIdParamSchema,
} from "../schemas/clinic.schemas";

// Maps API field names to actual Tenant column names. Column names in the
// SQL below come from this fixed list, never from request input.
const FIELD_TO_COLUMN = {
  clinicName: "name",
  city: "city",
  address: "address",
  contactInfo: "contactInfo",
} as const;

// Columns safe to expose publicly. "email" is the clinic ADMIN's login
// email — never returned from a public endpoint.
const PUBLIC_CLINIC_COLUMNS = `id, name, city, address, "contactInfo", photos, "averageRating", "createdAt"`;

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

// Public — no auth. Only clinics with an active, unexpired subscription are
// findable, so an unpaid or lapsed clinic never appears to patients.
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
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// Public — no auth. Same active/unexpired guard as search, so a direct link
// to a lapsed clinic 404s instead of leaking its existence.
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
