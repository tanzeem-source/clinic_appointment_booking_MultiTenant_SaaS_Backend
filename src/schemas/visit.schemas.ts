import { z } from "zod";

export const MarkVisitSchema = z.object({
  outcome: z.enum(["COMPLETED", "NO_SHOW"], {
    error: "outcome must be COMPLETED or NO_SHOW",
  }),
});

export const BookingIdParamSchema = z.object({
  id: z.string().uuid("Invalid booking id"),
});
