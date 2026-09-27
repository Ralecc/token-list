// Hands-free listening. Both listeners share one small interface:
//   resume() / pause()  turn-taking: the app pauses listening while she talks
//   setMuted(bool)      the user's mute button
//   stop()

const MIN_THRESHOLD = 0.012; // RMS below this is never speech
const START_BLOCKS = 3; // consecutive loud blocks (~130 ms) that count as speech
const PREROLL_BLOCKS = 6; // audio kept from just before speech was detected
const NOISE_WINDOW_BLOCKS = 70;
const END_SILENCE_MS = 900; // pause that ends your turn
const MIN_SPEECH_MS = 350;
const MAX_UTTERANCE_MS = 30000;
const TARGET_RATE = 16000; // what Whisper wants

// Finds utterances with an energy-based voice detector and hands each one
// over as a 16 kHz WAV blob, ready for a local Whisper server.
export class WhisperListener {
  #paused = true;
  #muted = false;
  #levels = []; // recent block loudness, to estimate the background noise

  constructor(stream, { ctx, onUtterance, onLevel }) {
    this.ctx = ctx;
    this.onUtterance = onUtterance;
    this.onLevel = onLevel;
    this.#reset();
    this.ready = this.#connect(stream);
  }

  async #connect(stream) {
    await this.ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture');
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // keeps the worklet running without playing the mic back
    this.node.port.onmessage = (event) => this.#onBlock(event.data);
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination);
  }

  resume() {
    this.#reset();
    this.#paused = false;
  }

  pause() {
    this.#paused = true;
    this.#reset();
  }

  setMuted(muted) {
    this.#muted = muted;
    this.#reset();
  }

  stop() {
    this.pause();
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
  }

  #reset() {
    this.speaking = false;
    this.blocks = [];
    this.preroll = [];
    this.loudBlocks = 0;
    this.silentMs = 0;
    this.voicedMs = 0;
  }

  #onBlock(samples) {
    let sum = 0;
    for (const x of samples) sum += x * x;
    const rms = Math.sqrt(sum / samples.length);
    this.onLevel?.(this.#muted ? 0 : rms);
    if (this.#paused || this.#muted) return;

    // Background noise = a quiet percentile of the last ~3 s (speech always has gaps).
    this.#levels.push(rms);
    if (this.#levels.length > NOISE_WINDOW_BLOCKS) this.#levels.shift();
    const noise = [...this.#levels].sort((a, b) => a - b)[Math.floor(this.#levels.length * 0.2)];
    const threshold = Math.max(MIN_THRESHOLD, noise * 3);
    const blockMs = (samples.length / this.ctx.sampleRate) * 1000;

    if (!this.speaking) {
      this.preroll.push(samples);
      if (this.preroll.length > PREROLL_BLOCKS) this.preroll.shift();
      this.loudBlocks = rms > threshold ? this.loudBlocks + 1 : 0;
      if (this.loudBlocks >= START_BLOCKS) {
        this.speaking = true;
        this.blocks = this.preroll;
        this.preroll = [];
        this.voicedMs = this.loudBlocks * blockMs;
        this.silentMs = 0;
      }
      return;
    }

    this.blocks.push(samples);
    if (rms > threshold * 0.7) {
      this.voicedMs += blockMs;
      this.silentMs = 0;
    } else {
      this.silentMs += blockMs;
    }
    if (this.silentMs >= END_SILENCE_MS || this.blocks.length * blockMs >= MAX_UTTERANCE_MS) {
      const { blocks, voicedMs } = this;
      this.#reset();
      if (voicedMs >= MIN_SPEECH_MS) this.onUtterance(encodeWav(downsample(concat(blocks), this.ctx.sampleRate, TARGET_RATE), TARGET_RATE));
    }
  }
}

// Fallback without a Whisper server: the browser's own speech recognition.
// Note that Chrome sends the audio to Google for this.
export class BrowserListener {
  static get supported() {
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }

  #paused = true;
  #muted = false;
  #running = false;

  constructor({ onText, lang }) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new Recognition();
    this.recognition.lang = lang || navigator.language;
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i].isFinal && event.results[i][0].transcript.trim();
        if (text && !this.#paused) onText(text);
      }
    };
    // Chrome ends recognition after a while of silence; keep it going.
    this.recognition.onend = () => {
      this.#running = false;
      this.#sync();
    };
  }

  resume() {
    this.#paused = false;
    this.#sync();
  }

  pause() {
    this.#paused = true;
    this.#sync();
  }

  setMuted(muted) {
    this.#muted = muted;
    this.#sync();
  }

  stop() {
    this.pause();
  }

  #sync() {
    const want = !this.#paused && !this.#muted;
    if (want && !this.#running) {
      try {
        this.recognition.start();
        this.#running = true;
      } catch {
        // already starting
      }
    } else if (!want && this.#running) {
      this.recognition.abort();
    }
  }
}

function concat(blocks) {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
