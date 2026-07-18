import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const hasCloudinary = () =>
  Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

/**
 * Upload an image buffer; resolves to the delivery URL that goes into the
 * template's media columns (D8). public_id = normalized SKU (golden-example
 * convention: filename = SKU).
 */
export function uploadBufferToCloudinary(buffer, publicId) {
  const folder = process.env.CLOUDINARY_FOLDER?.replace(/\/previews$/, "/products") || "bk/products";
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ resource_type: "image", folder, public_id: publicId, overwrite: true }, (err, result) =>
        err ? reject(err) : resolve(result.secure_url)
      )
      .end(buffer);
  });
}

export default cloudinary;
