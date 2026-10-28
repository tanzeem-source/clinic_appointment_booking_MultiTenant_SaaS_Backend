import crypto from "crypto";
import bcrypt from "bcryptjs";
import { Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  CreateStaffSchema,
  UpdateStaffSchema,
  StaffIdParamSchema,
} from "../schemas/staff.schemas";

// Never returns the password hash or any code columns.
const STAFF_COLUMNS = `id, name, email, phone, "isActive"`;

export const createStaff = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { name, email, phone } = CreateStaffSchema.parse(req.body);

    // The account starts with a random password that nobody knows, so it can't
    // be logged into until the staff member sets their own through
    // forgot-password. The code for that goes to THEIR email, which also proves
    // they own it. isVerified is TRUE only so forgot-password will accept the
    // account; it grants no access by itself.
    const unusablePasswordHash = await bcrypt.hash(
      crypto.randomBytes(32).toString("hex"),
      10,
    );

    try {
      const result = await pool.query(
        `INSERT INTO "User" (name, email, "passwordHash", role, "tenantId", "isVerified", phone)
       VALUES ($1, $2, $3, 'CLINIC_STAFF', $4, TRUE, $5)
       RETURNING ${STAFF_COLUMNS}`,
        [name, email, unusablePasswordHash, tenantId, phone ?? null],
      );

      return res.status(201).json({
        staff: result.rows[0],
        message:
          'Staff account created. They can set a password using "forgot password" with this email.',
      });
    } catch (err: any) {
      if (err.code === "23505") {
        throw new AppError("A user with this email already exists.", 409);
      }
      throw err;
    }
  },
);

export const listStaff = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const result = await pool.query(
      `SELECT ${STAFF_COLUMNS} FROM "User"
     WHERE "tenantId" = $1 AND role = 'CLINIC_STAFF'
     ORDER BY name ASC`,
      [tenantId],
    );

    return res.status(200).json({ staff: result.rows });
  },
);

// The WHERE clause is the safety net: it only matches STAFF of THIS clinic, so
// an admin can't touch another clinic's staff, other admins, or patients by
// guessing an id. Anything else looks like "not found".
export const updateStaff = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { id } = StaffIdParamSchema.parse(req.params);
    const data = UpdateStaffSchema.parse(req.body);

    const result = await pool.query(
      `UPDATE "User"
     SET name = COALESCE($1, name), phone = COALESCE($2, phone), "isActive" = COALESCE($3, "isActive")
     WHERE id = $4 AND "tenantId" = $5 AND role = 'CLINIC_STAFF'
     RETURNING ${STAFF_COLUMNS}`,
      [
        data.name ?? null,
        data.phone ?? null,
        data.isActive ?? null,
        id,
        tenantId,
      ],
    );

    if (result.rows.length === 0)
      throw new AppError("Staff member not found.", 404);

    return res.status(200).json({ staff: result.rows[0] });
  },
);
