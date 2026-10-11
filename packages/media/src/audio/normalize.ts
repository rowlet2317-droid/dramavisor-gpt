import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AudioProcessRequest = { command: string; args: string[]; input: Uint8Array };

export interface AudioProcess {
  run(request: AudioProcessRequest): Promise<Uint8Array>;
}

export class AudioNormalizationError extends Error {
  readonly code = "AUDIO_NORMALIZATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "AudioNormalizationError";
  }
}

export async function normalizeAudio(
  input: Uint8Array,
  process: AudioProcess = new FfmpegAudioProcess(),
): Promise<Uint8Array> {
  return process.run({
    command: "ffmpeg",
    input,
    args: [
      "-hide_banner", "-loglevel", "error", "-y", "-i", "{input}", "-map_metadata", "-1", "-vn",
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "{output}",
    ],
  });
}

export class FfmpegAudioProcess implements AudioProcess {
  async run(request: AudioProcessRequest): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), "drama-audio-"));
    const inputPath = join(directory, "input");
    const outputPath = join(directory, "normalized.wav");
    try {
      await writeFile(inputPath, request.input);
      const args = request.args.map((argument) => argument === "{input}"
        ? inputPath
        : argument === "{output}" ? outputPath : argument);
      await runProcess(request.command, args);
      return new Uint8Array(await readFile(outputPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => reject(new AudioNormalizationError(error.message)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new AudioNormalizationError(Buffer.concat(stderr).toString("utf8").trim()
        || `FFmpeg exited with code ${code ?? "unknown"}`));
    });
  });
}
