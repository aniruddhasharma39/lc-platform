import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import fs from 'fs';
import path from 'path';

// Configure Cloudinary using environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface CloudinaryUploadOptions {
  folder: string;
  publicIdPrefix?: string;
  tags?: string[];
  maxDimension?: number;
}

/**
 * Uploads an in-memory image Buffer directly to Cloudinary.
 * Applies automatic web-optimization (JPEG, quality auto, bounded max resolution)
 * to minimize bandwidth while retaining crisp facial details for audits.
 */
export async function uploadBufferToCloudinary(
  buffer: Buffer,
  options: CloudinaryUploadOptions
): Promise<{ secureUrl: string; publicId: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Cloudinary upload timed out after 12s'));
    }, 12000);

    const filename = options.publicIdPrefix
      ? `${options.publicIdPrefix}_${Date.now()}`
      : `att_${Date.now()}`;

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        public_id: filename,
        resource_type: 'image',
        transformation: [
          {
            width: options.maxDimension || 800,
            height: options.maxDimension || 800,
            crop: 'limit',
            quality: 'auto:good',
            fetch_format: 'jpg',
          },
        ],
        tags: options.tags || ['lc-platform', 'attendance'],
      },
      (error: any, result: UploadApiResponse | undefined) => {
        clearTimeout(timeout);
        if (error) {
          console.error('[Cloudinary] Upload error:', error);
          reject(error);
        } else if (result && result.secure_url) {
          resolve({
            secureUrl: result.secure_url,
            publicId: result.public_id,
          });
        } else {
          reject(new Error('Cloudinary returned no secure_url'));
        }
      }
    );

    stream.end(buffer);
  });
}

/**
 * Best-effort deletion of an asset from Cloudinary.
 * Accepts either a full HTTPS Cloudinary URL or a raw public_id.
 * Also cleans legacy local disk files if an old relative path is provided.
 */
export async function deleteFromCloudinary(imageUrlOrPublicId?: string | null): Promise<boolean> {
  if (!imageUrlOrPublicId) return false;

  // 1. Handle legacy local disk files (e.g. uploads/attendance/...)
  if (
    imageUrlOrPublicId.startsWith('uploads/') ||
    imageUrlOrPublicId.startsWith('/uploads/') ||
    imageUrlOrPublicId.includes('uploads/faces')
  ) {
    try {
      const cleanPath = imageUrlOrPublicId.replace(/^\//, '');
      const fullPath = path.join(process.cwd(), cleanPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`[Local Disk] Purged legacy local file: ${fullPath}`);
        return true;
      }
    } catch (fsErr) {
      console.warn(`[Local Disk] Failed to delete local file: ${imageUrlOrPublicId}`, fsErr);
    }
    return false;
  }

  // 2. Handle Cloudinary assets
  try {
    let publicId = imageUrlOrPublicId;

    if (imageUrlOrPublicId.startsWith('http')) {
      const marker = '/upload/';
      const idx = imageUrlOrPublicId.indexOf(marker);
      if (idx !== -1) {
        publicId = imageUrlOrPublicId.slice(idx + marker.length);
        // Strip optional version segment (e.g., v1712345678/)
        publicId = publicId.replace(/^v\d+\//, '');
        // Strip file extension (.jpg, .png, etc.)
        publicId = publicId.replace(/\.[^./]+$/, '');
      } else {
        return false;
      }
    }

    const res = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    console.log(`[Cloudinary] Purged asset: ${publicId} =>`, res.result);
    return res.result === 'ok' || res.result === 'not found';
  } catch (err: any) {
    console.warn(`[Cloudinary] Failed to purge asset ${imageUrlOrPublicId}:`, err.message || err);
    return false;
  }
}
