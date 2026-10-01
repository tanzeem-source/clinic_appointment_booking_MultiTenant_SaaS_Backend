import { Pool, types } from "pg";
import { env } from "./env";

// Postgres DATE (OID 1082) has no time or timezone component, but pg's
// default parser converts it to a JS Date at local midnight — which then
// shifts to the previous day when serialized to JSON if the server's
// timezone is ahead of UTC (e.g. IST). Returning the raw "YYYY-MM-DD"
// string avoids the conversion entirely, since nothing in this app needs
// DATE values as JS Date objects.
types.setTypeParser(1082, (val: string) => val);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL; revisit stricter cert validation before prod
});

// Without this, an idle client erroring (e.g. Neon closing an idle
// connection) throws an uncaught exception and crashes the process.
pool.on("error", (err) => {
  console.error("Unexpected error on idle PG client:", err);
});
