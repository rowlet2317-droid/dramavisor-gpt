import { extractDocxText } from "./docx";
import { validatePdf } from "./pdf-validation";
import { decodeTextFile, prepareScriptText } from "./text";

export type ScriptFileInput = {
  kind: "file";
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

export async function validateScriptFile(input: ScriptFileInput): Promise<string> {
  if (input.contentType === "text/plain") {
    return decodeTextFile(input.bytes);
  }
  if (input.contentType === "application/pdf") {
    return validatePdf(input.bytes);
  }
  if (input.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return prepareScriptText(await extractDocxText(input.bytes));
  }
  throw new Error(`Unsupported script type: ${input.contentType}`);
}
