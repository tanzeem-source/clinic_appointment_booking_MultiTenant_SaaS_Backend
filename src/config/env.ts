import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z
    .string()
    .min(10, "JWT_SECRET must be set and at least 10 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  EMAIL_FROM: z.string().default("Auth <onboarding@resend.dev>"),

  OTP_EXPIRY_MINUTES: z.coerce.number().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(60),

  RAZORPAY_KEY_ID: z.string().min(1, "RAZORPAY_KEY_ID is required"),
  RAZORPAY_KEY_SECRET: z.string().min(1, "RAZORPAY_KEY_SECRET is required"),
  RAZORPAY_WEBHOOK_SECRET: z
    .string()
    .min(1, "RAZORPAY_WEBHOOK_SECRET is required"),

  SUBSCRIPTION_AMOUNT_PAISE: z.coerce.number().int().positive().default(99900),
  SUBSCRIPTION_PERIOD_DAYS: z.coerce.number().int().positive().default(30),

  BOOKING_HOLD_MINUTES: z.coerce.number().int().positive().default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
