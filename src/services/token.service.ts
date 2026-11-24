import jwt from "jsonwebtoken";
import ms from "ms";
import { env } from "../config/env";

export interface JwtPayload {
  userId: string;
  role: "PATIENT" | "CLINIC_ADMIN" | "CLINIC_STAFF";
  tenantId?: string | null;
  // Matches "User"."tokenVersion". When the user's version in the database is
  // bumped, every cookie carrying an older number stops working.
  tokenVersion: number;
}

export const signToken = (payload: JwtPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
};

export const verifyToken = (token: string): JwtPayload => {
  const decoded = jwt.verify(token, env.JWT_SECRET);

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as any).userId !== "string" ||
    typeof (decoded as any).role !== "string"
  ) {
    throw new Error("Malformed token payload");
  }

  const payload = decoded as any;

  return {
    userId: payload.userId,
    role: payload.role,
    tenantId: payload.tenantId ?? null,
    // Cookies issued before versions existed have none; version 0 matches the
    // column's default, so they keep working until their user is revoked.
    tokenVersion:
      typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0,
  };
};

export const AUTH_COOKIE_NAME = "auth_token";

// Shared so login/verify-otp (set) and logout (clear) can't drift out of
// sync on flags like `secure`/`sameSite` — a mismatch there is a common
// source of "cookie won't clear" bugs.
export const getAuthCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production", // requires HTTPS in prod; browsers silently drop `Secure` cookies over plain HTTP, so keep this false for local http:// dev
  sameSite: "lax" as const,
  maxAge: ms(env.JWT_EXPIRES_IN as ms.StringValue),
  path: "/",
});
