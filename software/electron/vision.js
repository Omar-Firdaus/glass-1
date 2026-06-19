const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';

const DEFAULT_PROMPT =
  'You are a technical analyst for smart-glass wearers. Identify the single primary subject ' +
  'in this frame. Give a concise expert readout: what it is, make and model if visible or ' +
  'strongly inferable from logos, labels, or design, plus one or two concrete specs or ' +
  'capabilities (e.g. megapixels, focal length, chipset, capacity, material, generation). ' +
  'Skip obvious filler — never say only what something is without naming it and adding ' +
  'useful detail. If uncertain, give your best brief guess and say "likely". ' +
  '1–2 short spoken sentences. No lists, no preamble. Hard limit: 30 words.';

async function analyzeImage(imageDataUrl, prompt) {
  if (!OPENAI_API_KEY) {
    return {
      success: false,
      error: 'Missing OPENAI_API_KEY. Add it to software/.env and restart the app.',
    };
  }

  if (!imageDataUrl || !imageDataUrl.startsWith('data:image/')) {
    return { success: false, error: 'Invalid image data.' };
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt || DEFAULT_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
            ],
          },
        ],
        max_tokens: 90,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return {
        success: false,
        error: `OpenAI API error (${res.status}): ${errBody.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    const analysis = data.choices?.[0]?.message?.content?.trim();
    if (!analysis) {
      return { success: false, error: 'No analysis returned from the API.' };
    }

    return { success: true, analysis, model: VISION_MODEL };
  } catch (err) {
    return { success: false, error: err.message || 'Vision analysis failed.' };
  }
}

function registerVisionIpc(ipcMain) {
  ipcMain.handle('vision:analyze', (_event, payload) => {
    const imageDataUrl = payload?.imageDataUrl;
    const prompt = payload?.prompt;
    return analyzeImage(imageDataUrl, prompt);
  });
}

module.exports = { registerVisionIpc, analyzeImage };
