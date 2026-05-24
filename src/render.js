/**
 * Ghost Engine — Core Render Pipeline (Two-Pass Architecture)
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  PASS 1: Base Render (HyperFrames)                         │
 * │  ├── hyperframes render composition → MP4 video             │
 * │  └── FFmpeg extracts → PNG frame sequence                  │
 * ├─────────────────────────────────────────────────────────────┤
 * │  PASS 2: GPU Post-Processing (Ghost Engine)                │
 * │  ├── Puppeteer + WebGL2 headless browser                   │
 * │  ├── Each PNG frame → WebGL texture → shader pipeline     │
 * │  └── Captured → new PNG frame                              │
 * ├─────────────────────────────────────────────────────────────┤
 * │  PASS 3: Video Encode (FFmpeg)                             │
 * │  └── Post-processed PNGs → H.264 + bt709 + faststart       │
 * └─────────────────────────────────────────────────────────────┘
 */

import { resolve, join, dirname, basename } from "pathe";
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync,
  cpSync, readdirSync, statSync
} from "fs";
import { spawn } from "child_process";
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

  const absOutputPath = resolve(outputPath);
  const workDir = join(dirname(absOutputPath), ".ghost-engine-work");
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
      outputPath: absOutputPath,
      fps,
      width,
      height,
    });
    consola.success("Video encode complete");

    // Cleanup
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true });
    }

    const fileSize = statSync(absOutputPath).size / (1024 * 1024);
    consola.success(`🎬 Render complete: ${absOutputPath} (${fileSize.toFixed(1)} MB)`);

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
  const baseVideoPath = join(baseFramesDir, "base-render.mp4");

  const hfArgs = [
    "render",
    resolve(compositionPath),
    "--output", baseVideoPath,
    "--fps", String(fps),
  ];

  // GPU mode controls ONLY Chrome/WebGL browser GPU, NOT video encoding
  // HyperFrames' --gpu flag uses h264_nvenc which requires NVIDIA GPU
  // We always use software encoding (libx264) since GPU encoding often fails
  if (gpuMode === "hardware") {
    hfArgs.push("--browser-gpu");
  } else {
    hfArgs.push("--no-browser-gpu");
  }

  // Resolution preset
  if (width >= 3840 && height >= 2160) {
    hfArgs.push("--resolution", "landscape-4k");
  } else if (width === 1080 && height === 1080) {
    hfArgs.push("--resolution", "square");
  }
  // For custom resolutions, HyperFrames uses the composition's own dimensions

  if (hyperframesArgs) {
    hfArgs.push(...hyperframesArgs.split(" ").filter(Boolean));
  }

  consola.info(`Running: hyperframes ${hfArgs.join(" ")}`);

  await executeCommand("hyperframes", hfArgs);

  if (!existsSync(baseVideoPath)) {
    throw new Error("HyperFrames did not produce output video");
  }

  // Extract frames from the base video using FFmpeg
  consola.info("Extracting frames from base render...");
  const ffmpegArgs = [
    "-y",
    "-i", baseVideoPath,
    "-q:v", "2",                    // High quality PNG
    join(baseFramesDir, "frame_%06d.png"),
  ];
  await executeCommand("ffmpeg", ffmpegArgs);

  // Remove the intermediate video
  if (existsSync(baseVideoPath)) rmSync(baseVideoPath);

  const frameCount = readdirSync(baseFramesDir).filter(f => f.endsWith(".png")).length;
  if (frameCount === 0) {
    throw new Error("No frames extracted from base render");
  }
  consola.info(`Extracted ${frameCount} base frames`);
}

// ─── PASS 3: FFmpeg Video Encode ────────────────────────────────────

async function encodeVideo({ framesDir, outputPath, fps, width, height }) {
  // Verify frames exist
  const frames = readdirSync(framesDir)
    .filter(f => f.endsWith(".png"))
    .sort();

  if (frames.length === 0) {
    throw new Error("No frames found to encode");
  }

  consola.info(`Encoding ${frames.length} frames → ${outputPath}`);

  const ffmpegArgs = [
    "-y",
    "-framerate", String(fps),
    "-i", join(framesDir, "frame_%06d.png"),
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "18",                    // High quality (0=lossless, 51=worst)
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    // Correct color space for web playback
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    outputPath,
  ];

  await executeCommand("ffmpeg", ffmpegArgs);

  if (!existsSync(outputPath)) {
    throw new Error("FFmpeg did not produce output video");
  }
}

// ─── Command Execution Helper ───────────────────────────────────────

function executeCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],  // stdin: ignore prevents FFmpeg interactive mode
      env: process.env,
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}\n${stderr.slice(-500)}`));
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start ${command}: ${err.message}`));
    });
  });
}
