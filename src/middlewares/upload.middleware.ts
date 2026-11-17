import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { AppError } from "./error.middleware";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// The file is held in memory (never written to disk) and capped at 5 MB, one
// file per request, in a field called "photo".
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 5 },
}).single("photo");

// Wraps multer so its errors become the same clean JSON errors as everywhere
// else. Register it AFTER authentication, so a file is only read from someone
// who is logged in.
export const uploadSinglePhoto = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new AppError("Photo must be 5 MB or smaller.", 413));
      }
      return next(
        new AppError('Send exactly one image in the "photo" field.', 422),
      );
    }

    return next(err);
  });
};
