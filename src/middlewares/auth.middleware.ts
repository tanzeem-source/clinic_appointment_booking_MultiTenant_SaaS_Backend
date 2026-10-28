import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";
import {
  verifyToken,
  JwtPayload,
  AUTH_COOKIE_NAME,
} from "../services/token.service";
import { asyncHandler } from "./error.middleware";

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export const authenticateJWT = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  const token = req.cookies?.[AUTH_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: "Not authenticated." });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired session." });
  }
};

export const requireRole = (roles: Array<JwtPayload["role"]>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: "Forbidden: Insufficient privileges" });
    }
    next();
  };
};

// Checks the database on every request, so deactivating someone takes effect
// immediately instead of waiting for their 7-day cookie to expire. Use it
// after authenticateJWT on routes staff can reach.
export const requireActiveUser = asyncHandler(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    const result = await pool.query(
      'SELECT "isActive" FROM "User" WHERE id = $1',
      [userId],
    );
    if (!result.rows[0] || result.rows[0].isActive !== true) {
      return res
        .status(403)
        .json({ error: "This account has been deactivated." });
    }

    next();
  },
);
