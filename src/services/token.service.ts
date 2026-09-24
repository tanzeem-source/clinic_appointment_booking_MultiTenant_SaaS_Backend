import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  userId: string;
  role: 'PATIENT' | 'CLINIC_ADMIN' | 'CLINIC_STAFF';
  tenantId?: string | null;
}

export const signToken = (payload: JwtPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

// jwt.verify only proves the token wasn't tampered with — it says nothing
// about payload shape, so we check that explicitly rather than trusting
// a bare `as` cast.
export const verifyToken = (token: string): JwtPayload => {
  const decoded = jwt.verify(token, env.JWT_SECRET);

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    typeof (decoded as any).userId !== 'string' ||
    typeof (decoded as any).role !== 'string'
  ) {
    throw new Error('Malformed token payload');
  }

  return decoded as JwtPayload;
};