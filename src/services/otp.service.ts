import crypto from 'crypto';
import { env } from '../config/env';

export const generateOtp = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Only the hash is ever stored — a DB leak alone can't be used to verify OTPs.
export const hashOtp = (otp: string): string => {
  return crypto.createHash('sha256').update(otp).digest('hex');
};

export const otpExpiryDate = (): Date => {
  return new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);
};