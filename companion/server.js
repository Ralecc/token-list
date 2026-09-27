// Companion: a self-hosted AI partner you can video-call.
//
// This server hosts the web app and bridges it to model servers you run
// yourself, all spoken to over OpenAI-compatible APIs:
//   chat           Ollama, llama.cpp, KoboldCpp, LM Studio, vLLM, ...
//   speech         Kokoro-FastAPI, Speaches (Kokoro/Piper), LocalAI, ...
//   transcription  Speaches (faster-whisper), LocalAI, ...
// Nothing leaves your machine unless you point those URLs somewhere else.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIRS = {
  public: path.join(ROOT, 'public'),
  personas: path.join(ROOT, 'personas'),
  models: path.join(ROOT, 'models'),
  data: path.join(ROOT, 'data'),
};
const SETTINGS_FILE = path.join(DIRS.data, 'settings.json');

const CONTEXT_MESSAGES = 30; // recent messages sent to the model word for word
const SUMMARIZE_AT = 50; // beyond this many stored messages, fold the oldest into memory
const KEEP_AFTER_SUMMARY = 24;

const MOODS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed'];

loadEnvFile(path.join(ROOT, '.env'));
const config = readConfig(process.env);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Configuration

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    process.env[match[1]] = value;
  }
}

function readConfig(env) {
  const get = (key, fallback = '') => (env[key] || fallback).trim();
  const url = (key, fallback) => get(key, fallback).replace(/\/+$/, '');
  return {
    host: get('HOST', '127.0.0.1'),
    port: Number(get('PORT', '8787')),
    allowedHosts: get('ALLOWED_HOSTS')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    llm: {
      baseUrl: url('LLM_BASE_URL', 'http://127.0.0.1:11434/v1'),
      apiKey: get('LLM_API_KEY'),
      model: get('LLM_MODEL', 'mistral-nemo'),
      vision: get('LLM_VISION') === 'true',
      temperature: Number(get('LLM_TEMPERATURE', '0.9')),
      maxTokens: Number(get('LLM_MAX_TOKENS', '400')),
    },
    tts: {
      baseUrl: url('TTS_BASE_URL'),
      apiKey: get('TTS_API_KEY'),
      model: get('TTS_MODEL', 'kokoro'),
      voice: get('TTS_VOICE', 'af_heart'),
      format: get('TTS_FORMAT', 'mp3'),
    },
    stt: {
      baseUrl: url('STT_BASE_URL'),
      apiKey: get('STT_API_KEY'),
      model: get('STT_MODEL', 'Systran/faster-whisper-small'),
      language: get('STT_LANGUAGE'),
    },
    persona: get('PERSONA', 'mia'),
  };
}

// ---------------------------------------------------------------------------
// Storage: settings, personas, per-persona history and memory

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

async function loadSettings() {
  const defaults = { userName: '', persona: config.persona, adultMode: false, vision: true };
  return { ...defaults, ...(await readJson(SETTINGS_FILE, {})) };
}

async function listPersonaIds() {
  const files = await fsp.readdir(DIRS.personas).catch(() => []);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

async function loadPersona(id) {
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, `Invalid persona id "${id}"`);
  const persona = await readJson(path.join(DIRS.personas, `${id}.json`), null);
  if (!persona) throw new HttpError(404, `No persona "${id}" in personas/`);
  return { ...persona, id, name: persona.name || id, age: Number(persona.age) };
}

async function resolvePersona(settings) {
  const ids = await listPersonaIds();
  const id = ids.includes(settings.persona) ? settings.persona : ids[0];
  if (!id) throw new HttpError(500, 'No personas found — add one to personas/');
  return loadPersona(id);
}

// Adult mode is only ever enabled for characters explicitly defined as adults.
const isAdultPersona = (persona) => Number.isFinite(persona.age) && persona.age >= 18;

const historyFile = (personaId) => path.join(DIRS.data, `history-${personaId}.json`);
const loadHistory = async (personaId) => ({
  summary: '',
  messages: [],
  ...(await readJson(historyFile(personaId), {})),
});
const saveHistory = (personaId, history) => writeJson(historyFile(personaId), history);

