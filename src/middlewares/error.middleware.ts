import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Wraps async controllers so thrown/rejected errors reach errorHandler
// instead of becoming unhandled rejections.
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
};

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof ZodError) {
    const { fieldErrors, formErrors } = err.flatten();
    // Form-level errors (e.g. from .refine()) have no field to attach to,
    // so surface the first one as the main message; otherwise the client
    // sees "Validation failed" with nothing to act on.
    return res.status(422).json({
      error: formErrors[0] || 'Validation failed',
      details: fieldErrors
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Malformed JSON body (thrown by express.json() before any controller runs)
  if ((err as any)?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body.' });
  }

  // Request body larger than express.json()'s limit
  if ((err as any)?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }

  // Postgres unique-violation, in case one ever slips through uncaught
  if ((err as any)?.code === '23505') {
    return res.status(409).json({ error: 'A record with this value already exists.' });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
};