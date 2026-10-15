import { Response } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import {
  ListNotificationsQuerySchema,
  NotificationIdParamSchema,
} from "../schemas/notification.schemas";

const NOTIFICATION_COLUMNS = `id, type, title, body, data, "isRead", "createdAt", "readAt"`;

// Every query below is scoped to the logged-in user's own id, so nobody can
// read or mark someone else's notifications by guessing an id.

export const listMyNotifications = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);

    const { page, limit, unreadOnly } = ListNotificationsQuerySchema.parse(
      req.query,
    );
    const offset = (page - 1) * limit;

    const [rowsRes, countRes, unreadRes] = await Promise.all([
      pool.query(
        `SELECT ${NOTIFICATION_COLUMNS} FROM "Notification"
       WHERE "userId" = $1 AND ($2::boolean = FALSE OR "isRead" = FALSE)
       ORDER BY "createdAt" DESC LIMIT $3 OFFSET $4`,
        [userId, unreadOnly, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM "Notification"
       WHERE "userId" = $1 AND ($2::boolean = FALSE OR "isRead" = FALSE)`,
        [userId, unreadOnly],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS unread FROM "Notification" WHERE "userId" = $1 AND "isRead" = FALSE`,
        [userId],
      ),
    ]);

    const total = countRes.rows[0].total;

    return res.status(200).json({
      notifications: rowsRes.rows,
      unreadCount: unreadRes.rows[0].unread,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);

export const getUnreadCount = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);

    const result = await pool.query(
      `SELECT COUNT(*)::int AS unread FROM "Notification" WHERE "userId" = $1 AND "isRead" = FALSE`,
      [userId],
    );

    return res.status(200).json({ unreadCount: result.rows[0].unread });
  },
);

// Idempotent: marking an already-read notification read again is fine and
// keeps the original readAt.
export const markNotificationRead = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);
    const { id } = NotificationIdParamSchema.parse(req.params);

    const result = await pool.query(
      `UPDATE "Notification" SET "isRead" = TRUE, "readAt" = COALESCE("readAt", NOW())
     WHERE id = $1 AND "userId" = $2
     RETURNING ${NOTIFICATION_COLUMNS}`,
      [id, userId],
    );

    if (result.rows.length === 0)
      throw new AppError("Notification not found.", 404);

    return res.status(200).json({ notification: result.rows[0] });
  },
);

export const markAllNotificationsRead = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError("Not authenticated.", 401);

    const result = await pool.query(
      `UPDATE "Notification" SET "isRead" = TRUE, "readAt" = NOW()
     WHERE "userId" = $1 AND "isRead" = FALSE`,
      [userId],
    );

    return res.status(200).json({ updated: result.rowCount ?? 0 });
  },
);
