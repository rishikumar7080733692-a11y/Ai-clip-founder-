/**
 * Export pipeline: builds styled ASS captions from the clip's (edited) subtitle lines,
 * renders a 1080x1920 MP4 with FFmpeg (crop, captions, optional music bed), and stores it
 * in cloud (S3) or local storage.
 */
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, projects, type Job } from "@/db/schema";
import { buildAss } from "@/lib/media/subtitles";
import { probeMedia, renderVerticalClip } from "@/lib/media/ffmpeg";
import { absoluteLocalPath, saveExport, tmpDir } from "@/lib/storage";
import { reportProgress } from "./state";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");

export async function exportClip(job: Job) {
  if (!job.clipId) throw new Error("Export job has no clip");
  const clipId = job.clipId;
  const [row] = await db
    .select({ clip: clips, project: projects })
    .from(clips)
    .innerJoin(projects, eq(projects.id, clips.projectId))
    .where(eq(clips.id, clipId))
    .limit(1);
  if (!row) throw new Error("Clip not found");
  const { clip, project } = row;
  if (!project.videoPath) throw new Error("The source video is missing.");

  await db
    .update(clips)
    .set({ exportStatus: "rendering", exportError: null, updatedAt: new Date() })
    .where(eq(clips.id, clipId));

  const workDir = tmpDir(`export-${job.id}`);
  try {
    const sourcePath = absoluteLocalPath(project.videoPath);
    const probe = await probeMedia(sourcePath);

    await reportProgress(job.id, "Preparing captions", 5, `${clip.subtitles.length} subtitle line(s), ${clip.style.font}`);
    fs.writeFileSync(path.join(workDir, "captions.ass"), buildAss(clip.subtitles, clip.style, clip.startSec, clip.endSec), "utf8");

    await reportProgress(job.id, "Rendering 9:16 MP4", 10, "FFmpeg: crop → 1080×1920 → burn-in captions → audio mix");
    const output = path.join(workDir, "clip.mp4");
    let lastReported = 10;
    await renderVerticalClip({
      input: sourcePath,
      output,
      workDir,
      startSec: clip.startSec,
      endSec: clip.endSec,
      srcWidth: project.width ?? probe.width,
      srcHeight: project.height ?? probe.height,
      cropX: clip.cropX,
      hasAudio: probe.hasAudio,
      subtitlesFile: clip.subtitles.length ? "captions.ass" : undefined,
      music: { track: clip.musicTrack, volume: clip.musicVolume },
      onProgress: (fraction) => {
        const pct = 10 + fraction * 80;
        if (pct - lastReported >= 5) {
          lastReported = pct;
          void reportProgress(job.id, "Rendering 9:16 MP4", pct, `${Math.round(fraction * 100)}% rendered`);
        }
      },
    });

    await reportProgress(job.id, "Uploading to storage", 92, "Saving the MP4 to storage");
    const key = `exports/${clip.id}-${Date.now()}.mp4`;
    const storageKey = await saveExport(output, key);

    await db
      .update(clips)
      .set({ exportStatus: "ready", exportKey: storageKey, exportedAt: new Date(), exportError: null, updatedAt: new Date() })
      .where(eq(clips.id, clipId));
    await reportProgress(job.id, "Export ready", 100, "MP4 is ready to download");
  } catch (err) {
    await db
      .update(clips)
      .set({ exportStatus: "failed", exportError: errMsg(err).slice(0, 500), updatedAt: new Date() })
      .where(eq(clips.id, clipId));
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
