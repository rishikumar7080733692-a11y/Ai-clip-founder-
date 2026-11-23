/**
 * DB-backed background job queue.
 * - Jobs are persisted in the `jobs` table, so progress survives page reloads.
 * - A single in-process worker drains the queue (one heavy FFmpeg/AI job at a time).
 * - Jobs left "running" by a crash/restart are re-queued automatically on the next start.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs, type Job } from "@/db/schema";
import { analyzeProject } from "./analyze-project";
import { exportClip } from "./export-clip";

type WorkerState = { running: boolean; recovered: boolean };
const g = globalThis as typeof globalThis & { __clipfinderWorker?: WorkerState };

const handlers: Record<string, (job: Job) => Promise<void>> = {
  analyze: analyzeProject,
  export: exportClip,
};

export async function enqueueJob(input: {
  userId: string;
  type: "analyze" | "export";
  projectId?: string;
  clipId?: string;
}): Promise<Job> {
  const [job] = await db
    .insert(jobs)
    .values({
      userId: input.userId,
      type: input.type,
      projectId: input.projectId,
      clipId: input.clipId,
      status: "queued",
      stage: "Queued",
      progress: 0,
    })
    .returning();
  kickWorker();
  return job;
}

export function kickWorker() {
  const state = (g.__clipfinderWorker ??= { running: false, recovered: false });
  if (state.running) return;
  state.running = true;
  drain(state).catch((err) => {
    console.error("[worker] fatal", err);
    state.running = false;
  });
}

async function nextQueued(): Promise<Job | undefined> {
  const [row] = await db.select().from(jobs).where(eq(jobs.status, "queued")).orderBy(asc(jobs.createdAt)).limit(1);
  return row;
}

async function drain(state: WorkerState) {
  if (!state.recovered) {
    state.recovered = true;
    await db
      .update(jobs)
      .set({ status: "queued", stage: "Re-queued after server restart", updatedAt: new Date() })
      .where(eq(jobs.status, "running"));
  }
  for (;;) {
    const next = await nextQueued();
    if (!next) {
      state.running = false;
      // Guard against a job enqueued while we were deciding to stop.
      const late = await nextQueued();
      if (!late) return;
      state.running = true;
      continue;
    }
    const [claimed] = await db
      .update(jobs)
      .set({ status: "running", stage: "Starting", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, "queued")))
      .returning();
    if (!claimed) continue;

    try {
      const handler = handlers[claimed.type];
      if (!handler) throw new Error(`No handler for job type "${claimed.type}"`);
      await handler(claimed);
      await db
        .update(jobs)
        .set({ status: "succeeded", stage: "Completed", progress: 100, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(jobs.id, claimed.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[worker] job ${claimed.id} (${claimed.type}) failed:`, message);
      await db
        .update(jobs)
        .set({ status: "failed", stage: "Failed", error: message, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(jobs.id, claimed.id));
    }
  }
}
