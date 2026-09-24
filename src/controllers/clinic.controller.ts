import { Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { UpdateClinicSchema } from "../schemas/clinic.schemas";

export const getMyClinic = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    // requireRole already confirms role === CLINIC_ADMIN, but tenantId can
    // still be null/undefined on a malformed token — guard explicitly
    // rather than letting a bad query run with tenantId = undefined.
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

    // Build the SET clause dynamically from only the fields actually sent,
    // so a partial update doesn't overwrite untouched columns with NULL.
    const fields = Object.keys(data) as Array<keyof typeof data>;
    const setClause = fields
      .map((field, i) => `"${field}" = $${i + 1}`)
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
