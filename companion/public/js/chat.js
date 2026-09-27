// Talking to the server: streaming replies and cutting them into speakable sentences.

export async function* streamChat(payload, signal) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Chat failed (${res.status})`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.error) throw new Error(event.error);
      if (event.delta) yield event.delta;
    }
  }
}

export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

const MOODS = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry', surprised: 'surprised', relaxed: 'relaxed',
  // what small models write instead
  joy: 'happy', joyful: 'happy', excited: 'happy', playful: 'happy', flirty: 'happy', amused: 'happy', laughing: 'happy',
  sorrow: 'sad', upset: 'sad', hurt: 'sad', lonely: 'sad',
  annoyed: 'angry', mad: 'angry', frustrated: 'angry',
  shocked: 'surprised', curious: 'surprised',
  calm: 'relaxed', content: 'relaxed', shy: 'relaxed', loving: 'relaxed', tender: 'relaxed',
};
const TAG = /\[([^\]\n]{1,24})\]/g;

const moodOf = (tag) => MOODS[tag.trim().toLowerCase().split(/\W+/)[0]];
// Reply text without mood tags (stored replies keep them as examples for the model).
export const tidy = (text) => text.replace(TAG, '').replace(/\[[^\]\n]*$/, '').replace(/\s+/g, ' ').trim();

// What the voice should read: no *actions*, emojis or markdown.
const speakable = (text) =>
  text
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Position just after the first sentence end at or beyond minLength, or 0.
function sentenceBreak(text, minLength) {
  const end = /[.!?…]+["'”’)\]]*\s+|\n+/g;
  for (let m; (m = end.exec(text)); ) {
    const at = m.index + m[0].length;
    if (at >= minLength) return at;
  }
  return 0;
}

// Accumulates a streamed reply. Reports the visible text as it grows, and hands
// out whole sentences (with the mood they were said in) as soon as they are
// complete, so her voice can start before the model has finished writing.
export class ReplyStream {
  #raw = '';
  #spoken = 0;
  #count = 0;
  #mood = 'neutral';

  constructor({ onText, onSentence }) {
    this.onText = onText;
    this.onSentence = onSentence;
  }

  get text() {
    return tidy(this.#raw);
  }

  push(delta) {
    this.#raw += delta;
    this.onText?.(this.text);
    this.#drain(false);
  }

  end() {
    this.#drain(true);
  }

  #drain(final) {
    for (;;) {
      const rest = this.#raw.slice(this.#spoken);
      // A short first sentence gets her talking sooner; later ones are batched for smoother prosody.
      const cut = final ? rest.length : sentenceBreak(rest, this.#count === 0 ? 12 : 40);
      if (!cut) return;
      this.#spoken += cut;
      this.#emit(rest.slice(0, cut));
      if (final) return;
    }
  }

  #emit(chunk) {
    for (const [, tag] of chunk.matchAll(TAG)) this.#mood = moodOf(tag) ?? this.#mood;
    const display = tidy(chunk);
    if (!display) return;
    this.#count++;
    this.onSentence?.({ display, speech: speakable(display), emotion: this.#mood });
  }
}
