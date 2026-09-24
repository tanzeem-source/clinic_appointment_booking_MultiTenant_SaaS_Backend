import { Request, Response, NextFunction } from "express";
import {
  verifyToken,
  JwtPayload,
  AUTH_COOKIE_NAME,
} from "../services/token.service";

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
