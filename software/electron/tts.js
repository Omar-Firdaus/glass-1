const TTS_MODEL = process.env.INWORLD_TTS_MODEL || 'inworld-tts-2';
const TTS_VOICE = process.env.INWORLD_TTS_VOICE || 'Freddie';

function buildAuthHeader() {
  const preset = (process.env.INWORLD_BASIC_AUTH || '').trim();
  if (preset) {
    return preset.startsWith('Basic ') ? preset : `Basic ${preset}`;
  }

  const apiKey = (process.env.INWORLD_API_KEY || '').trim();
  if (!apiKey) return null;

  if (apiKey.startsWith('Basic ')) {
    return apiKey;
  }

  const apiSecret = (process.env.INWORLD_API_KEY_SECRET || process.env.INWORLD_API_SECRET || '').trim();
  if (apiSecret) {
    return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
  }

  try {
    const decoded = Buffer.from(apiKey, 'base64').toString('utf8');
    if (decoded.includes(':')) {
      return `Basic ${apiKey}`;
    }
  } catch {
    // Fall through to treating apiKey as a raw credential string.
  }

  return `Basic ${apiKey}`;
}

function authHelpMessage(status) {
  if (status === 403 || status === 401) {
    return (
      'Invalid Inworld credentials. In Inworld Portal → API Keys, copy the ' +
      'Basic (Base64) authorization signature into INWORLD_API_KEY, then restart the app. ' +
      'Or set INWORLD_API_KEY + INWORLD_API_KEY_SECRET with your key id and secret.'
    );
  }
  return null;
}

async function synthesizeSpeech(text) {
  const authorization = buildAuthHeader();
  if (!authorization) {
    return {
      success: false,
      error: 'Missing INWORLD_API_KEY. Add it to software/.env and restart the app.',
    };
  }

  if (!text?.trim()) {
    return { success: false, error: 'No text to speak.' };
  }

  try {
    const res = await fetch('https://api.inworld.ai/tts/v1/voice', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.trim(),
        voiceId: TTS_VOICE,
        modelId: TTS_MODEL,
        audioConfig: {
          audioEncoding: 'MP3',
          sampleRateHertz: 48000,
        },
        applyTextNormalization: 'ON',
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      const authHelp = authHelpMessage(res.status);
      return {
        success: false,
        error: authHelp || `Inworld TTS error (${res.status}): ${errBody.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    if (!data.audioContent) {
      return { success: false, error: 'No audio returned from Inworld.' };
    }

    return {
      success: true,
      audioBase64: data.audioContent,
      contentType: 'audio/mpeg',
      model: TTS_MODEL,
      voice: TTS_VOICE,
    };
  } catch (err) {
    return { success: false, error: err.message || 'Text-to-speech failed.' };
  }
}

function registerTtsIpc(ipcMain) {
  ipcMain.handle('tts:speak', (_event, payload) => synthesizeSpeech(payload?.text));
}

module.exports = { registerTtsIpc, synthesizeSpeech, buildAuthHeader };
