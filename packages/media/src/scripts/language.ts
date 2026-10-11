import { franc } from "franc-min";

export function isNonEnglishScript(text: string): boolean {
  if (/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}\p{Symbol}\s]/u.test(text)) {
    return true;
  }
  const letters = text.match(/\p{Letter}/gu) ?? [];
  if (letters.length < 40) return false;
  // Dialogue and older dramatic English are frequently misclassified by franc.
  // Require rejection only when the text also lacks common English function words.
  const englishWords = text.match(/\b(?:the|and|that|this|with|you|your|have|not|for|but|are|what|will|all|from)\b/gi) ?? [];
  const words = text.match(/\b\p{Letter}+\b/gu) ?? [];
  if (englishWords.length >= 8 && englishWords.length / words.length >= 0.015) return false;
  const language = franc(text, {
    minLength: 20,
    only: ["eng", "fra", "deu", "ita", "spa", "por", "nld"],
  });
  return language !== "und" && language !== "eng";
}
