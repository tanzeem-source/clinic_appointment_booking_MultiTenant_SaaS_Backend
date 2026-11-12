import { Request, Response } from "express";
import { pool } from "../config/db";
import { asyncHandler } from "../middlewares/error.middleware";
import { SPECIALIZATIONS } from "../constants/specializations";
import {
  DoctorSearchSchema,
  SpecializationsQuerySchema,
} from "../schemas/search.schemas";
import { ACTIVE_CLINIC_SQL, containsPattern } from "../services/search.service";

// The ORDER BY text comes only from this fixed map, never from the request,
// and every option ends in d.id so paging is stable when values tie.
const DOCTOR_SORTS = {
  rating: `d."averageRating" DESC, d."reviewCount" DESC, d.name ASC, d.id ASC`,
  reviews: `d."reviewCount" DESC, d."averageRating" DESC, d.name ASC, d.id ASC`,
  fee_low: `d."appointmentFeePaise" ASC, d."averageRating" DESC, d.name ASC, d.id ASC`,
  fee_high: `d."appointmentFeePaise" DESC, d."averageRating" DESC, d.name ASC, d.id ASC`,
  name: `d.name ASC, d.id ASC`,
} as const;

// Public. Only active doctors at clinics with an active, unexpired
// subscription appear, and the clinic's login email is never returned.
export const searchDoctors = asyncHandler(
  async (req: Request, res: Response) => {
    const { city, specialization, q, maxFeeInr, minRating, sort, page, limit } =
      DoctorSearchSchema.parse(req.query);
    const offset = (page - 1) * limit;

    // Every value from the request goes in as a bound parameter; the SQL text
    // below is assembled only from fixed fragments.
    const params: unknown[] = [containsPattern(city)];
    let where = `d."isActive" = TRUE AND ${ACTIVE_CLINIC_SQL} AND t.city ILIKE $1`;

    if (specialization) {
      params.push(specialization);
      where += ` AND d.specialization = $${params.length}`;
    }
    if (q) {
      params.push(containsPattern(q));
      const n = params.length;
      where += ` AND (d.name ILIKE $${n} OR t.name ILIKE $${n} OR d.specialization ILIKE $${n})`;
    }
    if (maxFeeInr !== undefined) {
      params.push(Math.round(maxFeeInr * 100));
      where += ` AND d."appointmentFeePaise" <= $${params.length}`;
    }
    if (minRating !== undefined) {
      params.push(minRating);
      where += ` AND d."averageRating" >= $${params.length}`;
    }

    const filterParams = [...params];
    params.push(limit, offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT d.id, d.name, d.specialization, d."slotDurationMinutes", d."appointmentFeePaise",
              d."averageRating"::float AS "averageRating", d."reviewCount",
              t.id AS "clinicId", t.name AS "clinicName", t.city, t.address,
              t."averageRating"::float AS "clinicAverageRating", t."reviewCount" AS "clinicReviewCount"
       FROM "Doctor" d
       JOIN "Tenant" t ON t.id = d."tenantId"
       WHERE ${where}
       ORDER BY ${DOCTOR_SORTS[sort]}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
       FROM "Doctor" d
       JOIN "Tenant" t ON t.id = d."tenantId"
       WHERE ${where}`,
        filterParams,
      ),
    ]);

    const total = countRes.rows[0].total;

    return res.status(200).json({
      doctors: rowsRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        specialization: r.specialization,
        slotDurationMinutes: r.slotDurationMinutes,
        appointmentFeePaise: r.appointmentFeePaise,
        averageRating: r.averageRating,
        reviewCount: r.reviewCount,
        clinic: {
          id: r.clinicId,
          name: r.clinicName,
          city: r.city,
          address: r.address,
          averageRating: r.clinicAverageRating,
          reviewCount: r.clinicReviewCount,
        },
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);

// All of the supported specializations, each with the number of active
// doctors who have it (in one city if ?city= is given). Always returns the
// full list, so a clinic's form can use it as a dropdown, and a search page
// can hide the entries whose count is 0.
export const listSpecializations = asyncHandler(
  async (req: Request, res: Response) => {
    const { city } = SpecializationsQuerySchema.parse(req.query);

    const params: unknown[] = [];
    let where = `d."isActive" = TRUE AND d.specialization IS NOT NULL AND ${ACTIVE_CLINIC_SQL}`;
    if (city) {
      params.push(containsPattern(city));
      where += ` AND t.city ILIKE $1`;
    }

    const result = await pool.query(
      `SELECT d.specialization AS name, COUNT(*)::int AS "doctorCount"
     FROM "Doctor" d
     JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE ${where}
     GROUP BY d.specialization`,
      params,
    );

    const counts = new Map<string, number>(
      result.rows.map((r) => [r.name, r.doctorCount]),
    );

    return res.status(200).json({
      specializations: SPECIALIZATIONS.map((name) => ({
        name,
        doctorCount: counts.get(name) ?? 0,
      })),
    });
  },
);
