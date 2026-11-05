import { z } from "zod";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const RescheduleBookingSchema = z.object({
  // Optional: leave it out to keep the same doctor.
  doctorId: z.string().uuid("Invalid doctor id").optional(),
  date: dateString,
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM format"),
});

export const RescheduleOptionsQuerySchema = z.object({
  date: dateString,
  doctorId: z.string().uuid("Invalid doctor id").optional(),
});
