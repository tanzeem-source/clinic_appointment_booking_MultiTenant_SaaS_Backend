import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from 'config/db';
import { resend } from 'config/resend';
import { RegisterPatientSchema, RegisterClinicSchema, VerifyOTPSchema } from 'schemas/auth.schemas';

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

export const registerPatient = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = RegisterPatientSchema.parse(req.body);

    const existingUser = await pool.query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'A user with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otp = generateOTP();

    const result = await pool.query(
      `INSERT INTO "User" (name, email, "passwordHash", role, "isVerified", "otpCode")
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, email, passwordHash, 'PATIENT', false, otp]
    );

    await resend.emails.send({
      from: 'Auth <onboarding@resend.dev>',
      to: email,
      subject: 'Verify Your Account - OTP Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p>`
    });

    return res.status(201).json({
      message: 'Patient account created. Please verify OTP sent to email.',
      userId: result.rows[0].id
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || err.errors });
  }
};

export const registerClinic = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const data = RegisterClinicSchema.parse(req.body);

    await client.query('BEGIN'); // Start transaction

    // 1. Create Tenant
    const tenantRes = await client.query(
      `INSERT INTO "Tenant" (name, email, city, address, "contactInfo", "subscriptionStatus")
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [data.clinicName, data.email, data.city, data.address, data.contactInfo, 'INACTIVE']
    );
    const tenantId = tenantRes.rows[0].id;

    // 2. Create Admin User
    const passwordHash = await bcrypt.hash(data.password, 10);
    const otp = generateOTP();

    await client.query(
      `INSERT INTO "User" (name, email, "passwordHash", role, "tenantId", "isVerified", "otpCode")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [data.adminName, data.email, passwordHash, 'CLINIC_ADMIN', tenantId, false, otp]
    );

    await client.query('COMMIT'); // Commit transaction

    await resend.emails.send({
      from: 'Auth <onboarding@resend.dev>',
      to: data.email,
      subject: 'Verify Your Clinic Account - OTP Code',
      html: `<p>Your clinic verification code is: <strong>${otp}</strong></p>`
    });

    return res.status(201).json({
      message: 'Clinic created. Verify OTP to proceed.',
      tenantId
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: err.message || err.errors });
  } finally {
    client.release();
  }
};

export const verifyOTP = async (req: Request, res: Response) => {
  try {
    const { email, otp } = VerifyOTPSchema.parse(req.body);

    const userRes = await pool.query('SELECT * FROM "User" WHERE email = $1', [email]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.otpCode !== otp) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    await pool.query(
      'UPDATE "User" SET "isVerified" = TRUE, "otpCode" = NULL WHERE id = $1',
      [user.id]
    );

    const token = jwt.sign(
      { userId: user.id, role: user.role, tenantId: user.tenantId || null },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      message: 'Account verified successfully.',
      token,
      role: user.role,
      tenantId: user.tenantId
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || err.errors });
  }
};