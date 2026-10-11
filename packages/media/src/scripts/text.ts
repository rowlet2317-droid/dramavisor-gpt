export function decodeTextFile(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  if (!text.trim() || text.includes("\0")) throw new Error("Invalid plain-text script");
  return prepareScriptText(text);
}

/** Removes publisher front matter when a reliable first-scene heading exists. */
export function prepareScriptText(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const numberedScene = /^\s*scene\s+(?:\d+|[ivxlcdm]+)\b.*$/i;
  const standaloneScene = /^\s*scene\s*[.:—-]?\s*$/i;
  let sceneIndex = lines.findIndex((line) => numberedScene.test(line));
  if (sceneIndex < 0) sceneIndex = lines.findIndex((line) => standaloneScene.test(line));
  if (sceneIndex < 0) return text.trim();

  const actHeading = /^\s*(?:(?:first|second|third|fourth|fifth)\s+act|act\s+(?:\d+|[ivxlcdm]+))\s*[.:—-]?\s*$/i;
  let start = sceneIndex;
  for (let index = sceneIndex - 1; index >= Math.max(0, sceneIndex - 8); index -= 1) {
    if (actHeading.test(lines[index]!)) {
      start = index;
      break;
    }
  }
  const scriptLines = lines.slice(start);
  const publisherFooter = /^\s*\**\s*(?:the\s+)?end of (?:this\s+|the\s+)?project gutenberg\b/i;
  const footerIndex = scriptLines.findIndex((line) => publisherFooter.test(line));
  return scriptLines.slice(0, footerIndex < 0 ? undefined : footerIndex).join("\n").trim();
}
