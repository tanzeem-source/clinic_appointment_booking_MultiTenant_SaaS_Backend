import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon requires SSL; revisit stricter cert validation before prod
});

// Without this, an idle client erroring (e.g. Neon closing an idle
// connection) throws an uncaught exception and crashes the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PG client:', err);
});