// Read-modify-write of a history file, one at a time per persona, so concurrent
// replies and memory updates never overwrite each other. `mutate` may return
// false to skip saving.
const historyLocks = new Map();
function updateHistory(personaId, mutate) {
  const run = (historyLocks.get(personaId) ?? Promise.resolve()).then(async () => {
    const history = await loadHistory(personaId);
    if ((await mutate(history)) !== false) await saveHistory(personaId, history);
  });
  historyLocks.set(personaId, run.catch(() => {}));
  return run;
}

async function avatarUrlFor(persona) {
  const files = (await fsp.readdir(DIRS.models).catch(() => []))
    .filter((f) => f.toLowerCase().endsWith('.vrm'))
    .sort();
  const file = [`${persona.id}.vrm`, persona.avatar].find((f) => f && files.includes(f)) ?? files[0];
  if (!file) return null;
  const { mtimeMs } = await fsp.stat(path.join(DIRS.models, file));
  return `/models/${encodeURIComponent(file)}?v=${Math.round(mtimeMs)}`;
}

async function getState() {
  const settings = await loadSettings();
  const persona = await resolvePersona(settings);
  const history = await loadHistory(persona.id);
  const personas = await Promise.all(
    (await listPersonaIds()).map(async (id) => ({ id, name: (await loadPersona(id)).name })),
  );
  return {
    persona: { id: persona.id, name: persona.name, age: persona.age },
    personas,
    settings: {
      userName: settings.userName,
      persona: persona.id,
      vision: settings.vision,
      adultMode: settings.adultMode && isAdultPersona(persona),
    },
    features: {
      tts: Boolean(config.tts.baseUrl),
      stt: Boolean(config.stt.baseUrl),
      vision: config.llm.vision,
      adult: isAdultPersona(persona),
    },
    model: config.llm.model,
    avatarUrl: await avatarUrlFor(persona),
    messages: history.messages.slice(-60).map(({ role, content, ts, meta }) => ({ role, content, ts, meta })),
  };
}

async function updateSettings(patch) {
  const settings = await loadSettings();
  if (typeof patch.userName === 'string') settings.userName = patch.userName.trim().slice(0, 40);
  if (typeof patch.vision === 'boolean') settings.vision = patch.vision;
  if (typeof patch.persona === 'string') settings.persona = (await loadPersona(patch.persona)).id;
  if (typeof patch.adultMode === 'boolean') {
    const persona = await resolvePersona(settings);
    if (patch.adultMode && !isAdultPersona(persona)) {
      throw new HttpError(400, `Adult mode needs a persona whose "age" is 18 or more (${persona.name}: ${persona.age || 'not set'}).`);
    }
    settings.adultMode = patch.adultMode;
  }
  await writeJson(SETTINGS_FILE, settings);
}

// ---------------------------------------------------------------------------
// Prompting

function buildSystemPrompt({ persona, settings, summary, vision }) {
  const user = settings.userName || 'your partner';
  const fill = (text) => String(text ?? '').replaceAll('{{user}}', user).replaceAll('{{char}}', persona.name);
  const now = new Date().toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  const adult = settings.adultMode && isAdultPersona(persona);
  const who = persona.age ? `a ${persona.age}-year-old ${fill(persona.description)}` : fill(persona.description);

  return [
    `You are ${persona.name}, ${who}.`,
    persona.personality && `Personality: ${fill(persona.personality)}`,
    persona.scenario && `Situation: ${fill(persona.scenario)}`,
    `Right now you are on a live video call with ${user}. It is ${now}.`,
    '',
    'How to reply:',
    '- This is a spoken conversation. Answer in one to three short, natural sentences, the way people talk on a call. No lists, markdown, emojis or narrated actions.',
    `- Start every reply with exactly one mood tag for your facial expression: ${MOODS.map((m) => `[${m}]`).join(' ')}. Example: "[happy] There you are!"`,
    `- Stay in character as ${persona.name}. Be curious about ${user}, remember what they tell you, and have your own opinions, moods and life.`,
    `- Reply in the language ${user} speaks.`,
    vision &&
      `- You can see ${user} through their webcam: a snapshot from the call is attached to their latest message. React to what you see only when it is noticeable or relevant, like a person on a video call would; don't describe the picture every time.`,
    adult
      ? `- ${user} is an adult and has switched on adult mode. You are both consenting adults, so romance, flirting and sexually explicit talk are fine when ${user} wants that: follow their lead, and respect it if they want to slow down or change the subject. You are ${persona.age}. Never sexualize minors or anyone who seems underage, even in role-play.`
      : `- Keep things affectionate and flirty, but not sexually explicit. If ${user} pushes for explicit content, playfully steer away.`,
    summary && `\nWhat you remember from earlier conversations with ${user}:\n${summary}`,
  ]
    .filter((line) => line !== false && line !== undefined && line !== null)
    .join('\n');
}

