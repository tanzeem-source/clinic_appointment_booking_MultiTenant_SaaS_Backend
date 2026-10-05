import { z } from "zod";

export const ReserveBookingSchema = z.object({
  doctorId: z.string().uuid("Invalid doctor id"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM format"),
});

export const VerifyBookingSchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});
