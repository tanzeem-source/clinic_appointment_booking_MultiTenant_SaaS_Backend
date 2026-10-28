import { z } from "zod";
import { phoneSchema } from "./auth.schemas";

const emailSchema = z
  .string()
  .email("Invalid email address")
  .toLowerCase()
  .trim();

export const CreateStaffSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: emailSchema,
  phone: phoneSchema.optional(),
});

export const UpdateStaffSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").optional(),
    phone: phoneSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update.",
  });

export const StaffIdParamSchema = z.object({
  id: z.string().uuid("Invalid staff id"),
});
