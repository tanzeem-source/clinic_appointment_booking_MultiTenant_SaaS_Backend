import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  RegisterPatientSchema,
  RegisterClinicSchema,
  VerifyOTPSchema,
  ResendOTPSchema,
  LoginSchema,
} from "../schemas/auth.schemas";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { generateOtp, hashOtp, otpExpiryDate } from "../services/otp.service";
import { sendOtpEmail } from "../services/email.service";
import {
  signToken,
  AUTH_COOKIE_NAME,
  getAuthCookieOptions,
} from "../services/token.service";

export const registerPatient = asyncHandler(
  async (req: Request, res: Response) => {
    const { name, email, password } = RegisterPatientSchema.parse(req.body);

    const existingUser = await pool.query(
      'SELECT id FROM "User" WHERE email = $1',
      [email],
    );
    if (existingUser.rows.length > 0) {
      throw new AppError("A user with this email already exists.", 409);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otp = generateOtp();

    const result = await pool.query(
      `INSERT INTO "User" (name, email, "passwordHash", role, "isVerified", "otpCode", "otpExpiresAt", "otpAttempts", "otpLastSentAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        name,
        email,
        passwordHash,
        "PATIENT",
        false,
        hashOtp(otp),
        otpExpiryDate(),
        0,
        new Date(),
      ],
    );

    await sendOtpEmail(email, otp, "Verify Your Account - OTP Code");

    return res.status(201).json({
      message: "Patient account created. Please verify OTP sent to email.",
      userId: result.rows[0].id,
    });
  },
);

export const registerClinic = asyncHandler(
  async (req: Request, res: Response) => {
    const data = RegisterClinicSchema.parse(req.body);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const tenantRes = await client.query(
        `INSERT INTO "Tenant" (name, email, city, address, "contactInfo", "subscriptionStatus")
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          data.clinicName,
          data.email,
          data.city,
          data.address,
          data.contactInfo,
          "INACTIVE",
        ],
      );
      const tenantId = tenantRes.rows[0].id;

      const passwordHash = await bcrypt.hash(data.password, 10);
      const otp = generateOtp();
      console.log('🔑 DEV OTP:', otp);

      await client.query(
        `INSERT INTO "User" (name, email, "passwordHash", role, "tenantId", "isVerified", "otpCode", "otpExpiresAt", "otpAttempts", "otpLastSentAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          data.adminName,
          data.email,
          passwordHash,
          "CLINIC_ADMIN",
          tenantId,
          false,
          hashOtp(otp),
          otpExpiryDate(),
          0,
          new Date(),
        ],
      );

      await client.query("COMMIT");

      await sendOtpEmail(
        data.email,
        otp,
        "Verify Your Clinic Account - OTP Code",
      );

      return res
        .status(201)
        .json({ message: "Clinic created. Verify OTP to proceed.", tenantId });
    } catch (err: any) {
      await client.query("ROLLBACK");
      if (err.code === "23505") {
        throw new AppError("A user with this email already exists.", 409);
      }
      throw err;
    } finally {
      client.release();
    }
  },
);

export const verifyOTP = asyncHandler(async (req: Request, res: Response) => {
  const { email, otp } = VerifyOTPSchema.parse(req.body);

  const userRes = await pool.query('SELECT * FROM "User" WHERE email = $1', [
    email,
  ]);
  const user = userRes.rows[0];

  if (!user) throw new AppError("User not found.", 404);
  if (user.isVerified)
    throw new AppError("This account is already verified.", 409);

  if (!user.otpCode || !user.otpExpiresAt) {
    throw new AppError(
      "No pending verification code. Please request a new one.",
      410,
    );
  }
  if (new Date(user.otpExpiresAt).getTime() < Date.now()) {
    throw new AppError(
      "Verification code has expired. Please request a new one.",
      410,
    );
  }
  if (user.otpAttempts >= env.OTP_MAX_ATTEMPTS) {
    throw new AppError(
      "Too many incorrect attempts. Please request a new code.",
      429,
    );
  }

  if (hashOtp(otp) !== user.otpCode) {
    await pool.query(
      'UPDATE "User" SET "otpAttempts" = "otpAttempts" + 1 WHERE id = $1',
      [user.id],
    );
    throw new AppError("Invalid OTP.", 401);
  }

  await pool.query(
    `UPDATE "User" SET "isVerified" = TRUE, "otpCode" = NULL, "otpExpiresAt" = NULL, "otpAttempts" = 0
     WHERE id = $1`,
    [user.id],
  );

  const token = signToken({
    userId: user.id,
    role: user.role,
    tenantId: user.tenantId || null,
  });
  res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

  return res.status(200).json({
    message: "Account verified successfully.",
    role: user.role,
    tenantId: user.tenantId,
  });
});

export const resendOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email } = ResendOTPSchema.parse(req.body);

  const userRes = await pool.query(
    'SELECT id, "isVerified", "otpLastSentAt" FROM "User" WHERE email = $1',
    [email],
  );
  const user = userRes.rows[0];

  if (!user) throw new AppError("User not found.", 404);
  if (user.isVerified)
    throw new AppError("This account is already verified.", 409);

  if (user.otpLastSentAt) {
    const elapsedSeconds =
      (Date.now() - new Date(user.otpLastSentAt).getTime()) / 1000;
    if (elapsedSeconds < env.OTP_RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(env.OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds);
      throw new AppError(
        `Please wait ${wait}s before requesting another code.`,
        429,
      );
    }
  }

  const otp = generateOtp();
  await pool.query(
    `UPDATE "User" SET "otpCode" = $1, "otpExpiresAt" = $2, "otpAttempts" = 0, "otpLastSentAt" = $3
     WHERE id = $4`,
    [hashOtp(otp), otpExpiryDate(), new Date(), user.id],
  );

  await sendOtpEmail(email, otp, "Your new verification code");

  return res
    .status(200)
    .json({ message: "A new verification code has been sent." });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = LoginSchema.parse(req.body);

  const userRes = await pool.query('SELECT * FROM "User" WHERE email = $1', [
    email,
  ]);
  const user = userRes.rows[0];

  // Same generic message for "no such user" and "wrong password" —
  // distinguishing them lets an attacker enumerate which emails are registered.
  if (!user) throw new AppError("Invalid email or password.", 401);

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) throw new AppError("Invalid email or password.", 401);

  if (!user.isVerified) {
    throw new AppError("Please verify your email before logging in.", 403);
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
    tenantId: user.tenantId || null,
  });
  res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

  return res.status(200).json({
    message: "Login successful.",
    role: user.role,
    tenantId: user.tenantId,
  });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    ...getAuthCookieOptions(),
    maxAge: undefined,
  });
  return res.status(200).json({ message: "Logged out." });
});
