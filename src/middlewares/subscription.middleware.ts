import { Response, NextFunction } from "express";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "./auth.middleware";
import { asyncHandler } from "./error.middleware";

// Must run AFTER authenticateJWT (and normally requireRole).
// Checks the database on every request rather than trusting the JWT, so a
// status change (payment succeeded / lapsed) takes effect immediately
// without the user having to log in again.
export const requireActiveSubscription = asyncHandler(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return res
        .status(403)
        .json({ error: "No clinic associated with this account." });
    }

    const result = await pool.query(
      'SELECT "subscriptionStatus" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    const tenant = result.rows[0];

    if (!tenant) {
      return res.status(404).json({ error: "Clinic not found." });
    }

    if (tenant.subscriptionStatus !== "ACTIVE") {
      return res.status(402).json({
        error: "An active subscription is required to use this feature.",
        code: "SUBSCRIPTION_INACTIVE",
        subscriptionStatus: tenant.subscriptionStatus,
      });
    }

    next();
  },
);
