import { Response } from "express";
import { pool } from "../config/db";
import { isPhotoStorageConfigured } from "../config/cloudinary";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { PhotoIdParamSchema } from "../schemas/photo.schemas";
import {
  detectImageType,
  uploadClinicPhoto,
  deleteClinicPhotoAsset,
} from "../services/photo.service";

const MAX_PHOTOS = 8;

const requireStorage = () => {
  if (!isPhotoStorageConfigured) {
    throw new AppError("Photo uploads are not configured on this server.", 503);
  }
};

export const listMyPhotos = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const result = await pool.query(
      `SELECT id, url, position FROM "ClinicPhoto" WHERE "tenantId" = $1 ORDER BY position ASC, "createdAt" ASC`,
      [tenantId],
    );

    return res.status(200).json({ photos: result.rows });
  },
);

export const uploadPhoto = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    requireStorage();

    const file = req.file;
    if (!file)
      throw new AppError(
        'Send a photo in the "photo" field (multipart form data).',
        422,
      );

    if (!detectImageType(file.buffer)) {
      throw new AppError("Only JPEG, PNG or WebP images are allowed.", 422);
    }

    // Cheap early check, so a full clinic doesn't pay for an upload that will
    // be refused. The real limit is re-checked under a lock below.
    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS n FROM "ClinicPhoto" WHERE "tenantId" = $1',
      [tenantId],
    );
    if (countRes.rows[0].n >= MAX_PHOTOS) {
      throw new AppError(
        `A clinic can have at most ${MAX_PHOTOS} photos. Delete one first.`,
        409,
      );
    }

    let uploaded: { url: string; publicId: string };
    try {
      uploaded = await uploadClinicPhoto(file.buffer, tenantId);
    } catch (err) {
      console.error("Photo upload to storage failed:", err);
      throw new AppError(
        "Photo storage is unavailable right now. Please try again.",
        502,
      );
    }

    let photo: { id: string; url: string; position: number };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock this clinic's row so two uploads at the same moment can't both
      // pass the limit.
      await client.query('SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE', [
        tenantId,
      ]);

      const statsRes = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(MAX(position), -1) + 1 AS next FROM "ClinicPhoto" WHERE "tenantId" = $1`,
        [tenantId],
      );
      if (statsRes.rows[0].n >= MAX_PHOTOS) {
        throw new AppError(
          `A clinic can have at most ${MAX_PHOTOS} photos. Delete one first.`,
          409,
        );
      }

      const insertRes = await client.query(
        `INSERT INTO "ClinicPhoto" ("tenantId", url, "publicId", position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, position`,
        [tenantId, uploaded.url, uploaded.publicId, statsRes.rows[0].next],
      );
      photo = insertRes.rows[0];

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // The image is already stored but its record isn't, so remove it rather
      // than leave it orphaned.
      await deleteClinicPhotoAsset(uploaded.publicId).catch((cleanupErr) =>
        console.error("Failed to clean up an uploaded photo:", cleanupErr),
      );
      throw err;
    } finally {
      client.release();
    }

    return res.status(201).json({ photo });
  },
);

export const deletePhoto = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    requireStorage();

    const { id } = PhotoIdParamSchema.parse(req.params);

    // Scoped to the clinic in the login token: another clinic's photo looks like
    // it doesn't exist.
    const photoRes = await pool.query(
      'SELECT id, "publicId" FROM "ClinicPhoto" WHERE id = $1 AND "tenantId" = $2',
      [id, tenantId],
    );
    const photo = photoRes.rows[0];
    if (!photo) throw new AppError("Photo not found.", 404);

    // Storage first, then the record. If storage fails, the record stays and the
    // request can simply be retried; nothing is left pointing at a deleted file.
    let removed = false;
    try {
      removed = await deleteClinicPhotoAsset(photo.publicId);
    } catch (err) {
      console.error("Failed to delete a photo from storage:", err);
    }
    if (!removed) {
      throw new AppError(
        "Could not remove the photo from storage. Please try again.",
        502,
      );
    }

    await pool.query(
      'DELETE FROM "ClinicPhoto" WHERE id = $1 AND "tenantId" = $2',
      [id, tenantId],
    );

    return res.status(200).json({ message: "Photo deleted." });
  },
);
