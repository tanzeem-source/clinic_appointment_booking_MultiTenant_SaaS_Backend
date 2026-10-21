import { z } from "zod";
import { phoneSchema } from "./auth.schemas";

export const UpdatePatientProfileSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").optional(),
    phone: phoneSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update.",
  });
