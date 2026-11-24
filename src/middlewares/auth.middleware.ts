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

// Verifies the cookie AND checks the database on every request, so a session
// can be ended at any time: a changed tokenVersion kills every cookie issued
// before it, and a deactivated account is turned away straight away.
export const authenticateJWT = asyncHandler(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = req.cookies?.[AUTH_COOKIE_NAME];

    if (!token) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    let payload: JwtPayload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(403).json({ error: "Invalid or expired session." });
    }

    const result = await pool.query(
      'SELECT "tokenVersion", "isActive" FROM "User" WHERE id = $1',
      [payload.userId],
    );
    const user = result.rows[0];

    // A missing user (deleted) is treated the same as a revoked session.
    if (!user || user.tokenVersion !== payload.tokenVersion) {
      return res.status(401).json({
        error: "Your session has ended. Please log in again.",
        code: "SESSION_REVOKED",
      });
    }

    if (user.isActive !== true) {
      return res
        .status(403)
        .json({ error: "This account has been deactivated." });
    }

    req.user = payload;
    next();
  },
);

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

// authenticateJWT now rejects deactivated accounts on every route, so this no
// longer needs its own database lookup. It's kept so routes that already list
// it don't have to change.
export const requireActiveUser = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
};
