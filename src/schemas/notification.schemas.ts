import { z } from "zod";

export const ListNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  unreadOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const NotificationIdParamSchema = z.object({
  id: z.string().uuid("Invalid notification id"),
});
