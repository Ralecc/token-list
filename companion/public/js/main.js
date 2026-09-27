// The call screen: wires the camera, microphone, her voice and face together.

import { Avatar } from './avatar.js';
import { postJson, ReplyStream, streamChat, tidy } from './chat.js';
import { BrowserListener, WhisperListener } from './listener.js';
import { browserVoices, savedVoiceName, saveVoiceName, Speaker } from './speaker.js';

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'), canvas: $('avatar'), orb: $('orb'), empty: $('empty'), loading: $('loading'), drop: $('drop'),
  name: $('name'), presence: $('presence'), status: $('status'), timer: $('timer'),
  captions: $('captions'), toast: $('toast'), self: $('self'),
  chat: $('chat'), log: $('log'), composer: $('composer'), input: $('input'),
  micBtn: $('micBtn'), camBtn: $('camBtn'), callBtn: $('callBtn'), chatBtn: $('chatBtn'), settingsBtn: $('settingsBtn'),
  settings: $('settings'), settingsForm: $('settingsForm'), fileInput: $('fileInput'),
};

const STATUS = {
  idle: 'Not in a call',
  connecting: 'Connecting…',
  listening: 'Listening',
  muted: 'You are muted',
  typing: 'Type to talk',
  thinking: 'Thinking…',
  speaking: 'Speaking',
};

let state = null; // from the server: persona, settings, features, recent messages
let avatarUrl = null;
let inCall = false;
let media = null; // camera + microphone while in a call
let listener = null;
let micMuted = false;
let turn = null; // AbortController of the reply in progress
let voiceWarned = false;
let resumeTimer = 0;
let captionTimer = 0;
let toastTimer = 0;
let clockTimer = 0;
let wakeLock = null;
let callCount = 0;

const speaker = new Speaker({
  onStart(sentence) {
    setStatus('speaking');
    showCaption(sentence.display);
    avatar.setEmotion(sentence.emotion);
  },
  onError(err) {
    if (voiceWarned) return;
    voiceWarned = true;
    toast(`Voice server problem (${err.message}), using the browser voice for now.`);
  },
});
const avatar = new Avatar(ui.canvas, { mouth: (time) => speaker.mouth(time), orb: ui.orb });

wireControls();
loadState().catch((err) => {
  setStatus('idle');
  toast(`Can't reach the Companion server: ${err.message}`);
});

// ---------------------------------------------------------------------------
// State and rendering

async function loadState(next) {
  if (!next) {
    const res = await fetch('/api/state');
    next = await res.json();
    if (!res.ok) throw new Error(next.error);
  }
  state = next;
  speaker.serverTts = state.features.tts;
  ui.name.textContent = state.persona.name;
  document.title = `${state.persona.name} · Companion`;
  ui.presence.classList.add('online');
  ui.log.replaceChildren();
  state.messages.forEach(addMessage);
  if (state.avatarUrl !== avatarUrl) loadAvatar(state.avatarUrl);
  refreshStage();
  if (!inCall) setStatus('idle');
}

async function loadAvatar(url) {
  avatarUrl = url;
  if (!url) {
    avatar.unload();
    return refreshStage();
  }
  ui.loading.hidden = false;
  ui.loading.textContent = 'Loading avatar…';
  try {
    await avatar.load(url, (p) => (ui.loading.textContent = `Loading avatar… ${Math.round(p * 100)}%`));
  } catch (err) {
    avatarUrl = null;
    toast(`Couldn't load the avatar: ${err.message}`);
  } finally {
    ui.loading.hidden = true;
    refreshStage();
  }
}

// Without an avatar: instructions before the call, a voice orb during it.
function refreshStage() {
  const noAvatar = !avatar.vrm && ui.loading.hidden;
  ui.empty.hidden = !noAvatar || inCall;
  ui.orb.hidden = !noAvatar || !inCall;
}

function setStatus(kind) {
  ui.status.dataset.kind = kind;
  ui.status.textContent = STATUS[kind];
  avatar.setMood(kind);
}

