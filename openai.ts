/**
 * Thin OpenAI client (fetch-based, no SDK). Used only when OPENAI_API_KEY is configured:
 * - Whisper transcription with segment timestamps
 * - JSON-mode chat completions for moment analysis and copywriting
 */
import fs from "fs";
import type { Segment } from "@/lib/media/subtitles";

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

export function aiEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  return key;
}

export async function transcribeAudio(mp3Path: string, language: string): Promise<Segment[]> {
  const size = fs.statSync(mp3Path).size;
  if (size > 24 * 1024 * 1024) {
    throw new Error("Audio is too large for automatic transcription. Upload an SRT/VTT transcript instead.");
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(mp3Path)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("language", language === "hi" ? "hi" : "en");

  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { segments?: Array<{ start: number; end: number; text: string }> };
  return (data.segments ?? [])
    .map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }))
    .filter((s) => s.text && s.endSec > s.startSec);
}

export async function chatJSON<T>(system: string, user: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned an empty response.");
  return JSON.parse(content) as T;
}
