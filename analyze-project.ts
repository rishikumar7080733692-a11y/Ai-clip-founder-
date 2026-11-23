/**
 * Analysis pipeline:
 *   probe -> transcript (SRT/VTT upload or Whisper) -> scene cuts -> moment scoring
 *   (AI engine or transparent heuristic engine) -> 5-10 clips -> titles/captions -> save
 */
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, projects, transcriptSegments, type Job } from "@/db/schema";
import { aiEnabled, transcribeAudio } from "@/lib/ai/openai";
import { analyzeWithAI } from "@/lib/analysis/ai-analysis";
import { templateCopy } from "@/lib/analysis/copy";
import { buildCandidates, selectClips, targetClipCount, type Candidate } from "@/lib/analysis/engine";
import { detectScenes, extractSpeechAudio, probeMedia } from "@/lib/media/ffmpeg";
import { parseSubtitleFile, segmentsToSubtitles, splitLongSegments, type Segment } from "@/lib/media/subtitles";
import { absoluteLocalPath, tmpDir } from "@/lib/storage";
import { DEFAULT_STYLE } from "@/lib/constants";
import { reportProgress } from "./state";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");

export async function analyzeProject(job: Job) {
  if (!job.projectId) throw new Error("Analysis job has no project");
  const projectId = job.projectId;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("Project not found");

  await db
    .update(projects)
    .set({ status: "analyzing", errorMessage: null, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  try {
    if (!project.videoPath) throw new Error("Upload your own video file before running analysis.");
    const videoAbs = absoluteLocalPath(project.videoPath);

    await reportProgress(job.id, "Probing media", 5, "Reading duration, resolution and audio track with FFprobe");
    const probe = await probeMedia(videoAbs);
    await db
      .update(projects)
      .set({ durationSec: probe.durationSec, width: probe.width, height: probe.height, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    // ---- Transcript -------------------------------------------------------
    let segments: Segment[];
    let transcriptSource: string;
    if (project.subtitlePath) {
      await reportProgress(job.id, "Parsing transcript", 15, `Reading ${project.subtitleOriginalName ?? "subtitle file"}`);
      const content = fs.readFileSync(absoluteLocalPath(project.subtitlePath), "utf8");
      segments = splitLongSegments(parseSubtitleFile(content));
      transcriptSource = "subtitle_file";
      if (!segments.length) throw new Error("The subtitle file contains no readable caption lines.");
    } else if (aiEnabled()) {
      if (!probe.hasAudio) throw new Error("This video has no audio track to transcribe. Upload an SRT/VTT transcript instead.");
      await reportProgress(job.id, "Extracting audio", 12, "Creating a speech-optimised mono track with FFmpeg");
      const dir = tmpDir(`analyze-${job.id}`);
      try {
        const mp3 = path.join(dir, "speech.mp3");
        await extractSpeechAudio(videoAbs, mp3);
        await reportProgress(job.id, "Transcribing speech", 25, "Whisper transcription with segment timestamps");
        segments = splitLongSegments(await transcribeAudio(mp3, project.language));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      transcriptSource = "whisper";
      if (!segments.length) throw new Error("No speech was detected in this video.");
    } else {
      throw new Error(
        "No transcript available. Upload an SRT/VTT transcript for your video (YouTube Studio → Subtitles → Download), or configure OPENAI_API_KEY for automatic transcription.",
      );
    }

    await db.delete(transcriptSegments).where(eq(transcriptSegments.projectId, projectId));
    for (let i = 0; i < segments.length; i += 500) {
      await db.insert(transcriptSegments).values(
        segments.slice(i, i + 500).map((s, k) => ({
          projectId,
          idx: i + k,
          startSec: s.startSec,
          endSec: s.endSec,
          text: s.text,
        })),
      );
    }
    await db.update(projects).set({ transcriptSource, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await reportProgress(job.id, "Transcript ready", 45, `${segments.length} caption segments`);

    // ---- Scene analysis ---------------------------------------------------
    await reportProgress(job.id, "Detecting scenes", 50, "FFmpeg scene-cut detection on downscaled frames");
    let sceneCuts: number[] = [];
    let sceneNote = "";
    try {
      sceneCuts = await detectScenes(videoAbs);
    } catch (err) {
      sceneNote = `Scene detection unavailable: ${errMsg(err).slice(0, 120)}`;
    }
    await db.update(projects).set({ sceneChanges: sceneCuts, updatedAt: new Date() }).where(eq(projects.id, projectId));

    // ---- Moment analysis --------------------------------------------------
    const duration = probe.durationSec || segments[segments.length - 1]?.endSec || 0;
    const target = targetClipCount(duration);
    let engine: "ai" | "heuristic" = "heuristic";
    let candidates: Candidate[] = [];
    if (aiEnabled()) {
      await reportProgress(job.id, "AI moment analysis", 60, "Analyzing hooks, jokes, reactions, facts and emotional beats");
      try {
        candidates = await analyzeWithAI(segments, duration, project.language);
        engine = "ai";
      } catch (err) {
        await reportProgress(job.id, "AI unavailable — using heuristic engine", 64, errMsg(err).slice(0, 200));
        candidates = buildCandidates(segments, sceneCuts);
      }
    } else {
      await reportProgress(job.id, "Scoring moments", 65, "Heuristic engine: hook, emotion, insight, pacing, completeness");
      candidates = buildCandidates(segments, sceneCuts);
    }
    const picked = selectClips(candidates, target);

    // ---- Copy -------------------------------------------------------------
    await reportProgress(job.id, "Writing titles & captions", 85, `${picked.length} clip(s) selected`);
    const rows = picked.map((c, i) => {
      const copy = c.copy ?? templateCopy(c.transcriptText, project.language === "hi" ? "hi" : "en");
      return {
        projectId,
        userId: job.userId,
        idx: i + 1,
        category: c.category,
        title: copy.title,
        hook: copy.hook,
        caption: copy.caption,
        hashtags: copy.hashtags,
        shortsDescription: copy.shortsDescription,
        thumbnailText: copy.thumbnailText,
        copyLanguage: project.language,
        copySource: c.copy ? "ai" : "heuristic",
        startSec: c.startSec,
        endSec: c.endSec,
        engagementScore: c.score,
        scoreBreakdown: c.breakdown,
        reasons: c.reasons,
        transcriptText: c.transcriptText,
        subtitles: segmentsToSubtitles(segments, c.startSec, c.endSec),
        style: DEFAULT_STYLE,
        cropX: 50,
        musicTrack: "none",
        musicVolume: 18,
        exportStatus: "none",
      };
    });

    await db.delete(clips).where(eq(clips.projectId, projectId));
    if (rows.length) await db.insert(clips).values(rows);

    await db
      .update(projects)
      .set({
        status: "analyzed",
        analysisEngine: engine,
        errorMessage: picked.length === 0 ? "No segments met the minimum signal threshold for this video." : sceneNote || null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    await reportProgress(
      job.id,
      picked.length ? `${picked.length} clip suggestions ready` : "Analysis complete — no strong moments found",
      100,
      sceneNote || undefined,
    );
  } catch (err) {
    await db
      .update(projects)
      .set({ status: "failed", errorMessage: errMsg(err).slice(0, 500), updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    throw err;
  }
}
