import { pool } from "../config/db";

export type ReminderStage = "EXPIRING_7D" | "EXPIRING_1D" | "EXPIRED";

const DAY_MS = 24 * 60 * 60 * 1000;

// Which reminder, if any, applies right now to a subscription that ends at
// expiresAt. Only the CURRENT stage is returned, so an admin who first opens
// the app after expiry sees the expiry notice and not the earlier reminders.
export const getReminderStage = (
  expiresAt: Date,
  now: Date = new Date(),
): ReminderStage | null => {
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return "EXPIRED";
  if (msLeft <= DAY_MS) return "EXPIRING_1D";
  if (msLeft <= 7 * DAY_MS) return "EXPIRING_7D";
  return null;
};

const formatDate = (d: Date): string =>
  d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const buildMessage = (
  stage: ReminderStage,
  expiresAt: Date,
): { title: string; body: string } => {
  const dateText = formatDate(expiresAt);

  if (stage === "EXPIRED") {
    return {
      title: "Your subscription has expired",
      body:
        `Your clinic's subscription expired on ${dateText}. Your clinic is now hidden from search and patients ` +
        `can't book new appointments. Appointments that are already paid for stay valid: you can still view them, ` +
        `record visits, and move or cancel with a refund if a doctor is unavailable. Renew to be listed again.`,
    };
  }

  return {
    title:
      stage === "EXPIRING_1D"
        ? "Your subscription expires within 24 hours"
        : "Your subscription expires soon",
    body:
      `Your clinic's subscription expires on ${dateText}. After that your clinic and doctors are hidden from search, ` +
      `patients can't book new appointments, and you can't edit doctors or schedules. Appointments patients have ` +
      `already paid for stay valid. Renew any time to keep everything running.`,
  };
};

// Creates the reminder that applies right now, if it hasn't been sent yet for
// this expiry date. Safe to call as often as you like: the unique dedupeKey
// means a stage is only ever stored once per expiry date, and renewing moves
// the expiry date, so the next cycle gets fresh reminders.
//
// Only subscriptions that are currently ACTIVE with an expiry date get
// reminders, so a clinic that never subscribed isn't nagged.
export const ensureSubscriptionReminders = async (
  tenantId: string,
  userId: string,
): Promise<void> => {
  const res = await pool.query(
    `SELECT "subscriptionStatus", "subscriptionExpiresAt" FROM "Tenant" WHERE id = $1`,
    [tenantId],
  );
  const tenant = res.rows[0];
  if (
    !tenant ||
    tenant.subscriptionStatus !== "ACTIVE" ||
    !tenant.subscriptionExpiresAt
  )
    return;

  const expiresAt = new Date(tenant.subscriptionExpiresAt);
  const stage = getReminderStage(expiresAt);
  if (!stage) return;

  const { title, body } = buildMessage(stage, expiresAt);
  const type =
    stage === "EXPIRED" ? "SUBSCRIPTION_EXPIRED" : "SUBSCRIPTION_EXPIRING";
  const dedupeKey = `SUBSCRIPTION_${stage}_${expiresAt.toISOString()}`;

  await pool.query(
    `INSERT INTO "Notification" ("userId", type, title, body, data, "dedupeKey")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("userId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL DO NOTHING`,
    [
      userId,
      type,
      title,
      body,
      JSON.stringify({ stage, expiresAt: expiresAt.toISOString() }),
      dedupeKey,
    ],
  );
};
