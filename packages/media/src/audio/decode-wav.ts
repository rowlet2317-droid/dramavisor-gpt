export type DecodedWav = { samples: Float32Array; sampleRate: number; channels: 1; bitsPerSample: 16 };

export class WavDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavDecodeError";
  }
}

/** Decodes the normalized mono, 16-bit PCM WAV representation used by take processing. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new WavDecodeError("Expected a RIFF/WAVE container");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) {
    throw new WavDecodeError("RIFF container is truncated or has trailing bytes");
  }

  let offset = 12;
  let sampleRate: number | undefined;
  let dataStart: number | undefined;
  let dataSize: number | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new WavDecodeError("WAV chunk header is truncated");
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length || end + (size % 2) > bytes.length) {
      throw new WavDecodeError("WAV chunk is truncated");
    }
    if (id === "fmt ") {
      if (sampleRate !== undefined || size < 16) throw new WavDecodeError("Invalid WAV format chunk");
      const format = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true);
      const blockAlign = view.getUint16(start + 12, true);
      const bitsPerSample = view.getUint16(start + 14, true);
      if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate || blockAlign !== 2
        || byteRate !== sampleRate * blockAlign) {
        throw new WavDecodeError("Expected mono 16-bit PCM WAV");
      }
    } else if (id === "data") {
      if (dataStart !== undefined || size % 2 !== 0) throw new WavDecodeError("Invalid WAV data chunk");
      dataStart = start;
      dataSize = size;
    }
    offset = end + (size % 2);
  }
  if (offset !== bytes.length || sampleRate === undefined || dataStart === undefined || dataSize === undefined) {
    throw new WavDecodeError("WAV is missing required PCM data");
  }

  const samples = new Float32Array(dataSize / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(dataStart + index * 2, true) / 32_768;
  }
  return { samples, sampleRate, channels: 1, bitsPerSample: 16 };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
