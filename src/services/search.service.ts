// Escapes the characters that mean something inside a LIKE pattern, so someone
// typing "%" or "_" into a search box looks for those characters instead of
// matching everything.
export const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, "\\$&");

export const containsPattern = (value: string): string =>
  `%${escapeLike(value)}%`;

// A clinic whose subscription is active and unexpired. Expects the Tenant
// table to be aliased as "t".
export const ACTIVE_CLINIC_SQL = `t."subscriptionStatus" = 'ACTIVE' AND (t."subscriptionExpiresAt" IS NULL OR t."subscriptionExpiresAt" > NOW())`;
