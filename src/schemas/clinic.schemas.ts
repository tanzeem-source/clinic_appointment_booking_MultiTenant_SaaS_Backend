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
  clinicId: z.string().uuid("Invalid clinic id"),
});

const dateString = (label: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be in YYYY-MM-DD format`);

export const ListClinicBookingsQuerySchema = z
  .object({
    doctorId: z.string().uuid("Invalid doctor id").optional(),
    from: dateString("from").optional(),
    to: dateString("to").optional(),
    // PENDING = no outcome recorded yet.
    visitStatus: z
      .enum(["PENDING", "COMPLETED", "NO_SHOW"], {
        error: "visitStatus must be PENDING, COMPLETED or NO_SHOW",
      })
      .optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must not be after to",
    path: ["to"],
  });
