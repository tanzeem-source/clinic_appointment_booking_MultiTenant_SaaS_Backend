import { cloudinary } from "../config/cloudinary";

// Reads the file's first bytes to work out what it really is. The file name
// and the content type a browser reports can both be faked, so neither is
// trusted. Returns null for anything that isn't a JPEG, PNG or WebP.
export const detectImageType = (buf: Buffer): "jpg" | "png" | "webp" | null => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "jpg";

  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(pngSignature)) return "png";

  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  return null;
};

// Uploads one image into a folder for this clinic. Large images are scaled
// down on upload (the stored copy fits within 1600 x 1600), which saves
// storage.
export const uploadClinicPhoto = (
  buffer: Buffer,
  tenantId: string,
): Promise<{ url: string; publicId: string }> =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `clinic-booking/clinics/${tenantId}`,
        resource_type: "image",
        allowed_formats: ["jpg", "png", "webp"],
        transformation: [
          { width: 1600, height: 1600, crop: "limit", quality: "auto" },
        ],
      },
      (error, result) => {
        if (error || !result)
          return reject(error ?? new Error("Upload failed"));
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });

// True if the image is gone from storage afterwards (removed now, or it was
// already missing). Throws if storage couldn't be reached.
export const deleteClinicPhotoAsset = async (
  publicId: string,
): Promise<boolean> => {
  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    invalidate: true,
  });
  return result.result === "ok" || result.result === "not found";
};
