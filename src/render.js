/**
 * Ghost Engine — Core Render Pipeline (Two-Pass Architecture)
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  PASS 1: Base Render (HyperFrames)                         │
 * │  ├── hyperframes render composition → PNG frames            │
 * │  └── Deterministic seek + screenshot for each frame        │
 * ├─────────────────────────────────────────────────────────────┤
 * │  PASS 2: GPU Post-Processing (Ghost Engine)                │
 * │  ├── Load PNG frame as WebGL texture                       │
 * │  ├── Apply bloom, chromatic aberration, film grain,        │
 * │  │   vignette, motion blur via fragment shaders            │
 * │  └── Capture processed frame → new PNG                     │
 * ├─────────────────────────────────────────────────────────────┤
 * │  PASS 3: Video Encode (FFmpeg)                             │
 * │  └── Post-processed frames → H.264/H.265 video             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * This approach:
 * - Works with HyperFrames WITHOUT forking it
 * - Uses actual GPU shaders for AE-quality effects
 * - Is deterministic (same input = same output)
 * - Can be parallelized (process N frames simultaneously)
 */

import { resolve, join, dirname, basename } from "pathe";
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync,
  cpSync, readdirSync, statSync, renameSync
} from "fs";
import { execSync, spawn } from "child_process";
import consola from "consola";
import { processFramesGPU } from "./gpu-postprocessor.js";

// ─── Main Render Function ────────────────────────────────────────────

export async function render(options) {
  const {
    compositionPath,
    outputPath,
    fps = 30,
    width = 1920,
    height = 1080,
    effects = ["bloom", "chromatic", "filmgrain", "vignette"],
    intensity = 1.0,
    gpuMode = "auto",
    hyperframesArgs = "",
    skipBaseRender = false,
    skipPostProcess = false,
  } = options;

  const workDir = join(dirname(resolve(outputPath)), ".ghost-engine-work");
  const baseFramesDir = join(workDir, "base-frames");
  const processedFramesDir = join(workDir, "processed-frames");

  // Cleanup previous work
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  mkdirSync(baseFramesDir, { recursive: true });
  mkdirSync(processedFramesDir, { recursive: true });

  try {
    // ── PASS 1: Base Render with HyperFrames ──────────────────────────
    if (!skipBaseRender) {
      consola.info("═══ PASS 1/3: Base Render (HyperFrames) ═══");
      await renderBaseFrames({
        compositionPath,
        baseFramesDir,
        fps,
        width,
        height,
        gpuMode,
        hyperframesArgs,
      });
      consola.success("Base render complete");
    } else {
      consola.info("Skipping base render (skipBaseRender=true)");
    }

    // ── PASS 2: GPU Post-Processing ──────────────────────────────────
    if (!skipPostProcess && effects.length > 0) {
      consola.info("═══ PASS 2/3: GPU Post-Processing ═══");
      consola.info(`Effects: ${effects.join(", ")} (intensity: ${intensity})`);

      await processFramesGPU({
        inputDir: baseFramesDir,
        outputDir: processedFramesDir,
        width,
        height,
        fps,
        effects,
        intensity,
      });
      consola.success("Post-processing complete");
    } else {
      // Just copy base frames to processed dir
      consola.info("Skipping post-processing, using base frames");
      cpSync(baseFramesDir, processedFramesDir, { recursive: true });
    }

    // ── PASS 3: FFmpeg Encode ────────────────────────────────────────
    consola.info("═══ PASS 3/3: Video Encode (FFmpeg) ═══");
    await encodeVideo({
      framesDir: processedFramesDir,
      outputPath: resolve(outputPath),
      fps,
      width,
      height,
    });
    consola.success("Video encode complete");

    // Cleanup
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true });
    }

    consola.success(`🎬 Render complete: ${resolve(outputPath)}`);

  } catch (err) {
    consola.error("Render failed:", err.message);
    // Keep work dir for debugging
    consola.info(`Work dir preserved for debugging: ${workDir}`);
    throw err;
  }
}

// ─── PASS 1: HyperFrames Base Render ────────────────────────────────

async function renderBaseFrames({
  compositionPath,
  baseFramesDir,
  fps,
  width,
  height,
  gpuMode,
  hyperframesArgs,
}) {
  // HyperFrames can output frames directly with --frames flag
  const baseVideoPath = join(baseFramesDir, "base-render.mp4");

  const hfArgs = [
    "render",
    resolve(compositionPath),
    "--output", baseVideoPath,
    "--fps", String(fps),
    "--width", String(width),
    "--height", String(height),
    "--gpu", gpuMode,
  ];

  if (hyperframesArgs) {
    hfArgs.push(...hyperframesArgs.split(" ").filter(Boolean));
  }

  consola.info(`Running: hyperframes ${hfArgs.join(" ")}`);

  await executeCommand("hyperframes", hfArgs);

  // Extract frames from the video using FFmpeg
  consola.info("Extracting frames from base render...");
  const ffmpegArgs = [
    "-i", baseVideoPath,
    "-q:v", "2",
    join(baseFramesDir, "frame_%06d.png"),
  ];
  await executeCommand("ffmpeg", ffmpegArgs);

  // Remove the intermediate video
  if (existsSync(baseVideoPath)) rmSync(baseVideoPath);

  const frameCount = readdirSync(baseFramesDir).filter(f => f.endsWith(".png")).length;
  consola.info(`Extracted ${frameCount} base frames`);
}

// ─── PASS 3: FFmpeg Video Encode ────────────────────────────────────

async function encodeVideo({ framesDir, outputPath, fps, width, height }) {
  // Sort frames to ensure correct order
  const frames = readdirSync(framesDir)
    .filter(f => f.endsWith(".png"))
    .sort();

  if (frames.length === 0) {
    throw new Error("No frames found to encode");
  }

  consola.info(`Encoding ${frames.length} frames → ${outputPath}`);

  const ffmpegArgs = [
    "-framerate", String(fps),
    "-i", join(framesDir, "frame_%06d.png"),
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "18",           // High quality
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-y",
    outputPath,
  ];

  await executeCommand("ffmpeg", ffmpegArgs);
}

// ─── Command Execution Helper ───────────────────────────────────────

function executeCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start ${command}: ${err.message}`));
    });
  });
}
