import axios from 'axios';

const BASE = 'https://api.elevenlabs.io/v1';
const apiKey = () => process.env.ELEVENLABS_API_KEY;

/**
 * Generate TTS audio buffer using locked ElevenLabs settings.
 * Model: eleven_flash_v2_5, stability 0.35, similarity 0.83, style 0.27, speaker_boost ON
 */
export async function generateTTS({
  text,
  voice_id,
  stability = 0.35,
  similarity = 0.83,
  style = 0.27,
}) {
  const res = await axios.post(
    `${BASE}/text-to-speech/${voice_id}`,
    {
      text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: {
        stability,
        similarity_boost: similarity,
        style,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        'xi-api-key': apiKey(),
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(res.data);
}

/**
 * Generate sound effects audio buffer.
 * Used for background ambient audio in voiceover-with-sfx.
 */
export async function generateSFX({
  text,
  duration_seconds = null,
  prompt_influence = 0.3,
}) {
  const res = await axios.post(
    `${BASE}/sound-generation`,
    { text, duration_seconds, prompt_influence },
    {
      headers: {
        'xi-api-key': apiKey(),
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(res.data);
}