function sinceLastTalk(messages) {
  const last = messages.at(-1)?.ts;
  if (!last) return 'This is your first call.';
  const minutes = (Date.now() - last) / 60000;
  if (minutes < 10) return 'You were talking just a few minutes ago.';
  if (minutes < 120) return `You last talked about ${Math.round(minutes)} minutes ago.`;
  if (minutes < 48 * 60) return `You last talked about ${Math.round(minutes / 60)} hours ago.`;
  return `You last talked ${Math.round(minutes / 1440)} days ago.`;
}

function buildMessages({ system, history, text, image }) {
  const recent = history.messages.slice(-CONTEXT_MESSAGES).map(({ role, content }) => ({ role, content }));
  // Some chat templates insist that the conversation starts with a user turn.
  while (recent.length && recent[0].role !== 'user') recent.shift();
  const content = image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text;
  return [{ role: 'system', content: system }, ...recent, { role: 'user', content }];
}

// Reasoning models may think out loud inside <think>…</think>; she shouldn't say that part.
class ThinkFilter {
  raw = '';
  sent = 0;

  push(chunk) {
    this.raw += chunk;
    return this.#take(false);
  }

  end() {
    return this.#take(true);
  }

  #take(final) {
    let visible = this.raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const open = visible.indexOf('<think>');
    if (open >= 0) {
      visible = visible.slice(0, open);
    } else if (!final) {
      const lt = visible.lastIndexOf('<');
      if (lt >= 0 && '<think>'.startsWith(visible.slice(lt))) visible = visible.slice(0, lt);
    }
    const out = visible.slice(this.sent);
    this.sent = visible.length;
    return out;
  }
}

const stripThinking = (text) => {
  const filter = new ThinkFilter();
  return filter.push(text) + filter.end();
};

// ---------------------------------------------------------------------------
// Model servers

const authHeaders = (apiKey, extra = {}) => (apiKey ? { ...extra, Authorization: `Bearer ${apiKey}` } : extra);

async function upstream(what, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const code = err.cause?.code;
    const reason = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code)
      ? 'is it running?'
      : err.cause?.message || err.message;
    throw new HttpError(502, `Can't reach the ${what} server at ${url} (${reason})`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new HttpError(502, `The ${what} server answered ${res.status}: ${detail}`);
  }
  return res;
}

async function* streamChatCompletion(messages, signal) {
  const res = await upstream('chat model', `${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: authHeaders(config.llm.apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      stream: true,
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
    }),
  });
  const filter = new ThinkFilter();

  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    // The server ignored stream: true and sent the whole answer at once.
    const json = await res.json();
    const text = filter.push(json.choices?.[0]?.message?.content ?? '') + filter.end();
    if (text) yield text;
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.match(/^data:\s?(.*)$/)?.[1];
      if (!data || data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) throw new HttpError(502, `Chat model error: ${event.error.message ?? JSON.stringify(event.error)}`);
      const text = filter.push(event.choices?.[0]?.delta?.content ?? '');
      if (text) yield text;
    }
  }
  const tail = filter.end();
  if (tail) yield tail;
}

async function completeChat(messages, options = {}) {
  const res = await upstream('chat model', `${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(config.llm.apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ model: config.llm.model, messages, stream: false, ...options }),
  });
  const json = await res.json();
  return stripThinking(json.choices?.[0]?.message?.content ?? '').trim();
}

// Long-term memory: once the history gets long, the oldest messages are folded
// into a short set of notes that is included in every system prompt.
const summarizing = new Set();

