# Companion: an AI partner you can video-call

A self-hosted virtual girlfriend (or boyfriend, or friend) built entirely from open-source
parts. You video-call her in the browser: she sees you through your webcam, hears you,
answers out loud with a lip-synced 3D face and facial expressions, and remembers your
past conversations. Everything runs on your own machine, so an adult mode is available.

```
 Browser                                        Your machine
┌───────────────────────────────┐   ┌──────────────────────────────────────────────┐
│ mic ─► voice detection ─► WAV ├──►│ server.js ─► Whisper   (speech → text)      │
│ webcam ─► snapshot ───────────├──►│           ─► LLM       (her mind, streamed)  │
│ 3D avatar ◄── lip sync ◄─ audio◄──┤           ─► TTS       (text → her voice)    │
└───────────────────────────────┘   │ data/     memory + chat history (JSON)       │
                                    └──────────────────────────────────────────────┘
```

| Part | Used here | Open-source options |
|---|---|---|
| Brain | any OpenAI-compatible chat API | [Ollama](https://ollama.com), [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`, [KoboldCpp](https://github.com/LostRuins/koboldcpp), LM Studio, text-generation-webui, vLLM |
| Eyes | webcam snapshot sent to a vision model | Gemma 3, Qwen2.5-VL, LLaVA… (`LLM_VISION=true`) |
| Ears | OpenAI-compatible `/audio/transcriptions` | [Speaches](https://speaches.ai) (faster-whisper), LocalAI, or the browser's recognition |
| Voice | OpenAI-compatible `/audio/speech` | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), Speaches (Kokoro/Piper), LocalAI, or the browser's voices |
| Face | [three.js](https://threejs.org) + [three-vrm](https://github.com/pixiv/three-vrm) | any `.vrm` avatar, e.g. made in VRoid Studio |

Replies stream sentence by sentence, so she starts talking before the model has finished
writing. The model tags each reply with a mood (`[happy]`, `[sad]`…) that drives her
expression. The tag is never read out loud.

## Quick start

You need [Node.js](https://nodejs.org) 18+ and, for the voice parts,
[Docker](https://docs.docker.com/get-docker/). A GPU helps but isn't required.

**1. Brain**: install [Ollama](https://ollama.com) and pull a model:

```sh
ollama pull mistral-nemo        # or any model you like
```

**2. Voice** (optional, the browser voice is used otherwise):

```sh
docker run -d -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
# NVIDIA GPU: docker run -d --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

**3. Ears** (optional, the browser's speech recognition is used otherwise):

```sh
docker run -d -p 8000:8000 -v hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu
curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small   # download the model once
```

**4. Companion:**

```sh
cd companion
npm install
cp .env.example .env        # set LLM_MODEL etc.; empty TTS/STT URLs = browser fallback
npm run sample-avatar       # optional: a free starter avatar
npm start
```

Open <http://localhost:8787>, press the green button and say hi.

## Using it

- **Talk hands-free.** She answers when you pause for about a second, and listens again once
  she has finished. Press **Space** or click her video to cut her off.
- **Type** in the messages panel at any time, during a call or not.
- **Let her see you** (Settings): with a vision model and `LLM_VISION=true`, a small camera
  snapshot goes along with each message. She won't describe it every time, but she'll notice
  when something changes.
- **Memory**: the last 30 messages are sent as they are. Older ones are condensed into
  long-term notes she keeps in mind. Everything is stored in `data/` (plain JSON), and
  *Forget everything* in Settings wipes it.
- She knows the time of day and how long it's been since you last talked.

## Make her yours

**Personality**: edit `personas/mia.json` or add more files next to it (a character picker
appears in Settings once there are several):

| Field | Meaning |
|---|---|
| `name`, `age` | Who she is. `age` must be 18 or more for adult mode. |
| `description`, `personality`, `scenario` | Free text. `{{user}}` and `{{char}}` are replaced with your names. |
| `greeting` | What she says the very first time you call. |
| `voice` | Optional TTS voice for this persona (e.g. Kokoro's `af_bella`). |
| `avatar` | Optional `.vrm` file name in `models/`. |

**Looks**: drop any `.vrm` onto the video (it's saved to `models/`). Make your own for free
in [VRoid Studio](https://vroid.com/en/studio), or pick one on
[VRoid Hub](https://hub.vroid.com/en) that allows your intended use.

**Voice**: set `TTS_VOICE` (Kokoro has many, e.g. `af_heart`, `af_bella`, `bf_emma`). For
other languages, use a TTS voice that speaks them (e.g. Piper voices through Speaches) and
set `STT_LANGUAGE`. She replies in whatever language you speak.

## Adult mode

Adult mode is off by default. You switch it on in Settings and confirm that you're 18 or
older. It only works for personas whose `age` is 18 or more, and her instructions then state
that you're both consenting adults and that minors are never sexualized.

The app itself doesn't write anything explicit. That comes from your model, and many
mainstream instruct models refuse. Community fine-tunes made for unrestricted role-play are
published on Hugging Face; check each model's license and acceptable-use policy.

Please keep the avatar a fictional character. Using a real person's likeness for sexual
content without their consent is harmful and illegal in many places.

## Privacy

With local servers configured, nothing leaves your computer. Two exceptions to know about:

- Without `STT_BASE_URL`, speech recognition uses the browser's service. Chrome sends that
  audio to Google.
- Browser voices marked as online voices (e.g. Chrome's "Google …" voices) are also cloud-based.

The server only listens on `127.0.0.1` by default and rejects requests from other websites.

## Phone and other devices

Browsers allow the camera and microphone only on `https://` or `localhost`. The easiest way
to call her from your phone is [Tailscale](https://tailscale.com): run
`tailscale serve 8787` on the computer, then add the `*.ts.net` host name it prints to
`ALLOWED_HOSTS` in `.env`. There is no login, so don't expose the port to the internet.

## Hardware and speed

- A 7–12B model quantized to 4 bits needs roughly 6–10 GB of GPU memory. It also runs on
  a CPU, but slower. Smaller models answer faster.
- Kokoro speaks in real time on a CPU. Whisper `small` takes a second or two per sentence on a
  CPU and is near-instant on a GPU.
- Ollama's default context window can be small. Start it with `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`
  so she can keep the whole recent conversation in mind.

## Not included (yet)

- **Photoreal video.** Talking-head models such as LivePortrait or MuseTalk can animate a
  portrait from audio, near real time on a strong GPU. They aren't wired in here. If you
  add one, use a generated, fictional face.
- **Talking over her.** Listening pauses while she speaks so she doesn't hear herself.
  Interrupt with Space instead.
- **Gestures.** VRM animation files (`.vrma`) could add hand and body motion.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Can't reach the chat model server" | Start Ollama (or your server) and check `LLM_BASE_URL` / `LLM_MODEL`. |
| She doesn't react to your voice | The ring around the mic button should pulse when you talk. If it does, check that the Speaches container is running and the model was downloaded. |
| Robotic voice and a "Voice server problem" note | The TTS server isn't reachable, so she fell back to the browser voice. |
| Blank page | Run `npm install` in `companion/`. |
| Her expression never changes | Small models forget the mood tags. Try a larger model or a lower `LLM_TEMPERATURE`. |

## Files

```
server.js            web server + bridge to the model servers (no dependencies)
personas/*.json      characters
public/js/main.js    call screen: camera, mic, turn-taking, settings
public/js/avatar.js  VRM rendering, expressions, blinking, lip sync
public/js/speaker.js sentence-by-sentence speech playback + lip-sync signal
public/js/listener.js voice activity detection, WAV encoding, browser fallback
public/js/chat.js    reply streaming, mood tags, sentence splitting
data/                memory, history, settings (created on first run, git-ignored)
models/              your .vrm avatars (git-ignored)
```
