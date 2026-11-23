import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* Projects (one source video the user owns / is permitted to edit)     */
/* ------------------------------------------------------------------ */

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    language: text("language").notNull().default("en"), // en | hi
    // Status: draft | ready | analyzing | analyzed | failed
    status: text("status").notNull().default("draft"),

    youtubeUrl: text("youtube_url"),
    youtubeVideoId: text("youtube_video_id"),
    youtubeTitle: text("youtube_title"),
    youtubeAuthor: text("youtube_author"),
    youtubeThumbnail: text("youtube_thumbnail"),

    rightsConfirmedAt: timestamp("rights_confirmed_at", { withTimezone: true }),

    videoPath: text("video_path"),
    videoOriginalName: text("video_original_name"),
    videoSizeBytes: bigint("video_size_bytes", { mode: "number" }),
    durationSec: doublePrecision("duration_sec"),
    width: integer("width"),
    height: integer("height"),

    subtitlePath: text("subtitle_path"),
    subtitleOriginalName: text("subtitle_original_name"),
    // transcript source: subtitle_file | whisper
    transcriptSource: text("transcript_source"),
    // analysis engine: ai | heuristic
    analysisEngine: text("analysis_engine"),
    sceneChanges: jsonb("scene_changes").$type<number[]>().notNull().default([]),

    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("projects_user_idx").on(t.userId, t.createdAt)],
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: serial("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    startSec: doublePrecision("start_sec").notNull(),
    endSec: doublePrecision("end_sec").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("transcript_project_idx").on(t.projectId, t.idx)],
);

/* ------------------------------------------------------------------ */
/* Clips                                                               */
/* ------------------------------------------------------------------ */

export const clips = pgTable(
  "clips",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    category: text("category").notNull().default("insight"),
    title: text("title").notNull(),
    hook: text("hook").notNull(),
    caption: text("caption").notNull(),
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    shortsDescription: text("shorts_description").notNull(),
    thumbnailText: text("thumbnail_text").notNull(),
    copyLanguage: text("copy_language").notNull().default("en"),
    copySource: text("copy_source").notNull().default("heuristic"),

    startSec: doublePrecision("start_sec").notNull(),
    endSec: doublePrecision("end_sec").notNull(),
    engagementScore: integer("engagement_score").notNull(),
    // { hook, emotion, insight, pacing, completeness } each 0-100 + weights
    scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown>().notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    transcriptText: text("transcript_text").notNull().default(""),

    // Editable subtitle lines, absolute source-video seconds
    subtitles: jsonb("subtitles").$type<SubtitleLine[]>().notNull().default([]),
    style: jsonb("style").$type<SubtitleStyle>().notNull(),
    cropX: integer("crop_x").notNull().default(50),
    musicTrack: text("music_track").notNull().default("none"),
    musicVolume: integer("music_volume").notNull().default(18),

    // none | queued | rendering | ready | failed
    exportStatus: text("export_status").notNull().default("none"),
    exportKey: text("export_key"),
    exportError: text("export_error"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("clips_project_idx").on(t.projectId, t.idx)],
);

/* ------------------------------------------------------------------ */
/* Background jobs (DB-backed queue with genuine progress)              */
/* ------------------------------------------------------------------ */

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    clipId: uuid("clip_id").references(() => clips.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // analyze | export
    // queued | running | succeeded | failed
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("Queued"),
    progress: integer("progress").notNull().default(0),
    message: text("message"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_status_idx").on(t.status, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Shared JSON shapes                                                  */
/* ------------------------------------------------------------------ */

export type ScoreBreakdown = {
  hook: number;
  emotion: number;
  insight: number;
  pacing: number;
  completeness: number;
  weights: { hook: number; emotion: number; insight: number; pacing: number; completeness: number };
};

export type SubtitleLine = { id: string; start: number; end: number; text: string };

export type SubtitleStyle = {
  font: string;
  fontSize: number; // 1-10 (relative)
  textColor: string;
  outlineColor: string;
  position: "top" | "middle" | "bottom";
  highlight: boolean;
};

export type Project = typeof projects.$inferSelect;
export type Clip = typeof clips.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type User = typeof users.$inferSelect;
