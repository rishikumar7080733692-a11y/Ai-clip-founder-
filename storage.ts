/**
 * Storage abstraction.
 * - Source videos / subtitles are kept on the worker's local disk (FFmpeg needs local files).
 * - Exported MP4s go to S3-compatible cloud storage when STORAGE_PROVIDER=s3, otherwise local disk.
 */
import fs from "fs";
import path from "path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), "storage");

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per source file

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectDir(projectId: string) {
  return ensureDir(path.join(STORAGE_ROOT, "projects", projectId));
}

export function tmpDir(name: string) {
  return ensureDir(path.join(STORAGE_ROOT, "tmp", name));
}

export function absoluteLocalPath(relative: string) {
  const full = path.resolve(STORAGE_ROOT, relative);
  if (!full.startsWith(STORAGE_ROOT + path.sep)) throw new Error("Invalid storage path");
  return full;
}

export function isS3Enabled() {
  return process.env.STORAGE_PROVIDER === "s3" && Boolean(process.env.S3_BUCKET);
}

let s3: S3Client | null = null;
function s3Client() {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  return s3;
}

/** Stores a finished export; returns the storage key saved on the clip row. */
export async function saveExport(localFile: string, key: string): Promise<string> {
  if (isS3Enabled()) {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: fs.readFileSync(localFile),
        ContentType: "video/mp4",
      }),
    );
    return `s3:${key}`;
  }
  const dest = absoluteLocalPath(path.join("exports", path.basename(key)));
  ensureDir(path.dirname(dest));
  fs.copyFileSync(localFile, dest);
  return `local:exports/${path.basename(key)}`;
}

/** Returns a time-limited URL for cloud objects, or null when the file must be streamed locally. */
export async function getExportSignedUrl(storageKey: string, downloadName: string) {
  if (!storageKey.startsWith("s3:")) return null;
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageKey.slice(3),
      ResponseContentDisposition: `attachment; filename="${downloadName}"`,
    }),
    { expiresIn: 300 },
  );
}

export function localExportPath(storageKey: string): string | null {
  if (!storageKey.startsWith("local:")) return null;
  return absoluteLocalPath(storageKey.slice("local:".length));
}
