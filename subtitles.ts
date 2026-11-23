/**
 * Subtitle utilities: parse SRT/VTT transcripts, split into readable caption lines,
 * and generate styled ASS subtitles for FFmpeg burn-in (9:16 PlayRes 1080x1920).
 */
import { randomUUID } from "crypto";
import type { SubtitleLine, SubtitleStyle } from "@/db/schema";

export type Segment = { startSec: number; endSec: number; text: string };

function toSeconds(ts: string): number {
  const parts = ts.replace(",", ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

export function cleanCaptionText(raw: string) {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses SubRip (.srt) or WebVTT (.vtt). Collapses rolling duplicate captions. */
export function parseSubtitleFile(content: string): Segment[] {
  const normalized = content.replace(/\r/g, "").replace(/^\uFEFF/, "");
  const blocks = normalized.split(/\n\s*\n/);
  const segments: Segment[] = [];
  const timeRe = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const m = lines[idx].match(timeRe);
    if (!m) continue;
    const text = cleanCaptionText(lines.slice(idx + 1).join(" "));
    if (!text) continue;
    const startSec = toSeconds(m[1]);
    const endSec = toSeconds(m[2]);
    if (!(endSec > startSec)) continue;
    const prev = segments[segments.length - 1];
    if (prev && prev.text === text) {
      prev.endSec = Math.max(prev.endSec, endSec);
      continue;
    }
    segments.push({ startSec, endSec, text });
  }
  return segments;
}

/** Splits long segments into caption-sized pieces with time distributed by character count. */
export function splitLongSegments(segments: Segment[], maxChars = 58): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.text.length <= maxChars) {
      out.push(seg);
      continue;
    }
    const words = seg.text.split(" ");
    const chunks: string[] = [];
    let current = "";
    for (const w of words) {
      if ((current + " " + w).trim().length > maxChars && current) {
        chunks.push(current);
        current = w;
      } else current = (current + " " + w).trim();
    }
    if (current) chunks.push(current);
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = seg.startSec;
    const span = seg.endSec - seg.startSec;
    for (const c of chunks) {
      const d = (span * c.length) / total;
      out.push({ startSec: t, endSec: t + d, text: c });
      t += d;
    }
  }
  return out;
}

/** Converts transcript segments into editable subtitle lines within a clip window (absolute seconds). */
export function segmentsToSubtitles(segments: Segment[], start: number, end: number): SubtitleLine[] {
  const inWindow = segments
    .filter((s) => s.endSec > start && s.startSec < end)
    .map((s) => ({
      startSec: Math.max(start, s.startSec),
      endSec: Math.min(end, s.endSec),
      text: s.text,
    }));
  return splitLongSegments(inWindow).map((s) => ({
    id: randomUUID(),
    start: Math.round(s.startSec * 100) / 100,
    end: Math.round(s.endSec * 100) / 100,
    text: s.text,
  }));
}

function assTime(sec: number) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** "#RRGGBB" -> ASS "&HAABBGGRR&" */
function assColor(hex: string, alpha = "00") {
  const clean = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace("#", "") : "FFFFFF";
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  return `&H${alpha}${bb}${gg}${rr}`.toUpperCase();
}

/** Builds an ASS file for a clip. Subtitle times are absolute; they are rebased to clip start. */
export function buildAss(lines: SubtitleLine[], style: SubtitleStyle, clipStart: number, clipEnd: number) {
  const duration = clipEnd - clipStart;
  const size = Math.round(40 + (Math.min(10, Math.max(1, style.fontSize)) - 1) * 9);
  const align = style.position === "top" ? 8 : style.position === "middle" ? 5 : 2;
  const marginV = style.position === "top" ? 240 : style.position === "middle" ? 0 : 280;
  const borderStyle = style.highlight ? 3 : 1;
  const primary = assColor(style.textColor);
  const outline = style.highlight ? assColor(style.outlineColor, "40") : assColor(style.outlineColor);
  const fontName = style.font.replace(/[,{}]/g, "");

  const events = lines
    .map((line) => {
      const s = Math.max(0, line.start - clipStart);
      const e = Math.min(duration, line.end - clipStart);
      if (e <= s + 0.05) return null;
      const text = line.text.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
      return `Dialogue: 0,${assTime(s)},${assTime(e)},Default,,0,0,0,,${text}`;
    })
    .filter(Boolean)
    .join("\n");

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${size},${primary},&H000000FF&,${outline},&H66000000&,-1,0,0,0,100,100,0,0,${borderStyle},${style.highlight ? 14 : 5},0,${align},70,70,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}
