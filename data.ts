/** Data-access helpers: ownership-checked lookups and public DTOs (no internal paths leak). */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, projects, type Clip, type Project } from "@/db/schema";
import { HttpError, assertUuid } from "@/lib/api";

export async function getOwnedProject(userId: string, projectId: string): Promise<Project> {
  assertUuid(projectId, "project");
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "Project not found.");
  return row;
}

export async function getOwnedClip(userId: string, clipId: string): Promise<Clip> {
  assertUuid(clipId, "clip");
  const [row] = await db
    .select()
    .from(clips)
    .where(and(eq(clips.id, clipId), eq(clips.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "Clip not found.");
  return row;
}

export function projectDto(p: Project) {
  return {
    id: p.id,
    title: p.title,
    language: p.language,
    status: p.status,
    youtubeUrl: p.youtubeUrl,
    youtubeVideoId: p.youtubeVideoId,
    youtubeTitle: p.youtubeTitle,
    youtubeAuthor: p.youtubeAuthor,
    youtubeThumbnail: p.youtubeThumbnail,
    hasVideo: Boolean(p.videoPath),
    videoOriginalName: p.videoOriginalName,
    videoSizeBytes: p.videoSizeBytes,
    hasSubtitles: Boolean(p.subtitlePath),
    subtitleOriginalName: p.subtitleOriginalName,
    durationSec: p.durationSec,
    width: p.width,
    height: p.height,
    transcriptSource: p.transcriptSource,
    analysisEngine: p.analysisEngine,
    sceneCount: p.sceneChanges.length,
    errorMessage: p.errorMessage,
    rightsConfirmedAt: p.rightsConfirmedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function clipDto(c: Clip) {
  const { exportKey: _omit, ...rest } = c;
  return { ...rest, hasExport: c.exportStatus === "ready" };
}
