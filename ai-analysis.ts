/**
 * AI engine (active only with OPENAI_API_KEY). The transcript is sent in timestamped chunks;
 * the model returns candidate moments with per-criterion scores and copy. Times are validated
 * against the real transcript bounds, and scores are recomputed with the same transparent formula.
 */
import { chatJSON } from "@/lib/ai/openai";
import type { Segment } from "@/lib/media/subtitles";
import { computeScore, wordsOf, type Candidate, type Criteria } from "./engine";
import type { ClipCopy } from "./copy";

type AiClip = {
  startSec: number;
  endSec: number;
  category: string;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  shortsDescription: string;
  thumbnailText: string;
  scores: Partial<Criteria>;
  reasons: string[];
};

const CATEGORIES = ["hook", "joke", "reaction", "fact", "emotional", "insight"];
const CHUNK_CHARS = 24000;

const languageName = (lang: string) => (lang === "hi" ? "Hindi (write all copy in Devanagari)" : "English");

function clampNum(n: unknown, min: number, max: number, fallback: number) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

const SYSTEM_PROMPT = `You are an expert short-form video editor and social media strategist.
You receive a timestamped transcript of a video that the user owns or has permission to edit.
Find the most engaging self-contained moments that work as 15-60 second vertical Shorts:
strong opening hooks, jokes/punchlines, reactions, interesting facts, emotional moments.
Rules:
- Use ONLY timestamps that exist in the transcript. Start and end must align with spoken content.
- Every clip must make sense on its own; avoid moments that depend on missing context.
- Score each criterion 0-100 honestly with these meanings:
  hook = how strongly the first 3 seconds grab attention;
  emotion = emotional or humorous intensity;
  insight = novelty/value of facts, reasons, or lessons;
  pacing = how tight and well-paced the speech is;
  completeness = whether the moment has a clean beginning and ending.
- Do not promise virality. Write reasons that cite what is actually in the transcript.
Return JSON: {"clips":[{"startSec":number,"endSec":number,"category":"hook|joke|reaction|fact|emotional|insight",
"title":string,"hook":string,"caption":string,"hashtags":string[],"shortsDescription":string,
"thumbnailText":string,"scores":{"hook":n,"emotion":n,"insight":n,"pacing":n,"completeness":n},"reasons":[string]}]}
Titles under 65 characters. Thumbnail text at most 4 words. Hashtags without spaces, 4-6 items.`;

function chunkTranscript(segments: Segment[]) {
  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let size = 0;
  for (const s of segments) {
    const line = `[${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}] ${s.text}\n`;
    if (size + line.length > CHUNK_CHARS && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += line.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function analyzeWithAI(segments: Segment[], duration: number, language: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const chunk of chunkTranscript(segments)) {
    const transcript = chunk.map((s) => `[${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}] ${s.text}`).join("\n");
    const res = await chatJSON<{ clips?: AiClip[] }>(
      SYSTEM_PROMPT,
      `Video duration: ${duration.toFixed(1)}s. Copy language: ${languageName(language)}.\nTranscript:\n${transcript}`,
    );
    for (const raw of res.clips ?? []) {
      const start = clampNum(raw.startSec, 0, duration, 0);
      const end = clampNum(raw.endSec, 0, duration, 0);
      const dur = end - start;
      if (dur < 10 || dur > 90) continue;
      const text = segments
        .filter((s) => s.endSec > start && s.startSec < end)
        .map((s) => s.text)
        .join(" ");
      if (!wordsOf(text).length) continue; // reject moments that don't exist in the transcript
      const scores: Criteria = {
        hook: clampNum(raw.scores?.hook, 0, 100, 50),
        emotion: clampNum(raw.scores?.emotion, 0, 100, 50),
        insight: clampNum(raw.scores?.insight, 0, 100, 50),
        pacing: clampNum(raw.scores?.pacing, 0, 100, 50),
        completeness: clampNum(raw.scores?.completeness, 0, 100, 50),
      };
      const computed = computeScore(scores);
      const copy: ClipCopy = {
        title: String(raw.title ?? "").slice(0, 80) || "Untitled clip",
        hook: String(raw.hook ?? ""),
        caption: String(raw.caption ?? ""),
        hashtags: (Array.isArray(raw.hashtags) ? raw.hashtags : [])
          .map((h) => `#${String(h).replace(/^#/, "").replace(/\s+/g, "")}`)
          .slice(0, 8),
        shortsDescription: String(raw.shortsDescription ?? ""),
        thumbnailText: String(raw.thumbnailText ?? "").slice(0, 40),
      };
      candidates.push({
        startSec: Math.round(start * 100) / 100,
        endSec: Math.round(end * 100) / 100,
        category: CATEGORIES.includes(raw.category) ? raw.category : "insight",
        scores: computed.scores,
        score: computed.score,
        breakdown: computed.breakdown,
        reasons: (Array.isArray(raw.reasons) ? raw.reasons : []).map(String).slice(0, 5),
        transcriptText: text,
        copy,
      });
    }
  }
  return candidates;
}

export async function aiCopyForClip(transcriptText: string, language: string): Promise<ClipCopy> {
  const res = await chatJSON<Partial<ClipCopy>>(
    `You write viral-style YouTube Shorts copy for a clip from a video the user owns. Return JSON with keys:
title (under 65 chars, attention-grabbing), hook (short opening line), caption (2-3 short lines, ends with a call to action),
hashtags (array of 4-6 strings starting with #), shortsDescription (under 220 chars), thumbnailText (max 4 words).
Write in ${languageName(language)}. Do not invent facts that are not in the transcript. Do not promise virality.`,
    `Transcript of the clip:\n${transcriptText.slice(0, 4000)}`,
  );
  return {
    title: String(res.title ?? "").slice(0, 80),
    hook: String(res.hook ?? ""),
    caption: String(res.caption ?? ""),
    hashtags: (Array.isArray(res.hashtags) ? res.hashtags : []).map((h) => `#${String(h).replace(/^#/, "")}`).slice(0, 8),
    shortsDescription: String(res.shortsDescription ?? ""),
    thumbnailText: String(res.thumbnailText ?? "").slice(0, 40),
  };
}
