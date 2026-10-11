const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const SUPPORTED_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx",
  "sage", "shimmer", "verse", "marin", "cedar"]);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_NO_PROGRESS_READS = 1_024;
// A full 16 MiB response may arrive in 256-byte chunks; cap smaller-chunk object/read work here.
const MAX_AUDIO_CHUNKS = 65_536;

type Options = { apiKey: string; model?: string; fetch?: typeof fetch };
type SynthesisInput = { exactText: string; voice: string; signal?: AbortSignal };

export class OpenAiTtsSynthesizer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetch: typeof fetch;

  constructor(options: Options) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || "gpt-4o-mini-tts";
    this.fetch = options.fetch ?? globalThis.fetch;
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required");
  }

  async synthesize(input: SynthesisInput): Promise<{ bytes: Uint8Array; mediaType: "audio/mpeg" }> {
    if (!SUPPORTED_VOICES.has(input.voice)) throw new Error("Configured TTS voice is unsupported");
    if (!input.exactText || input.exactText.length > 4_096) throw new Error("Configured TTS text is invalid");
    let response: Response;
    try {
      response = await this.fetch(OPENAI_SPEECH_URL, { method: "POST", headers: {
        authorization: `Bearer ${this.apiKey}`, "content-type": "application/json",
      }, body: JSON.stringify({ model: this.model, input: input.exactText, voice: input.voice,
        response_format: "mp3" }), signal: input.signal });
    } catch {
      throw new Error("Configured TTS provider request failed");
    }
    if (!response.ok) throw new Error("Configured TTS provider request failed");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "audio/mpeg") {
      await cancelBody(response.body);
      throw invalidAudioError();
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength.trim())
      || Number(declaredLength) > MAX_AUDIO_BYTES)) {
      await cancelBody(response.body);
      throw invalidAudioError();
    }
    const bytes = await readBoundedAudio(response.body);
    return { bytes, mediaType: "audio/mpeg" };
  }
}

async function readBoundedAudio(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) throw invalidAudioError();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let noProgressReads = 0;
  let chunkReads = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkReads += 1;
      if (chunkReads > MAX_AUDIO_CHUNKS) throw invalidAudioError();
      if (value.byteLength === 0) {
        noProgressReads += 1;
        if (noProgressReads > MAX_NO_PROGRESS_READS) throw invalidAudioError();
        continue;
      }
      noProgressReads = 0;
      if (value.byteLength > MAX_AUDIO_BYTES - byteLength) throw invalidAudioError();
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } catch {
    try { await reader.cancel(); } catch { /* keep provider failures private */ }
    throw invalidAudioError();
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) throw invalidAudioError();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function invalidAudioError(): Error {
  return new Error("Configured TTS provider returned invalid audio");
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try { await body?.cancel(); } catch { /* keep provider failures private */ }
}
