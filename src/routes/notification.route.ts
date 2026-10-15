import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import {
  listMyNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "../controllers/notification.controller";

const router = Router();

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300, // an inbox badge may poll, so this is generous
  standardHeaders: true,
  legacyHeaders: false,
});

// Any logged-in role has an inbox. Deliberately NOT behind the subscription
// gate: a clinic whose subscription lapsed still needs to see its notices.
const anyRole = requireRole(["PATIENT", "CLINIC_ADMIN", "CLINIC_STAFF"]);

router.get(
  "/",
  authenticateJWT,
  anyRole,
  notificationLimiter,
  listMyNotifications,
);
router.get(
  "/unread-count",
  authenticateJWT,
  anyRole,
  notificationLimiter,
  getUnreadCount,
);
router.post(
  "/read-all",
  authenticateJWT,
  anyRole,
  notificationLimiter,
  markAllNotificationsRead,
);
router.patch(
  "/:id/read",
  authenticateJWT,
  anyRole,
  notificationLimiter,
  markNotificationRead,
);

export default router;
