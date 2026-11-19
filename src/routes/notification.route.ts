import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  authenticateJWT,
  requireRole,
  requireActiveUser,
} from "../middlewares/auth.middleware";
import {
  listMyNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "../controllers/notification.controller";
import { streamMyNotifications } from "../controllers/stream.controller";

const router = Router();

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300, // an inbox badge may poll, so this is generous
  standardHeaders: true,
  legacyHeaders: false,
});

const streamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many live connections. Please try again later." },
});

// Any logged-in role has an inbox. Deliberately NOT behind the subscription
// gate: a clinic whose subscription lapsed still needs to see its notices.
const anyRole = requireRole(["PATIENT", "CLINIC_ADMIN", "CLINIC_STAFF"]);

// Live nudges for the inbox badge. requireActiveUser means a deactivated
// staff account can't open one.
router.get(
  "/stream",
  authenticateJWT,
  anyRole,
  requireActiveUser,
  streamLimiter,
  streamMyNotifications,
);

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
