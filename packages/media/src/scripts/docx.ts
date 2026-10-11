import mammoth from "mammoth";

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value.trim();
}
