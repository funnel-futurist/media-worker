import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload an MP3 file to Cloudinary.
 * Cloudinary requires resource_type 'video' for audio files.
 */
export async function uploadAudio(filePath, folder = 'audit-voiceovers') {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'video',
    folder,
    format: 'mp3',
  });
  return { url: result.secure_url, publicId: result.public_id };
}

/**
 * Upload an MP4 video to Cloudinary using chunked upload.
 * Required for large files — synchronous upload fails with "too large" error.
 *
 * Uses callback form deliberately: the Promise-based upload_large doesn't attach
 * an error listener to its internal ReadStream, so a missing-file ENOENT emits
 * an unhandled 'error' event and crashes Node.js. The callback form forwards all
 * errors (including stream errors) to the callback → Promise rejection → caught
 * by the caller's try/catch.
 */
export function uploadVideo(filePath, folder = 'remotion-renders') {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(
      filePath,
      { resource_type: 'video', folder, format: 'mp4', chunk_size: 6 * 1024 * 1024 },
      (error, result) => {
        if (error) reject(error);
        else resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
  });
}

/**
 * Upload a PNG/JPG image to Cloudinary.
 */
export async function uploadImage(filePath, folder = 'audit-screenshots') {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'image',
    folder,
  });
  return { url: result.secure_url, publicId: result.public_id };
}
