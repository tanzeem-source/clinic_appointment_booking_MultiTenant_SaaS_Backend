import { Request, Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { DoctorIdParamSchema } from "../schemas/doctor.schemas";
import { ACTIVE_CLINIC_SQL } from "../services/search.service";
import {
  openStream,
  doctorStreams,
  userStreams,
} from "../services/realtime.service";

// Public. Only a doctor a patient could see in search can be watched, with the
// same rule as the availability endpoint: an active doctor at a clinic with an
// active, unexpired subscription.
export const streamDoctorAvailability = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = DoctorIdParamSchema.parse(req.params);

    const visible = await pool.query(
      `SELECT 1
     FROM "Doctor" d
     JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE d.id = $1 AND d."isActive" = TRUE AND ${ACTIVE_CLINIC_SQL}`,
      [id],
    );
    if (visible.rows.length === 0) throw new AppError("Doctor not found.", 404);

    if (!openStream(req, res, doctorStreams, id)) {
      throw new AppError(
        "Too many live connections right now. Please try again shortly.",
        503,
      );
    }
  },
);

// Logged-in users only; each user receives only their own events.
export const streamMyNotifications = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);

    if (!openStream(req, res, userStreams, userId)) {
      throw new AppError(
        "Too many live connections right now. Please try again shortly.",
        503,
      );
    }
  },
);
