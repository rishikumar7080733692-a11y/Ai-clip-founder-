/**
 * Heuristic moment-detection engine (works fully offline, no AI keys required).
 *
 * Builds candidate windows from transcript segments, snaps boundaries to visual scene cuts,
 * and scores each window on five transparent criteria (0-100 each).
 *
 *   Engagement score = 0.30*Hook + 0.20*Emotion + 0.20*Insight + 0.15*Pacing + 0.15*Completeness
 *
 * The score measures clip-quality signals in the transcript. It is NOT a prediction of virality.
 */
import type { ScoreBreakdown } from "@/db/schema";
import type { Segment } from "@/lib/media/subtitles";
import type { ClipCopy } from "./copy";

export const WEIGHTS = { hook: 0.3, emotion: 0.2, insight: 0.2, pacing: 0.15, completeness: 0.15 } as const;

export type Criteria = { hook: number; emotion: number; insight: number; pacing: number; completeness: number };

export type Candidate = {
  startSec: number;
  endSec: number;
  category: string;
  scores: Criteria;
  score: number;
  breakdown: ScoreBreakdown;
  reasons: string[];
  transcriptText: string;
  copy?: ClipCopy; // present when an AI engine wrote the copy
};

export const HOOK_RE =
  /\b(never|secret|truth|mistake|biggest|shocking|nobody|wrong|warning|hidden|surprising|crazy|insane|worst|best|actually|stop|don'?t)\b|नहीं|सच|गलती|राज़|सबसे|कोई नहीं/i;
export const QUESTION_RE = /\b(why|how|what|did you know|have you|can you|is it)\b|\?|क्यों|कैसे|क्या/i;
const EMOTION_RE =
  /\b(love|hate|amazing|incredible|scared|afraid|cry|crying|tears|happy|sad|angry|proud|wow|omg|unbelievable|heartbreaking|fear|excited|funny|joke|hilarious)\b|प्यार|डर|खुश|दुख|हंस|हँस|मज़ेदार|कमाल|अद्भुत|गुस्सा/gi;
export const LAUGH_RE = /\[(laughs?|laughter|applause|gasps?|cheers)\]|\((laughs?|laughter|applause|gasps?)\)|\bhaha+\b|\blol\b|😂|🤣|हा हा|हहह/i;
const INSIGHT_RE =
  /\b(fact|study|research|data|because|reason|actually|turns out|tip|step|lesson|rule|method|example|proof|money|percent|learn|mistake)\b|तथ्य|वजह|क्योंकि|तरीका|सीख|नियम|उदाहरण/gi;

export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

const clamp = (n: number) => Math.round(Math.max(0, Math.min(100, n)));

export function computeScore(scores: Criteria) {
  const s = {
    hook: clamp(scores.hook),
    emotion: clamp(scores.emotion),
    insight: clamp(scores.insight),
    pacing: clamp(scores.pacing),
    completeness: clamp(scores.completeness),
  };
  const total =
    s.hook * WEIGHTS.hook +
    s.emotion * WEIGHTS.emotion +
    s.insight * WEIGHTS.insight +
    s.pacing * WEIGHTS.pacing +
    s.completeness * WEIGHTS.completeness;
  return {
    score: clamp(total),
    scores: s,
    breakdown: { ...s, weights: { ...WEIGHTS } } as ScoreBreakdown,
  };
}

function nearestCut(cuts: number[], from: number, to: number, target: number): number | null {
  let best: number | null = null;
  for (const c of cuts) {
    if (c < from || c > to) continue;
    if (best === null || Math.abs(c - target) < Math.abs(best - target)) best = c;
  }
  return best;
}

function scoreWindow(segs: Segment[], start: number, end: number, gapBefore: number, cuts: number[]) {
  const text = segs.map((s) => s.text).join(" ");
  const dur = end - start;
  const words = wordsOf(text);
  const wc = Math.max(1, words.length);
  const wps = wc / dur;

  // Pacing: ideal 2.0 - 3.5 words per second
  const pacing = wps >= 2 && wps <= 3.5 ? 100 : wps < 2 ? 100 - (2 - wps) * 45 : 100 - (wps - 3.5) * 35;

  // Hook: what happens in the first ~3 seconds
  const open = segs
    .filter((s) => s.startSec < start + 3)
    .map((s) => s.text)
    .join(" ");
  const firstSentence = (open.split(/(?<=[.!?।])\s+/)[0] ?? "").trim();
  const openCuts = cuts.some((c) => c >= start - 0.2 && c <= start + 2);
  let hook = 20;
  const hookSignals: string[] = [];
  if (QUESTION_RE.test(open)) { hook += 25; hookSignals.push("question"); }
  if (HOOK_RE.test(open)) { hook += 25; hookSignals.push("bold claim"); }
  if (/\d/.test(open)) { hook += 15; hookSignals.push("specific number"); }
  if (/[!！]/.test(open)) hook += 10;
  if (wordsOf(firstSentence).length > 0 && wordsOf(firstSentence).length <= 12) hook += 10;
  if (openCuts) hook += 10;

  // Emotion: emotional vocabulary, laughter/reaction markers, exclamations
  const emoCount = (text.match(EMOTION_RE) ?? []).length;
  const laughCount = segs.filter((s) => LAUGH_RE.test(s.text)).length;
  const exclam = (text.match(/[!！]/g) ?? []).length;
  const emotion = 15 + 14 * Math.min(emoCount, 4) + 16 * Math.min(laughCount, 2) + 6 * Math.min(exclam, 3);

  // Insight: facts, reasons, figures, novelty (unique word ratio)
  const insightHits = (text.match(INSIGHT_RE) ?? []).length;
  const numbers = (text.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
  const uniqueRatio = new Set(words).size / wc;
  const insight = 20 + 14 * Math.min(insightHits, 4) + 10 * Math.min(numbers, 3) + 20 * uniqueRatio;

  // Completeness: clean ending, length in the sweet spot, natural pause before start
  const endsClean = /[.!?।]["'”)]?$/.test(text.trim());
  const lengthPts = dur >= 20 && dur <= 45 ? 40 : dur >= 12 && dur <= 60 ? 20 : 0;
  const completeness = (endsClean ? 40 : 0) + lengthPts + (gapBefore >= 0.6 ? 20 : 10);

  const { score, scores, breakdown } = computeScore({
    hook,
    emotion,
    insight,
    pacing,
    completeness,
  });

  const reasons: string[] = [];
  if (scores.hook >= 70) reasons.push(`Strong opening: ${hookSignals.join(" + ") || "attention-grabbing first 3 seconds"}`);
  else if (scores.hook >= 50) reasons.push("Moderate opening hook");
  if (scores.emotion >= 60)
    reasons.push(`Emotional intensity: ${emoCount} emotional cue(s)${laughCount ? ", laughter/reaction marker" : ""}`);
  if (scores.insight >= 60) reasons.push(`Information density: ${insightHits} insight cue(s), ${numbers} figure(s)`);
  if (scores.pacing >= 80) reasons.push(`Paced at ${wps.toFixed(1)} words/sec (ideal 2–3.5)`);
  if (scores.completeness >= 80) reasons.push("Ends on a complete sentence within a 20–45s length");
  if (reasons.length === 0) reasons.push("Usable segment with moderate signals on all criteria");

  let category = "insight";
  if (laughCount > 0) category = "joke";
  else if (exclam >= 2 && emotion >= 50) category = "reaction";
  else if (scores.emotion >= 65) category = "emotional";
  else if (insightHits + numbers >= 2 && scores.insight >= 60) category = "fact";
  else if (scores.hook >= 70) category = "hook";

  return { score, scores, breakdown, reasons, category, text };
}

/** Builds candidate windows (12-60 s) from transcript segments. */
export function buildCandidates(segments: Segment[], sceneCuts: number[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < segments.length; i++) {
    const gapBefore = i === 0 ? 1 : segments[i].startSec - segments[i - 1].endSec;
    for (let j = i; j < segments.length; j++) {
      if (segments[j].endSec - segments[i].startSec > 60) break;
      let start = segments[i].startSec;
      let end = segments[j].endSec;
      // Snap boundaries to visual scene cuts when one is close enough
      const startCut = nearestCut(sceneCuts, start - 1, start + 0.3, start);
      if (startCut !== null) start = startCut;
      const endCut = nearestCut(sceneCuts, end - 0.5, end + 0.6, end);
      if (endCut !== null) end = endCut;
      const dur = end - start;
      if (dur < 12 || dur > 62) continue;
      const segs = segments.slice(i, j + 1);
      const r = scoreWindow(segs, start, end, gapBefore, sceneCuts);
      out.push({
        startSec: round2(start),
        endSec: round2(end),
        category: r.category,
        scores: r.scores,
        score: r.score,
        breakdown: r.breakdown,
        reasons: r.reasons,
        transcriptText: r.text,
      });
    }
  }
  return out;
}

export function targetClipCount(durationSec: number) {
  return Math.min(10, Math.max(5, Math.round(durationSec / 180)));
}

/** Greedy non-maximum suppression: keeps high-scoring, mostly non-overlapping clips. */
export function selectClips(candidates: Candidate[], target: number, minScore = 30): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  for (const c of sorted) {
    if (picked.length >= target) break;
    if (c.score < minScore) continue;
    const overlaps = picked.some((p) => {
      const ov = Math.max(0, Math.min(p.endSec, c.endSec) - Math.max(p.startSec, c.startSec));
      const minDur = Math.min(p.endSec - p.startSec, c.endSec - c.startSec);
      return minDur > 0 && ov / minDur > 0.2;
    });
    if (!overlaps) picked.push(c);
  }
  return picked.sort((a, b) => a.startSec - b.startSec);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
