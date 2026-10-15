import { PoolClient } from "pg";

// Add new types here as features arrive (review requests, reassignment
// alerts, subscription reminders). "type" is plain text in the database, so
// adding one never needs a migration.
export type NotificationType = "BOOKING_CONFIRMED";

export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Takes a client so the caller can run it inside its own transaction.
export const createNotification = async (
  client: PoolClient,
  n: NewNotification,
): Promise<void> => {
  await client.query(
    `INSERT INTO "Notification" ("userId", type, title, body, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [n.userId, n.type, n.title, n.body, JSON.stringify(n.data ?? {})],
  );
};

// A plain Google Maps search link: no API key needed. It searches for the
// clinic by name and address, so it can be imprecise for a vague address.
export const buildMapsUrl = (
  clinicName: string,
  address: string,
  city: string,
): string => {
  const query = [clinicName, address, city].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
};

// date arrives as "YYYY-MM-DD" (see the DATE type parser in config/db.ts).
const formatDate = (dateStr: string): string => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const formatTime = (t: string): string => String(t).slice(0, 5);

// Builds and stores the patient's booking confirmation. Call it inside the
// transaction that confirms the booking.
export const createBookingConfirmedNotification = async (
  client: PoolClient,
  bookingId: string,
): Promise<void> => {
  const res = await client.query(
    `SELECT b.id, b."patientId", b.date, b."startTime", b."endTime",
            d.name AS "doctorName", t.name AS "clinicName", t.address, t.city
     FROM "Booking" b
     JOIN "Doctor" d ON d.id = b."doctorId"
     JOIN "Tenant" t ON t.id = b."tenantId"
     WHERE b.id = $1`,
    [bookingId],
  );
  const b = res.rows[0];
  if (!b) return;

  const mapsUrl = buildMapsUrl(b.clinicName, b.address, b.city);
  const dateText = formatDate(b.date);
  const startTime = formatTime(b.startTime);
  const endTime = formatTime(b.endTime);

  await createNotification(client, {
    userId: b.patientId,
    type: "BOOKING_CONFIRMED",
    title: "Booking confirmed",
    body:
      `Your appointment with ${b.doctorName} at ${b.clinicName} is confirmed for ${dateText}, ` +
      `${startTime} to ${endTime}. Address: ${b.address}, ${b.city}. Directions: ${mapsUrl}`,
    data: {
      bookingId: b.id,
      doctorName: b.doctorName,
      clinicName: b.clinicName,
      address: b.address,
      city: b.city,
      date: b.date,
      startTime,
      endTime,
      mapsUrl,
    },
  });
};
