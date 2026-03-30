import { google } from 'googleapis';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { basename, extname } from 'path';

const MIME_MAP = {
  '.mp4': 'video/mp4',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

/**
 * Find or create a subfolder inside a parent folder.
 */
async function findOrCreateFolder(drive, parentId, name) {
  const q = `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)' });
  if (res.data.files.length) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return folder.data.id;
}

/**
 * Check if file already exists in folder (by name).
 */
async function fileExists(drive, folderId, filename) {
  const q = `'${folderId}' in parents and name='${filename}' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id,size)' });
  return res.data.files[0] || null;
}

/**
 * Upload a file to Google Drive with resumable upload.
 *
 * @param {string} localPath - Path to file on disk
 * @param {string} folderId - Drive folder ID
 * @param {object} [options] - { skipIfExists: true }
 * @returns {Promise<{id: string, name: string, action: string}>}
 */
export async function uploadToDrive(localPath, folderId, options = {}) {
  const drive = getDriveClient();
  const filename = basename(localPath);
  const ext = extname(localPath).toLowerCase();
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';
  const { size } = await stat(localPath);
  const sizeMB = (size / (1024 * 1024)).toFixed(1);

  // Check existing
  if (options.skipIfExists !== false) {
    const existing = await fileExists(drive, folderId, filename);
    if (existing) {
      const existingMB = existing.size ? (parseInt(existing.size) / (1024 * 1024)).toFixed(1) : '?';
      if (Math.abs(parseFloat(existingMB) - parseFloat(sizeMB)) < 0.5) {
        console.log(`[Drive] SKIP (exists): ${filename} (${sizeMB}MB)`);
        return { id: existing.id, name: filename, action: 'skipped' };
      }
      // Different size — delete and re-upload
      await drive.files.delete({ fileId: existing.id });
    }
  }

  console.log(`[Drive] Uploading ${filename} (${sizeMB}MB)...`);

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: createReadStream(localPath) },
    fields: 'id,name',
  });

  console.log(`[Drive] Done: ${filename}`);
  return { id: res.data.id, name: res.data.name, action: 'uploaded' };
}

/**
 * Upload analysis markdown to the correct subfolder.
 */
export async function uploadAnalysisToDrive(analysisText, filename, courseFolderId) {
  const drive = getDriveClient();
  const analysisFolderId = await findOrCreateFolder(drive, courseFolderId, 'analysis');

  // Write to temp, upload, clean up
  const tmpPath = `/tmp/${filename}`;
  const { writeFileSync, unlinkSync } = await import('fs');
  writeFileSync(tmpPath, analysisText);

  const result = await uploadToDrive(tmpPath, analysisFolderId);
  try { unlinkSync(tmpPath); } catch {}
  return result;
}

/**
 * Upload a video to the correct subfolder.
 */
export async function uploadVideoToDrive(videoPath, courseFolderId) {
  const drive = getDriveClient();
  const videoFolderId = await findOrCreateFolder(drive, courseFolderId, 'videos');
  return uploadToDrive(videoPath, videoFolderId);
}
