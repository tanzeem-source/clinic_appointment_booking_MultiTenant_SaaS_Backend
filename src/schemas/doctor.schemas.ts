import { z } from "zod";

export const CreateDoctorSchema = z.object({
  name: z.string().min(2, "Doctor name is required"),
  specialization: z.string().min(2).optional(),
  slotDurationMinutes: z.union([z.literal(15), z.literal(20), z.literal(30)], {
    error: "Slot duration must be 15, 20, or 30 minutes",
  }),
  appointmentFeePaise: z.coerce
    .number()
    .int()
    .positive("Appointment fee must be a positive amount in paise"),
});

export const UpdateDoctorSchema = z
  .object({
    name: z.string().min(2).optional(),
    specialization: z.string().min(2).optional(),
    slotDurationMinutes: z
      .union([z.literal(15), z.literal(20), z.literal(30)], {
        error: "Slot duration must be 15, 20, or 30 minutes",
      })
      .optional(),
    appointmentFeePaise: z.coerce.number().int().positive().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update.",
  });

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM (24-hour) format");

const WeeklyRangeSchema = z
  .object({
    dayOfWeek: z
      .number()
      .int()
      .min(0, "dayOfWeek must be 0-6 (0 = Sunday)")
      .max(6),
    startTime: timeSchema,
    endTime: timeSchema,
  })
  .refine((data) => data.startTime < data.endTime, {
    message: "startTime must be before endTime",
    path: ["endTime"],
  });

export const SetWeeklyAvailabilitySchema = z.object({
  ranges: z.array(WeeklyRangeSchema).max(20, "Too many ranges"),
});

export const CreateOverrideSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  reason: z.string().max(200).optional(),
});

export const DoctorIdParamSchema = z.object({
  id: z.string().uuid("Invalid doctor id"),
});

export const OverrideIdParamSchema = z.object({
  id: z.string().uuid("Invalid doctor id"),
  overrideId: z.string().uuid("Invalid override id"),
});
