import { PoolClient } from "pg";

// Both recompute functions run INSIDE the caller's transaction (same
// client), so a review write and the rating it affects commit or roll
// back together — never a review that exists with a stale average.

export const recomputeTenantRating = async (
  client: PoolClient,
  tenantId: string,
) => {
  const res = await client.query(
    `SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS avg, COUNT(*)::int AS count
     FROM "Review" WHERE target = 'CLINIC' AND "tenantId" = $1`,
    [tenantId],
  );
  const { avg, count } = res.rows[0];
  await client.query(
    `UPDATE "Tenant" SET "averageRating" = $1, "reviewCount" = $2 WHERE id = $3`,
    [avg, count, tenantId],
  );
};

export const recomputeDoctorRating = async (
  client: PoolClient,
  doctorId: string,
) => {
  const res = await client.query(
    `SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS avg, COUNT(*)::int AS count
     FROM "Review" WHERE target = 'DOCTOR' AND "doctorId" = $1`,
    [doctorId],
  );
  const { avg, count } = res.rows[0];
  await client.query(
    `UPDATE "Doctor" SET "averageRating" = $1, "reviewCount" = $2 WHERE id = $3`,
    [avg, count, doctorId],
  );
};
