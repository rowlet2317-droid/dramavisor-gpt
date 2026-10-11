import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { normalizeAudio, type AudioProcess } from "./normalize";

describe("normalizeAudio", () => {
  it("uses FFmpeg arguments that produce mono 16 kHz signed 16-bit PCM WAV", async () => {
    // Break caught: omitting an explicit channel/rate/codec flag would leave provider input format-dependent.
    const calls: Array<{ command: string; args: string[]; input: Uint8Array }> = [];
    const expected = Uint8Array.of(82, 73, 70, 70);
    const process: AudioProcess = {
      run: async (request) => {
        calls.push({ ...request, input: request.input.slice() });
        return expected;
      },
    };

    const result = await normalizeAudio(Uint8Array.of(1, 2, 3), process);

    expect(result).toEqual(expected);
    expect(calls).toEqual([{
      command: "ffmpeg",
      input: Uint8Array.of(1, 2, 3),
      args: [
        "-hide_banner", "-loglevel", "error", "-y", "-i", "{input}", "-map_metadata", "-1", "-vn",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "{output}",
      ],
    }]);
  });

  it("normalizes the generated synthetic fixture with the installed FFmpeg", async () => {
    // Break caught: arguments accepted by a fake boundary can still fail against the supported FFmpeg CLI contract.
    const fixture = new Uint8Array(await readFile(new URL("../../../../fixtures/audio/alex-scene-clean.wav",
      import.meta.url)));

    const result = await normalizeAudio(fixture);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

    expect(String.fromCharCode(...result.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
  });
});
