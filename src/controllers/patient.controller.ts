import { Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { UpdatePatientProfileSchema } from "../schemas/patient.schemas";

const PROFILE_COLUMNS = `id, name, email, phone`;

export const getMyProfile = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);

    const result = await pool.query(
      `SELECT ${PROFILE_COLUMNS} FROM "User" WHERE id = $1`,
      [userId],
    );
    const profile = result.rows[0];
    if (!profile) throw new AppError("Profile not found.", 404);

    return res.status(200).json({ profile });
  },
);

export const updateMyProfile = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);

    const data = UpdatePatientProfileSchema.parse(req.body);

    // Only the fields actually sent are changed. Email is deliberately not
    // editable here (changing it needs re-verification, a later task).
    const result = await pool.query(
      `UPDATE "User" SET name = COALESCE($1, name), phone = COALESCE($2, phone)
     WHERE id = $3
     RETURNING ${PROFILE_COLUMNS}`,
      [data.name ?? null, data.phone ?? null, userId],
    );

    if (result.rows.length === 0) throw new AppError("Profile not found.", 404);

    return res.status(200).json({ profile: result.rows[0] });
  },
);
