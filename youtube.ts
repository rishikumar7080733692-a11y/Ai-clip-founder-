/**
 * YouTube helpers using only official, public endpoints:
 * - URL parsing for the video id
 * - oEmbed (https://www.youtube.com/oembed) for title / author / thumbnail
 * Media is never downloaded from YouTube; the owner uploads their own copy for processing.
 */
import { HttpError } from "@/lib/api";

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseYoutubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      id = m ? m[2] : null;
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

export type YoutubeMeta = {
  videoId: string;
  canonicalUrl: string;
  title: string;
  author: string;
  thumbnail: string;
};

export async function fetchYoutubeMeta(input: string): Promise<YoutubeMeta> {
  const videoId = parseYoutubeId(input);
  if (!videoId) throw new HttpError(400, "Enter a valid YouTube video URL (youtube.com/watch, youtu.be, or /shorts).");
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) },
  ).catch(() => null);
  if (!res || !res.ok) {
    throw new HttpError(422, "We could not verify this YouTube video. It may be private, deleted, or the link is incorrect.");
  }
  const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return {
    videoId,
    canonicalUrl,
    title: data.title ?? "Untitled video",
    author: data.author_name ?? "Unknown channel",
    thumbnail: data.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}
