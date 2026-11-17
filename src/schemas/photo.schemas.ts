import { z } from "zod";

export const PhotoIdParamSchema = z.object({
  id: z.string().uuid("Invalid photo id"),
});
