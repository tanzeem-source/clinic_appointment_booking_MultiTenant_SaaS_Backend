import { z } from "zod";

export const InvoiceIdParamSchema = z.object({
  id: z.string().uuid("Invalid receipt id"),
});
