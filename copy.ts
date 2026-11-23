/**
 * Template copywriting engine (no AI key required). Writes titles, hooks, captions, hashtags,
 * Shorts descriptions and thumbnail text from the clip's real transcript, in English or Hindi.
 * When an AI engine is configured, ai-analysis.ts produces richer copy instead.
 */
import { wordsOf } from "./engine";

export type ClipCopy = {
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  shortsDescription: string;
  thumbnailText: string;
};

const STOP_EN = new Set(
  "the and that this with for you your are but not have was they them what when just like from about there their will would could going really know think gonna yeah okay right because into been were also some more very much then than here make made time".split(" "),
);
const STOP_HI = new Set("के की का है में और को से एक यह वह ये हैं तो भी पर लिए कि जो हम आप मैं था थी थे हो होता करना कर गया गई".split(" "));

const CTA = {
  en: "Watch till the end and save this for later 👇",
  hi: "पूरा क्लिप देखें और इसे बाद के लिए सेव करें 👇",
};

export function truncate(s: string, max: number) {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

export function topKeywords(text: string, language: "en" | "hi", n = 4): string[] {
  const freq = new Map<string, number>();
  for (const w of wordsOf(text)) {
    if (/\d/.test(w)) continue;
    const minLen = language === "hi" ? 2 : 4;
    if (w.length < minLen) continue;
    if (STOP_EN.has(w) || STOP_HI.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([w]) => w);
}

export function templateCopy(text: string, language: "en" | "hi"): ClipCopy {
  const sentences = text
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hookSentence = sentences[0] ?? text.trim();
  const keywords = topKeywords(text, language, 4);
  // Title: the sentence that carries the most keyword weight
  const best =
    sentences.reduce((b, s) => {
      const weight = (x: string) => topKeywords(x, language, 10).filter((k) => keywords.includes(k)).length;
      return weight(s) > weight(b) ? s : b;
    }, hookSentence) || hookSentence;

  const title = truncate(best.replace(/[.!?।]+$/, ""), 64);
  const hook = truncate(hookSentence, 96);
  const caption = truncate(
    `${hook}${best !== hookSentence ? " " + truncate(best, 120) : ""}\n\n${CTA[language]}`,
    260,
  );
  const hashtags =
    language === "hi"
      ? ["#शॉर्ट्स", "#वायरल", ...keywords.map((k) => `#${k}`)].slice(0, 6)
      : [...keywords.map((k) => `#${k}`), "#shorts", "#viral"].slice(0, 6);
  const shortsDescription = truncate(
    language === "hi"
      ? `${truncate(text, 150)} | अपने वीडियो से बनाया गया क्लिप। #Shorts`
      : `${truncate(text, 150)} | Clip from a video I own. #Shorts`,
    240,
  );
  const thumbnailText = truncate(
    (language === "en" ? hookSentence.toUpperCase() : hookSentence).split(" ").slice(0, 4).join(" "),
    28,
  );
  return { title, hook, caption, hashtags, shortsDescription, thumbnailText };
}