function addMessage({ role, content, ts, meta }) {
  const li = document.createElement('li');
  if (meta) {
    li.className = 'divider';
    li.textContent = `Call · ${new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  } else {
    li.className = `msg ${role}`;
    setRichText(li, role === 'assistant' ? tidy(content) : content);
  }
  ui.log.append(li);
  scrollLog();
  return li;
}

function addNotice(text) {
  const li = document.createElement('li');
  li.className = 'notice';
  li.textContent = text;
  ui.log.append(li);
  scrollLog();
}

// Plain text, with *actions* in italics.
function setRichText(el, text) {
  el.replaceChildren(
    ...text
      .split(/(\*[^*\n]+\*)/g)
      .filter(Boolean)
      .map((part) =>
        /^\*[^*]+\*$/.test(part)
          ? Object.assign(document.createElement('em'), { textContent: part.slice(1, -1) })
          : document.createTextNode(part),
      ),
  );
}

function scrollLog() {
  ui.log.scrollTop = ui.log.scrollHeight;
}

function showCaption(text, fromYou = false) {
  clearTimeout(captionTimer);
  ui.captions.textContent = text;
  ui.captions.classList.toggle('you', fromYou);
  if (fromYou) captionTimer = setTimeout(() => showCaption(''), 4000);
}

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 7000);
}

// ---------------------------------------------------------------------------
// Conversation

async function talk({ text, event }) {
  interrupt();
  clearTimeout(resumeTimer);
  listener?.pause();
  if (text) addMessage({ role: 'user', content: text });
  if (event === 'call_start') addMessage({ meta: true, ts: Date.now() });

  const controller = new AbortController();
  turn = controller;
  voiceWarned = false;
  setStatus('thinking');
  const bubble = addMessage({ role: 'assistant', content: '' });
  const reply = new ReplyStream({
    onText(visible) {
      setRichText(bubble, visible);
      scrollLog();
    },
    onSentence(sentence) {
      if (inCall) speaker.say(sentence);
      else avatar.setEmotion(sentence.emotion);
    },
  });

  try {
    for await (const delta of streamChat({ text, event, image: snapshot() }, controller.signal)) reply.push(delta);
    reply.end();
    if (!reply.text) bubble.remove();
    await speaker.finished();
  } catch (err) {
    if (controller.signal.aborted) return;
    if (!reply.text) bubble.remove();
    addNotice(err.message);
    toast(err.message);
  } finally {
    if (turn === controller) {
      turn = null;
      afterTurn();
    }
  }
}

// Cut her off (she stops talking right away).
function interrupt() {
  if (!turn) return false;
  turn.abort();
  turn = null;
  speaker.stop();
  showCaption('');
  return true;
}

function afterTurn() {
  if (!inCall) return setStatus('idle');
  setStatus(!listener ? 'typing' : micMuted ? 'muted' : 'listening');
  captionTimer = setTimeout(() => showCaption(''), 2500);
  // A short gap so the tail of her voice isn't taken for yours.
  resumeTimer = setTimeout(() => !turn && inCall && listener?.resume(), 300);
}

async function onUtterance(wav) {
  if (turn) return;
  listener?.pause();
  setStatus('thinking');
  try {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    const { text, error } = await res.json();
    if (!res.ok) throw new Error(error);
    if (!inCall || turn) return;
    if (!text) return afterTurn();
    showCaption(text, true);
    talk({ text });
  } catch (err) {
    toast(`Couldn't understand that: ${err.message}`);
    if (!turn) afterTurn();
  }
}

