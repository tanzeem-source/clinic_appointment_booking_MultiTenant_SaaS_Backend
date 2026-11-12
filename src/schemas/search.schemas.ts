import { z } from "zod";
import { SPECIALIZATIONS } from "../constants/specializations";

export const DoctorSearchSchema = z.object({
  city: z.string().trim().min(1, "City is required").max(100),
  specialization: z
    .enum(SPECIALIZATIONS, {
      error:
        "Unknown specialization. See GET /api/doctors/specializations for the list.",
    })
    .optional(),
  q: z.string().trim().max(100).optional(),
  // In rupees, to match what a patient thinks in; the stored fee is in paise.
  maxFeeInr: z.coerce.number().positive().max(1000000).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z
    .enum(["rating", "reviews", "fee_low", "fee_high", "name"])
    .default("rating"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const SpecializationsQuerySchema = z.object({
  city: z.string().trim().max(100).optional(),
});
