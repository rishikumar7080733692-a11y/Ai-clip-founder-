/**
 * FFmpeg / FFprobe wrappers. All calls use argv arrays (no shell), so user-supplied
 * values can never inject commands.
 */
import { spawn } from "child_process";
import { MUSIC_TRACKS } from "@/lib/constants";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export class MediaError extends Error {}

type RunOptions = { cwd?: string; onStderr?: (chunk: string) => void };

function run(cmd: string, args: string[], opts: RunOptions = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });
    child.on("error", (err) =>
      reject(new MediaError(`${cmd} could not start (${err.message}). Install FFmpeg or set FFMPEG_PATH.`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.split("\n").filter(Boolean).slice(-4).join(" | ");
        reject(new MediaError(`${cmd} exited with code ${code}: ${tail}`));
      }
    });
  });
}

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export async function probeMedia(file: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new MediaError("The uploaded file contains no video stream.");
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")),
  };
}

/** Scene-cut detection on downscaled frames. Returns timestamps (seconds) of cuts. */
export async function detectScenes(file: string, threshold = 0.3): Promise<number[]> {
  const { stderr } = await run(FFMPEG, [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-an",
    "-vf",
    `scale=320:-2,select='gt(scene\\,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ]);
  const times = new Set<number>();
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) times.add(Math.round(t * 100) / 100);
  }
  return [...times].sort((a, b) => a - b).slice(0, 5000);
}

/** Extracts a mono 16 kHz speech-optimised MP3 (small enough for transcription APIs). */
export async function extractSpeechAudio(file: string, outMp3: string) {
  await run(FFMPEG, ["-hide_banner", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", outMp3]);
  return outMp3;
}

export type RenderOptions = {
  input: string;
  output: string;
  workDir: string; // cwd so the subtitle filter can use a simple relative filename
  startSec: number;
  endSec: number;
  srcWidth: number;
  srcHeight: number;
  cropX: number; // 0 (left) .. 100 (right)
  hasAudio: boolean;
  subtitlesFile?: string; // relative to workDir
  music?: { track: string; volume: number };
  onProgress?: (fraction: number) => void;
};

/** Renders a 1080x1920 (9:16) H.264/AAC MP4 with optional burned-in subtitles and music bed. */
export async function renderVerticalClip(o: RenderOptions) {
  const duration = Math.max(0.5, o.endSec - o.startSec);
  const cropH = o.srcHeight - (o.srcHeight % 2);
  let cropW = Math.min(o.srcWidth, Math.round((o.srcHeight * 9) / 16));
  cropW -= cropW % 2;
  const maxX = o.srcWidth - cropW;
  const x = Math.max(0, Math.min(maxX, Math.round((maxX * Math.min(100, Math.max(0, o.cropX))) / 100)));
  const x2 = x - (x % 2);

  let videoChain = `crop=${cropW}:${cropH}:${x2}:0,scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p`;
  if (o.subtitlesFile) videoChain += `,subtitles=${o.subtitlesFile}`;

  const args = ["-hide_banner", "-y", "-ss", o.startSec.toFixed(3), "-i", o.input];
  const filters = [`[0:v]${videoChain}[vout]`];
  const track = MUSIC_TRACKS.find((t) => t.value === o.music?.track && t.expr);
  const musicVolume = Math.min(1, Math.max(0, (o.music?.volume ?? 0) / 100));

  let audioMap: string[] = [];
  if (track) {
    args.push("-f", "lavfi", "-i", `aevalsrc=${track.expr}:s=44100`);
    if (o.hasAudio) {
      filters.push(
        `[1:a]volume=${musicVolume.toFixed(2)}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
      );
    } else {
      filters.push(`[1:a]volume=${musicVolume.toFixed(2)}[aout]`);
    }
    audioMap = ["-map", "[aout]"];
  } else if (o.hasAudio) {
    audioMap = ["-map", "0:a:0"];
  }

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", ...audioMap);
  args.push("-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p");
  if (audioMap.length) args.push("-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-movflags", "+faststart", o.output);

  await run(FFMPEG, args, {
    cwd: o.workDir,
    onStderr: (chunk) => {
      if (!o.onProgress) return;
      const matches = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const last = matches[matches.length - 1];
      if (!last) return;
      const sec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
      o.onProgress(Math.min(1, sec / duration));
    },
  });
}
