import { z } from "zod";

const emailSchema = z
  .string()
  .email("Invalid email address")
  .toLowerCase()
  .trim();

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

// Shared with the patient profile schema.
export const phoneSchema = z
  .string()
  .regex(/^[0-9+\-\s()]{7,20}$/, "Enter a valid phone number");

export const RegisterPatientSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema.optional(),
});

export const RegisterClinicSchema = z.object({
  clinicName: z.string().min(2, "Clinic name is required"),
  city: z.string().min(2, "City is required"),
  address: z.string().min(5, "Address is required"),
  contactInfo: phoneSchema,
  adminName: z.string().min(2, "Admin name is required"),
  email: emailSchema,
  password: passwordSchema,
});

export const VerifyOTPSchema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

export const ResendOTPSchema = z.object({
  email: emailSchema,
});

export const LoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const ForgotPasswordSchema = z.object({
  email: emailSchema,
});

export const ResetPasswordSchema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/, "Reset code must be 6 digits"),
  newPassword: passwordSchema,
});
