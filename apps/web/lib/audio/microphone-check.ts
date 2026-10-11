export type MicrophoneWarning = "SIGNAL_TOO_LOW" | "CLIPPING" | "BACKGROUND_NOISE";

export type MicrophoneCheck = {
  ok: boolean;
  rmsDb: number;
  peakDb: number;
  warnings: MicrophoneWarning[];
};

const LOW_SIGNAL_DBFS = -45;
const CLIPPING_DBFS = -0.5;
const CLIPPING_FRACTION = 0.001;
const BACKGROUND_NOISE_DBFS = -35;
const FLOAT32_DB_TOLERANCE = 0.000_01;

export function inspectMicrophone(samples: Float32Array, sampleRate: number): MicrophoneCheck {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("A positive sample rate is required");
  }

  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let noiseSumSquares = 0;
  const noiseSampleCount = Math.min(samples.length, Math.floor(sampleRate));
  const clippingAmplitude = 10 ** (CLIPPING_DBFS / 20);

  for (let index = 0; index < samples.length; index += 1) {
    const amplitude = Math.abs(samples[index]!);
    sumSquares += amplitude * amplitude;
    peak = Math.max(peak, amplitude);
    if (amplitude > clippingAmplitude) clipped += 1;
    if (index < noiseSampleCount) noiseSumSquares += amplitude * amplitude;
  }

  const rmsDb = amplitudeToDb(samples.length ? Math.sqrt(sumSquares / samples.length) : 0);
  const peakDb = amplitudeToDb(peak);
  const noiseFloorDb = amplitudeToDb(noiseSampleCount ? Math.sqrt(noiseSumSquares / noiseSampleCount) : 0);
  const warnings: MicrophoneWarning[] = [];
  if (rmsDb < LOW_SIGNAL_DBFS - FLOAT32_DB_TOLERANCE) warnings.push("SIGNAL_TOO_LOW");
  if (samples.length > 0 && clipped / samples.length > CLIPPING_FRACTION) warnings.push("CLIPPING");
  if (noiseFloorDb > BACKGROUND_NOISE_DBFS + FLOAT32_DB_TOLERANCE) warnings.push("BACKGROUND_NOISE");
  return { ok: true, rmsDb, peakDb, warnings };
}

function amplitudeToDb(amplitude: number): number {
  return amplitude === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(amplitude);
}

export async function checkMicrophoneStream(stream: MediaStream): Promise<MicrophoneCheck> {
  const context = new AudioContext();
  const moduleSource = `
    class DramaMicrophoneSampler extends AudioWorkletProcessor {
      process(inputs) {
        const samples = inputs[0] && inputs[0][0];
        if (samples) this.port.postMessage(samples.slice());
        return true;
      }
    }
    registerProcessor("drama-microphone-sampler", DramaMicrophoneSampler);
  `;
  const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
  let source: MediaStreamAudioSourceNode | undefined;
  let sampler: AudioWorkletNode | undefined;
  let silentOutput: GainNode | undefined;
  try {
    await context.audioWorklet.addModule(moduleUrl);
    source = context.createMediaStreamSource(stream);
    sampler = new AudioWorkletNode(context, "drama-microphone-sampler");
    silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    source.connect(sampler).connect(silentOutput).connect(context.destination);
    const requiredSamples = Math.round(context.sampleRate * 3);
    const samples = await collectSamples(sampler.port, requiredSamples);
    return inspectMicrophone(samples, context.sampleRate);
  } finally {
    source?.disconnect();
    sampler?.disconnect();
    silentOutput?.disconnect();
    URL.revokeObjectURL(moduleUrl);
    await context.close();
  }
}

function collectSamples(port: MessagePort, requiredSamples: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Float32Array[] = [];
    let length = 0;
    const timeout = setTimeout(() => reject(new Error("Microphone check timed out")), 4_000);
    port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      const chunk = new Float32Array(data);
      chunks.push(chunk);
      length += chunk.length;
      if (length < requiredSamples) return;
      clearTimeout(timeout);
      const combined = new Float32Array(requiredSamples);
      let offset = 0;
      for (const current of chunks) {
        combined.set(current.subarray(0, requiredSamples - offset), offset);
        offset += Math.min(current.length, requiredSamples - offset);
        if (offset === requiredSamples) break;
      }
      resolve(combined);
    };
  });
}
