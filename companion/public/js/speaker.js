// Her voice. Sentences are synthesized as soon as they arrive and played in
// order; an analyser on the output drives the avatar's lip sync. Uses the
// server's TTS when configured, otherwise the browser's built-in voices.

const VOICE_KEY = 'companion.voice';

export class Speaker {
  #queue = [];
  #generation = 0;
  #pumping = false;
  #waiters = [];
  #source = null;
  #browserTalking = false;

  constructor({ serverTts = false, onStart, onError } = {}) {
    this.serverTts = serverTts;
    this.onStart = onStart;
    this.onError = onError;
  }

  // Call from a click handler: browsers only allow audio after a user gesture.
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.4;
      this.analyser.connect(this.ctx.destination);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
    return this.ctx.resume();
  }

  get speaking() {
    return this.#pumping;
  }

  say(item) {
    if (this.serverTts && item.speech) {
      item.audio = this.#synthesize(item.speech);
      item.audio.catch(() => {}); // failures are handled when it's this item's turn
    }
    this.#queue.push(item);
    if (!this.#pumping) this.#pump(this.#generation);
  }

  // Resolves once everything queued so far has been said (or stop() is called).
  finished() {
    if (!this.#pumping && !this.#queue.length) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  stop() {
    this.#generation++;
    this.#queue = [];
    this.#pumping = false;
    this.#source?.stop();
    this.#source = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.#browserTalking = false;
    this.#release();
  }

  // Mouth shape for lip sync: open (0..1) plus how round/wide the sound is.
  mouth(time) {
    if (this.#browserTalking) {
      // Browser voices can't be analysed, so fake a plausible flap.
      const flap = Math.abs(Math.sin(time * 13) * Math.sin(time * 4.7 + 1));
      return { open: 0.1 + 0.55 * flap, round: 0.4, wide: 0.3 };
    }
    if (!this.#source) return null;
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (const x of this.timeData) sum += x * x;
    const rms = Math.sqrt(sum / this.timeData.length);

    this.analyser.getByteFrequencyData(this.freqData);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const band = (lo, hi) => {
      let total = 0;
      const from = Math.round(lo / hz), to = Math.round(hi / hz);
      for (let i = from; i < to; i++) total += this.freqData[i];
      return total / Math.max(1, to - from);
    };
    const low = band(200, 900), high = band(1800, 4500);
    const sumBands = low + high + 1e-6;
    return {
      open: Math.min(1, Math.max(0, (rms - 0.01) * 7)),
      round: low / sumBands,
      wide: high / sumBands,
    };
  }

  async #pump(generation) {
    this.#pumping = true;
    while (this.#queue.length) {
      const item = this.#queue.shift();
      let started = false;
      try {
        const audio = item.audio ? await item.audio : null;
        if (generation !== this.#generation) return;
        started = true;
        this.onStart?.(item);
        if (!item.speech) await wait(600);
        else if (audio) await this.#play(audio, generation);
        else await this.#speakWithBrowser(item.speech);
      } catch (err) {
        if (generation !== this.#generation) return;
        this.onError?.(err);
        // Keep talking with the browser's voice rather than going silent.
        if (!started) this.onStart?.(item);
        await this.#speakWithBrowser(item.speech);
      }
      if (generation !== this.#generation) return;
    }
    this.#pumping = false;
    this.#release();
  }

  #release() {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #synthesize(text) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Voice failed (${res.status})`);
    return res.arrayBuffer();
  }

  async #play(data, generation) {
    const buffer = await this.ctx.decodeAudioData(data);
    if (generation !== this.#generation) return;
    await new Promise((resolve) => {
      const source = this.ctx.createBufferSource();
      const done = () => {
        clearTimeout(watchdog);
        if (this.#source === source) this.#source = null;
        resolve();
      };
      // Don't hang the conversation if playback never finishes (e.g. audio blocked).
      const watchdog = setTimeout(done, buffer.duration * 1000 + 2000);
      source.buffer = buffer;
      source.connect(this.analyser);
      source.onended = done;
      this.#source = source;
      source.start();
    });
  }

  #speakWithBrowser(text) {
    if (!('speechSynthesis' in window) || !text) return Promise.resolve();
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickBrowserVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.pitch = 1.05;
      const done = () => {
        clearTimeout(watchdog);
        this.#browserTalking = false;
        resolve();
      };
      // Some systems have no voices and never report the end of speech.
      const watchdog = setTimeout(done, 3000 + text.length * 120);
      utterance.onstart = () => (this.#browserTalking = true);
      utterance.onend = utterance.onerror = done;
      speechSynthesis.speak(utterance);
    });
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function browserVoices() {
  return 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
}

export function savedVoiceName() {
  try {
    return localStorage.getItem(VOICE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveVoiceName(name) {
  try {
    localStorage.setItem(VOICE_KEY, name);
  } catch {
    // private mode: the choice just won't be remembered
  }
}

function pickBrowserVoice() {
  const voices = browserVoices();
  const saved = savedVoiceName();
  const lang = navigator.language.split('-')[0];
  return (
    voices.find((v) => v.name === saved) ??
    voices.find((v) => v.lang.startsWith(lang) && /female|samantha|victoria|karen|moira|tessa|zira|aria|jenny|sonia|libby|ava|allison|susan|serena|anna|helena|hedda|katja/i.test(v.name)) ??
    voices.find((v) => v.lang.startsWith(lang)) ??
    null
  );
}
