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
 * Upload an MP4 video to Cloudinary.
 * Preserves video stream (unlike uploadAudio which forces mp3).
 */
export async function uploadVideo(filePath, folder = 'remotion-renders') {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'video',
    folder,
    format: 'mp4',
  });
  return { url: result.secure_url, publicId: result.public_id };
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
