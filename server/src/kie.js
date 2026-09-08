/**
 * kie.ai Suno client.
 *
 * Ported from erised-artist/lib/kie.ts. Two things carried over that were learned the
 * hard way there and cost a debugging session each:
 *
 *   1. kie returns HTTP 200 for application-level failures and puts the real status in
 *      `code`, so every response is unwrapped rather than trusted for `res.ok`.
 *   2. `prompt` carries the LYRICS, not a description, whenever customMode is on. That
 *      naming is kie's; getting it backwards yields a song *about* the lyrics.
 *
 * One thing learned here: the upload host is behind a WAF that 403s some default HTTP
 * user agents. Node's fetch is fine; a bare urllib request is not.
 */
const BASE = (process.env.SUNO_API_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const UPLOAD = process.env.KIE_UPLOAD_URL || 'https://kieai.redpandaai.co/api/file-stream-upload';

const key = () => {
  const k = process.env.SUNO_API_KEY;
  if (!k) throw new Error('SUNO_API_KEY is not set');
  return k;
};

async function call(path, init = {}) {
  const res = await fetch(path.startsWith('http') ? path : BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${key()}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`kie ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (body.code !== 200) throw new Error(`kie ${path}: ${body.code} ${body.msg}`);
  return body.data;
}

const postJson = (path, payload) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** Credits remaining. Cheap enough to use as a health check. */
export const credits = () => call('/api/v1/chat/credit');

/** Push a buffer to kie's blob host and get a URL the Suno endpoints accept. */
export async function uploadAudio(buffer, fileName) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), fileName);
  form.append('uploadPath', 'twelfth-night');
  form.append('fileName', fileName);

  const res = await fetch(UPLOAD, { method: 'POST', headers: { Authorization: `Bearer ${key()}` }, body: form });
  const body = await res.json();
  if (body.code !== 200 || !body.data) throw new Error(`upload failed: ${body.code} ${body.msg}`);
  const url = body.data.downloadUrl || body.data.fileUrl;
  if (!url) throw new Error('upload succeeded but returned no URL');
  return url;
}

/** Text-to-song. `lyrics` are sung; `style` describes the arrangement. */
export function generate({ lyrics, style, title, instrumental = false }) {
  return postJson('/api/v1/generate', {
    prompt: lyrics,
    style,
    title,
    customMode: true,
    instrumental,
    model: process.env.SUNO_MODEL || 'V5',
    callBackUrl: 'https://example.com/cb',
  });
}

export const songStatus = (taskId) =>
  call(`/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`);

/**
 * Split a finished song into vocal + instrumental.
 *
 * `separate_vocal` is the 10-credit tier and returns TWO stems. The 50-credit
 * multi-stem tier additionally isolates backing vocals, which swap_v2.sh wants so it
 * can pass harmonies through unconverted — converting them renders a softly-sung
 * harmony at full voice (+14.6 dB measured) and sounds wrong. Starting cheap on
 * purpose; switch `type` when the 2-stem result proves not good enough.
 *
 * Returns null rather than throwing when Suno declines: it fingerprints audio and
 * refuses anything matching a real commercial recording.
 */
export async function separateStems(audioUrl, { timeoutMs = 300_000 } = {}) {
  let started;
  try {
    started = await postJson('/api/v1/vocal-removal/generate', {
      audioUrl,
      type: 'separate_vocal',
      stemName: 'vocal',
      callBackUrl: 'https://example.com/cb',
    });
  } catch {
    return null;
  }
  const taskId = started?.taskId;
  if (!taskId) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    let d;
    try {
      d = await call(`/api/v1/vocal-removal/record-info?taskId=${encodeURIComponent(taskId)}`);
    } catch {
      continue;
    }
    if (d?.successFlag === 'SUCCESS') {
      const v = d.response?.vocalUrl;
      const b = d.response?.instrumentalUrl;
      return v && b ? { vocalUrl: v, instrumentalUrl: b } : null;
    }
    if (String(d?.successFlag || '').includes('FAILED')) return null;
  }
  return null;
}