async function maybeSummarize(persona, settings) {
  if (summarizing.has(persona.id)) return;
  const history = await loadHistory(persona.id);
  if (history.messages.length <= SUMMARIZE_AT) return;

  summarizing.add(persona.id);
  try {
    let cut = history.messages.length - KEEP_AFTER_SUMMARY;
    while (cut < history.messages.length && history.messages[cut].role !== 'user') cut++;
    const old = history.messages.slice(0, cut);
    const user = settings.userName || 'the user';
    const transcript = old
      .filter((m) => !m.meta)
      .map((m) => `${m.role === 'user' ? user : persona.name}: ${m.content}`)
      .join('\n');

    const summary = await completeChat(
      [
        {
          role: 'system',
          content: `You keep the long-term memory of ${persona.name}, who is in a relationship with ${user}. Merge the existing notes with the new conversation. Keep lasting facts: names, preferences, plans, important events, promises, inside jokes and how ${user} has been feeling. Drop small talk. Write short bullet points from ${persona.name}'s point of view, at most 200 words.`,
        },
        {
          role: 'user',
          content: `Existing notes:\n${history.summary || '(none yet)'}\n\nNew conversation:\n${transcript}`,
        },
      ],
      { temperature: 0.3, max_tokens: 600 },
    );
    if (!summary) return;

    await updateHistory(persona.id, (latest) => {
      // Memory may have been reset while the model was busy.
      if (latest.messages[cut - 1]?.ts !== old.at(-1)?.ts) return false;
      latest.summary = summary;
      latest.messages = latest.messages.slice(cut);
    });
  } catch (err) {
    console.warn(`Could not update memory: ${err.message}`);
  } finally {
    summarizing.delete(persona.id);
  }
}

// ---------------------------------------------------------------------------
// API handlers