// A small camera still for vision models, so she can see you.
function snapshot() {
  if (!inCall || !state.features.vision || !state.settings.vision) return null;
  const video = ui.self;
  if (!media?.getVideoTracks()[0]?.enabled || !video.videoWidth) return null;
  const scale = Math.min(1, 512 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

// ---------------------------------------------------------------------------
// The call

async function startCall() {
  speaker.unlock(); // must happen inside the click: browsers only allow audio after a gesture
  const call = ++callCount;
  const stillThisCall = () => inCall && call === callCount; // false once hung up (or redialled)
  inCall = true;
  micMuted = false;
  ui.callBtn.classList.add('active');
  ui.callBtn.setAttribute('aria-label', 'End call');
  setStatus('connecting');

  const stream = await openMedia();
  if (!stillThisCall()) return stream?.getTracks().forEach((track) => track.stop());
  media = stream;

  const video = media?.getVideoTracks()[0];
  ui.self.srcObject = video ? media : null;
  ui.self.hidden = !video;
  ui.camBtn.disabled = !video;
  if (video) await firstFrame(ui.self); // so she can already see you when she says hello
  if (!stillThisCall()) return;
  listener = createListener();
  try {
    await listener?.ready;
  } catch (err) {
    listener = null;
    toast(`Couldn't start listening (${err.message}). Type in the chat instead.`);
  }
  if (!stillThisCall()) return;
  ui.micBtn.disabled = !listener;
  if (!listener) ui.chat.hidden = false;

  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    ui.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  clockTimer = setInterval(tick, 1000);
  navigator.wakeLock
    ?.request('screen')
    .then((lock) => (stillThisCall() ? (wakeLock = lock) : lock.release()))
    .catch(() => {});

  refreshStage();
  talk({ event: 'call_start' });
}

function endCall() {
  inCall = false;
  interrupt();
  clearTimeout(resumeTimer);
  clearInterval(clockTimer);
  listener?.stop();
  listener = null;
  stopMedia();
  wakeLock?.release().catch(() => {});
  wakeLock = null;

  ui.callBtn.classList.remove('active');
  ui.callBtn.setAttribute('aria-label', 'Start call');
  for (const button of [ui.micBtn, ui.camBtn]) {
    button.disabled = true;
    button.classList.remove('off');
  }
  ui.self.hidden = true;
  ui.timer.textContent = '';
  showCaption('');
  avatar.setEmotion('neutral');
  setStatus('idle');
  refreshStage();
}

async function openMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera and microphone only work on https:// or localhost. Type in the chat instead.');
    return null;
  }
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    });
  } catch {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      toast("No camera, so she can hear you but can't see you.");
      return stream;
    } catch {
      toast('No microphone access. Type in the chat to talk.');
      return null;
    }
  }
}

function firstFrame(videoEl) {
  return new Promise((resolve) => {
    if (videoEl.readyState >= 2) return resolve();
    videoEl.addEventListener('loadeddata', resolve, { once: true });
    setTimeout(resolve, 2000);
  });
}

function stopMedia() {
  media?.getTracks().forEach((track) => track.stop());
  media = null;
  ui.self.srcObject = null;
}

function createListener() {
  if (!media?.getAudioTracks().length) return null;
  if (state.features.stt) {
    return new WhisperListener(media, {
      ctx: speaker.ctx,
      onUtterance,
      onLevel: (rms) => ui.micBtn.style.setProperty('--level', Math.min(1, rms * 12).toFixed(2)),
    });
  }
  if (BrowserListener.supported) {
    return new BrowserListener({
      onText(text) {
        if (turn) return;
        showCaption(text, true);
        talk({ text });
      },
    });
  }
  toast('This browser has no speech recognition. Set STT_BASE_URL (local Whisper) or type in the chat.');
  return null;
}

function toggleMic() {
  micMuted = !micMuted;
  media?.getAudioTracks().forEach((track) => (track.enabled = !micMuted));
  listener?.setMuted(micMuted);
  ui.micBtn.classList.toggle('off', micMuted);
  ui.micBtn.setAttribute('aria-label', micMuted ? 'Unmute microphone' : 'Mute microphone');
  if (!turn) setStatus(micMuted ? 'muted' : 'listening');
}

function toggleCamera() {
  const track = media?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  ui.self.hidden = !track.enabled;
  ui.camBtn.classList.toggle('off', !track.enabled);
  ui.camBtn.setAttribute('aria-label', track.enabled ? 'Turn camera off' : 'Turn camera on');
}

// ---------------------------------------------------------------------------
// Settings and avatar upload

