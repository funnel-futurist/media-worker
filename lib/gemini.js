import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';
import { basename } from 'path';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });

/**
 * Upload a video file to Gemini and analyze it with a given prompt.
 * Uses Gemini 2.0 Flash — fast, cheap, good at video understanding.
 *
 * @param {string} videoPath - Local path to video file
 * @param {string} prompt - Analysis prompt
 * @returns {Promise<string>} - Analysis text
 */
export async function analyzeVideo(videoPath, prompt) {
  const fileName = basename(videoPath);
  console.log(`[Gemini] Uploading ${fileName}...`);

  // Upload file to Gemini
  const uploadResult = await ai.files.upload({
    file: videoPath,
    config: { mimeType: 'video/mp4' },
  });

  // Wait for processing
  let file = uploadResult;
  while (file.state === 'PROCESSING') {
    console.log(`[Gemini] Processing ${fileName}...`);
    await new Promise(r => setTimeout(r, 5000));
    file = await ai.files.get({ name: file.name });
  }

  if (file.state === 'FAILED') {
    throw new Error(`Gemini file processing failed for ${fileName}`);
  }

  console.log(`[Gemini] Analyzing ${fileName}...`);

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
          { text: prompt },
        ],
      },
    ],
  });

  // Clean up uploaded file
  try {
    await ai.files.delete({ name: file.name });
  } catch (e) {
    console.warn(`[Gemini] Cleanup warning: ${e.message}`);
  }

  return response.text;
}