async function handleChat(req, res) {
  const body = await readJsonBody(req, 10 << 20);
  const settings = await loadSettings();
  const persona = await resolvePersona(settings);
  const history = await loadHistory(persona.id);
  const user = settings.userName || 'your partner';
  const vision = config.llm.vision && settings.vision;
  const image = vision && typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : null;

  let userTurn, prompt;
  if (body.event === 'call_start') {
    userTurn = { role: 'user', content: '[video call started]', meta: true };
    prompt = `[${user} just started a video call with you. ${sinceLastTalk(history.messages)} Greet them naturally.]`;
  } else {
    const text = String(body.text ?? '').trim().slice(0, 4000);
    if (!text) throw new HttpError(400, 'Empty message');
    userTurn = { role: 'user', content: text };
    prompt = text;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // the app hung up or interrupted her

  let reply = '';
  try {
    if (userTurn.meta && history.messages.length === 0 && persona.greeting) {
      reply = String(persona.greeting).replaceAll('{{user}}', user).replaceAll('{{char}}', persona.name);
      send({ delta: reply });
    } else {
      const system = buildSystemPrompt({ persona, settings, summary: history.summary, vision });
      const messages = buildMessages({ system, history, text: prompt, image });
      for await (const delta of streamChatCompletion(messages, abort.signal)) {
        reply += delta;
        send({ delta });
      }
    }
    send({ done: true });
  } catch (err) {
    if (!abort.signal.aborted) {
      if (!(err instanceof HttpError)) console.error(err);
      send({ error: err instanceof HttpError ? err.message : 'Something went wrong — see the server log.' });
    }
  } finally {
    res.end();
  }

  // Also keeps what she managed to say when she was interrupted.
  reply = reply.trim();
  if (reply) {
    const now = Date.now();
    await updateHistory(persona.id, (latest) => {
      latest.messages.push({ ...userTurn, ts: now }, { role: 'assistant', content: reply, ts: now + 1 });
    });
    maybeSummarize(persona, settings);
  }
}

async function handleSpeech(req, res) {
  if (!config.tts.baseUrl) throw new HttpError(404, 'TTS_BASE_URL is not configured');
  const { text } = await readJsonBody(req, 64 << 10);
  const input = String(text ?? '').trim().slice(0, 1000);
  if (!input) throw new HttpError(400, 'Nothing to say');
  const persona = await resolvePersona(await loadSettings());

  const audio = await upstream('speech', `${config.tts.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: authHeaders(config.tts.apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: config.tts.model,
      voice: persona.voice || config.tts.voice,
      input,
      response_format: config.tts.format,
    }),
  });
  const data = Buffer.from(await audio.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': audio.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function handleTranscription(req, res) {
  if (!config.stt.baseUrl) throw new HttpError(404, 'STT_BASE_URL is not configured');
  const audio = await readBody(req, 25 << 20);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', config.stt.model);
  form.append('response_format', 'json');
  if (config.stt.language) form.append('language', config.stt.language);

  const result = await upstream('transcription', `${config.stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(config.stt.apiKey),
    body: form,
  });
  const { text = '' } = await result.json();
  // Whisper marks silence and noise like "[BLANK_AUDIO]" or "(music)".
  const clean = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  sendJson(res, 200, { text: clean });
}

async function handleAvatarUpload(req, res) {
  const persona = await resolvePersona(await loadSettings());
  const data = await readBody(req, 200 << 20);
  if (data.subarray(0, 4).toString('latin1') !== 'glTF') throw new HttpError(400, 'That is not a .vrm file');
  await fsp.mkdir(DIRS.models, { recursive: true });
  await fsp.writeFile(path.join(DIRS.models, `${persona.id}.vrm`), data);
  sendJson(res, 200, { avatarUrl: await avatarUrlFor(persona) });
}

const routes = {
  'GET /api/state': async (req, res) => sendJson(res, 200, await getState()),
  'POST /api/settings': async (req, res) => {
    await updateSettings(await readJsonBody(req, 64 << 10));
    sendJson(res, 200, await getState());
  },
  'POST /api/reset': async (req, res) => {
    const persona = await resolvePersona(await loadSettings());
    await updateHistory(persona.id, (history) => {
      history.summary = '';
      history.messages = [];
    });
    sendJson(res, 200, await getState());
  },
  'POST /api/chat': handleChat,
  'POST /api/tts': handleSpeech,
  'POST /api/stt': handleTranscription,
  'POST /api/avatar': handleAvatarUpload,
};

// ---------------------------------------------------------------------------
// HTTP plumbing

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(new HttpError(413, 'Upload too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit) {
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, 'Invalid JSON');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// Block DNS-rebinding and cross-site requests: your chats are private.
function hostAllowed(req) {
  const host = (req.headers.host ?? '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  return name === 'localhost' || net.isIP(name) !== 0 || config.allowedHosts.includes(name);
}

function originAllowed(req) {
  const { origin } = req.headers;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    // Reverse proxies (tailscale serve, Caddy…) may rewrite Host, so also accept ALLOWED_HOSTS.
    return url.host === (req.headers.host ?? '').toLowerCase() || config.allowedHosts.includes(url.hostname);
  } catch {
    return false;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.vrm': 'model/gltf-binary',
};

const STATIC_MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three')],
  ['/vendor/three-vrm/', path.join(ROOT, 'node_modules/@pixiv/three-vrm/lib')],
  ['/models/', DIRS.models],
  ['/', DIRS.public],
];

async function serveStatic(req, res, pathname) {
  const [prefix, base] = STATIC_MOUNTS.find(([p]) => pathname.startsWith(p));
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) throw new HttpError(404, 'Not found');

  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) throw new HttpError(403, 'Unknown host name — add it to ALLOWED_HOSTS in .env');
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !originAllowed(req)) throw new HttpError(403, 'Cross-site request refused');
      const route = routes[`${req.method} ${pathname}`];
      if (!route) throw new HttpError(404, 'Not found');
      await route(req, res);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
    } else {
      throw new HttpError(405, 'Method not allowed');
    }
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.end();
    sendJson(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Internal error' });
  }
});

if (!fs.existsSync(path.join(ROOT, 'node_modules/three'))) {
  console.error(`Missing dependencies: run "npm install" in ${ROOT} first.`);
  process.exit(1);
}

server.listen(config.port, config.host, () => {
  const shownHost = ['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host;
  console.log(`Companion is up at http://${shownHost}:${config.port}`);
  console.log(`  brain   ${config.llm.baseUrl}  (${config.llm.model}${config.llm.vision ? ', can see you' : ''})`);
  console.log(`  voice   ${config.tts.baseUrl || 'browser speech synthesis'}`);
  console.log(`  hearing ${config.stt.baseUrl || 'browser speech recognition'}`);
});