function openSettings() {
  if (!state) return;
  const f = ui.settingsForm.elements;
  f.userName.value = state.settings.userName;
  f.persona.replaceChildren(...state.personas.map((p) => new Option(p.name, p.id, false, p.id === state.settings.persona)));
  $('personaRow').hidden = state.personas.length < 2;

  f.vision.checked = state.features.vision && state.settings.vision;
  f.vision.disabled = !state.features.vision;
  $('visionHint').textContent = state.features.vision
    ? 'Sends a small camera snapshot with each message.'
    : 'Needs a vision model and LLM_VISION=true in .env.';

  f.adultMode.checked = state.settings.adultMode;
  f.adultMode.disabled = !state.features.adult;
  $('adultHint').textContent = state.features.adult
    ? 'Allows sexually explicit conversation. Whether it happens also depends on your model.'
    : 'Only available for characters whose "age" is 18 or more.';

  const voices = state.features.tts ? [] : browserVoices();
  $('voiceRow').hidden = !voices.length;
  f.voice.replaceChildren(new Option('Automatic', ''), ...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.name)));
  f.voice.value = voices.some((v) => v.name === savedVoiceName()) ? savedVoiceName() : '';

  $('engines').textContent =
    `Brain: ${state.model} · Voice: ${state.features.tts ? 'local TTS server' : 'browser'} · ` +
    `Hearing: ${state.features.stt ? 'local Whisper' : 'browser'}`;
  ui.settings.returnValue = '';
  ui.settings.showModal();
}

async function saveSettings() {
  const f = ui.settingsForm.elements;
  if (!state.features.tts) saveVoiceName(f.voice.value);
  let adultMode = f.adultMode.checked;
  if (adultMode && !state.settings.adultMode) {
    adultMode = confirm('Adult mode allows sexually explicit conversation.\n\nConfirm that you are 18 or older.');
  }
  try {
    await loadState(
      await postJson('/api/settings', {
        userName: f.userName.value,
        persona: f.persona.value || undefined,
        vision: f.vision.disabled ? undefined : f.vision.checked,
        adultMode,
      }),
    );
  } catch (err) {
    toast(err.message);
  }
}

async function resetMemory() {
  if (!confirm(`${state.persona.name} will forget all your conversations. Continue?`)) return;
  ui.settings.close();
  try {
    await loadState(await postJson('/api/reset'));
  } catch (err) {
    toast(err.message);
  }
}

async function uploadAvatar(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.vrm')) return toast('Please choose a .vrm file.');
  ui.loading.hidden = false;
  ui.loading.textContent = 'Uploading avatar…';
  try {
    const res = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    await loadAvatar(json.avatarUrl);
  } catch (err) {
    ui.loading.hidden = true;
    toast(err.message);
  }
}

// ---------------------------------------------------------------------------

function wireControls() {
  ui.callBtn.addEventListener('click', () => (inCall ? endCall() : state && startCall()));
  ui.micBtn.addEventListener('click', toggleMic);
  ui.camBtn.addEventListener('click', toggleCamera);
  ui.chatBtn.addEventListener('click', () => {
    ui.chat.hidden = !ui.chat.hidden;
    if (!ui.chat.hidden && matchMedia('(pointer: fine)').matches) ui.input.focus();
  });
  $('closeChat').addEventListener('click', () => (ui.chat.hidden = true));

  ui.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ui.input.value.trim();
    if (!text || !state) return;
    ui.input.value = '';
    talk({ text });
  });

  ui.settingsBtn.addEventListener('click', openSettings);
  ui.settings.addEventListener('close', () => ui.settings.returnValue === 'save' && saveSettings());
  $('resetMemory').addEventListener('click', resetMemory);
  for (const button of [$('changeAvatar'), $('pickAvatar')]) button.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => {
    uploadAvatar(ui.fileInput.files[0]);
    ui.fileInput.value = '';
  });

  // Space, or a click on her video, cuts her off so you can talk.
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.target.closest('input, select, textarea, button, dialog')) return;
    event.preventDefault();
    if (inCall && interrupt()) afterTurn();
  });
  ui.canvas.addEventListener('click', () => inCall && speaker.speaking && interrupt() && afterTurn());
  // After a mouse or touch click, drop the button's focus so Space interrupts
  // her instead of pressing the button again (e.g. hanging up).
  document.querySelector('.controls').addEventListener('click', (event) => {
    if (event.detail) event.target.closest('button')?.blur();
  });

  let dragDepth = 0;
  ui.stage.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    ui.drop.hidden = false;
  });
  ui.stage.addEventListener('dragover', (event) => event.preventDefault());
  ui.stage.addEventListener('dragleave', () => {
    if (--dragDepth > 0) return;
    dragDepth = 0;
    ui.drop.hidden = true;
  });
  ui.stage.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    ui.drop.hidden = true;
    uploadAvatar(event.dataTransfer.files[0]);
  });
}
