import { AssemblyAI } from 'assemblyai';

let client;

export function getClient() {
  if (!client) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY || process.env.ASSEMBLY_AI_API_KEY;
    if (!apiKey) {
      throw new Error('ASSEMBLYAI_API_KEY not set. Add it to .env file.');
    }
    client = new AssemblyAI({ apiKey });
  }
  return client;
}

/**
 * Submit a transcription request. Returns the transcript object (with id, status).
 */
export async function submitTranscription(audioUrl, speakersExpected) {
  const aai = getClient();
  const params = {
    audio_url: audioUrl,
    speech_models: ['universal-3-pro'],
    speaker_labels: true,
    speakers_expected: speakersExpected,
    language_code: 'en',
  };
  const transcript = await aai.transcripts.transcribe(params);
  return transcript;
}

/**
 * Get transcript status/result by ID.
 */
export async function getTranscript(transcriptId) {
  const aai = getClient();
  return aai.transcripts.get(transcriptId);
}

/**
 * Submit without waiting — just queue the job and return immediately.
 */
export async function submitOnly(audioUrl, speakersExpected) {
  const aai = getClient();
  const params = {
    audio_url: audioUrl,
    speech_models: ['universal-3-pro'],
    speaker_labels: true,
    speakers_expected: speakersExpected,
    language_code: 'en',
  };
  const transcript = await aai.transcripts.submit(params);
  return transcript;
}
