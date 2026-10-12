import { z } from "zod";

export const CreateReviewSchema = z.object({
  bookingId: z.string().uuid("Invalid booking id"),
  target: z.enum(["CLINIC", "DOCTOR"], {
    error: "target must be CLINIC or DOCTOR",
  }),
  rating: z.coerce
    .number()
    .int()
    .min(1, "Rating must be between 1 and 5")
    .max(5, "Rating must be between 1 and 5"),
  text: z
    .string()
    .max(1000, "Review text must be 1000 characters or fewer")
    .optional(),
});

export const UpdateReviewSchema = z
  .object({
    rating: z.coerce
      .number()
      .int()
      .min(1, "Rating must be between 1 and 5")
      .max(5, "Rating must be between 1 and 5")
      .optional(),
    text: z
      .string()
      .max(1000, "Review text must be 1000 characters or fewer")
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update.",
  });

export const RespondToReviewSchema = z.object({
  response: z
    .string()
    .min(1, "Response cannot be empty")
    .max(1000, "Response must be 1000 characters or fewer"),
});

export const ReviewIdParamSchema = z.object({
  id: z.string().uuid("Invalid review id"),
});

export const ListReviewsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
});
