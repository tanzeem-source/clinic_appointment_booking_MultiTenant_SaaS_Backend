import { z } from "zod";

// subscriptionStatus is deliberately NOT included here — it's a billing
// state that must only ever change via the payment flow (e.g. a payment
// provider webhook), never through clinic-admin self-service. Do not add
// it to this schema even if it seems convenient later.
export const UpdateClinicSchema = z
  .object({
    clinicName: z.string().min(2, "Clinic name is required").optional(),
    city: z.string().min(2, "City is required").optional(),
    address: z.string().min(5, "Address is required").optional(),
    contactInfo: z
      .string()
      .regex(/^[0-9+\-\s()]{7,20}$/, "Enter a valid phone number")
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update.",
  });

export const SearchClinicsSchema = z.object({
  city: z.string().min(1, "City is required"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const ClinicIdParamSchema = z.object({
  id: z.string().uuid("Invalid clinic id"),
});

export const ClinicIdRouteParamSchema = z.object({
  clinicId: z.string().uuid('Invalid clinic id')
});
