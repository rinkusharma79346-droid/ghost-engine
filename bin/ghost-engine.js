#!/usr/bin/env node

/**
 * Ghost Engine CLI — GPU-accelerated HyperFrames renderer
 *
 * Usage:
 *   ghost-engine render <composition> --output video.mp4
 *   ghost-engine inject <composition.html> --output injected.html
 *   ghost-engine render <composition> --output video.mp4 --effects bloom,chromatic,filmgrain
 *   ghost-engine render <composition> --output video.mp4 --preset cinematic
 */

import { defineCommand, runMain } from "citty";
import { resolve, basename } from "pathe";
import { existsSync } from "fs";
import { render } from "../src/render.js";
import { injectPostProcessing } from "../src/injector.js";
import consola from "consola";

const renderCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render a HyperFrames composition with GPU post-processing effects",
  },
  args: {
    composition: {
      type: "positional",
      description: "Path to composition directory or HTML file",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output video file path",
      default: "output.mp4",
    },
    fps: {
      type: "string",
      alias: "f",
      description: "Frames per second",
      default: "30",
    },
    width: {
      type: "string",
      alias: "w",
      description: "Video width",
      default: "1920",
    },
    height: {
      type: "string",
      alias: "h",
      description: "Video height",
      default: "1080",
    },
    effects: {
      type: "string",
      alias: "e",
      description: "Comma-separated list of effects: bloom,chromatic,filmgrain,motionblur,vignette,all",
      default: "bloom,chromatic,filmgrain,vignette",
    },
    preset: {
      type: "string",
      alias: "p",
      description: "Effect preset: cinematic, anime, neon, minimal, max",
      default: "",
    },
    intensity: {
      type: "string",
      alias: "i",
      description: "Effect intensity 0.0-2.0",
      default: "1.0",
    },
    gpu: {
      type: "string",
      alias: "g",
      description: "GPU mode: auto, hardware, software",
      default: "auto",
    },
    "no-effects": {
      type: "boolean",
      description: "Disable all post-processing (plain HyperFrames render)",
      default: false,
    },
    "hyperframes-args": {
      type: "string",
      description: "Additional args to pass through to hyperframes CLI",
      default: "",
    },
  },
  async run({ args }) {
    const compositionPath = resolve(args.composition);
    const outputPath = resolve(args.output);

    if (!existsSync(compositionPath)) {
      consola.error(`Composition not found: ${compositionPath}`);
      process.exit(1);
    }

    consola.box("Ghost Engine v1.0 — GPU-Accelerated Renderer");

    const options = {
      compositionPath,
      outputPath,
      fps: parseInt(args.fps, 10),
      width: parseInt(args.width, 10),
      height: parseInt(args.height, 10),
      effects: args.noEffects ? [] : parseEffects(args.effects, args.preset),
      intensity: parseFloat(args.intensity),
      gpuMode: args.gpu,
      hyperframesArgs: args.hyperframesArgs,
    };

    consola.info("Render options:", {
      composition: basename(compositionPath),
      output: basename(outputPath),
      fps: options.fps,
      resolution: `${options.width}x${options.height}`,
      effects: options.effects.length > 0 ? options.effects.join(", ") : "(none)",
      intensity: options.intensity,
      gpu: options.gpuMode,
    });

    try {
      await render(options);
      consola.success(`Render complete: ${outputPath}`);
    } catch (err) {
      consola.error("Render failed:", err.message);
      process.exit(1);
    }
  },
});

const injectCommand = defineCommand({
  meta: {
    name: "inject",
    description: "Inject Ghost Engine WebGL post-processing into a composition HTML file",
  },
  args: {
    input: {
      type: "positional",
      description: "Path to composition HTML file",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output HTML file path (default: overwrites input)",
      default: "",
    },
    effects: {
      type: "string",
      alias: "e",
      description: "Comma-separated list of effects",
      default: "bloom,chromatic,filmgrain,vignette",
    },
    preset: {
      type: "string",
      alias: "p",
      description: "Effect preset",
      default: "",
    },
    intensity: {
      type: "string",
      alias: "i",
      description: "Effect intensity 0.0-2.0",
      default: "1.0",
    },
  },
  async run({ args }) {
    const inputPath = resolve(args.input);
    const outputPath = args.output ? resolve(args.output) : inputPath;

    if (!existsSync(inputPath)) {
      consola.error(`File not found: ${inputPath}`);
      process.exit(1);
    }

    const effects = parseEffects(args.effects, args.preset);
    const intensity = parseFloat(args.intensity);

    consola.info(`Injecting effects: ${effects.join(", ")} (intensity: ${intensity})`);

    await injectPostProcessing(inputPath, outputPath, { effects, intensity });

    consola.success(`Injected: ${outputPath}`);
  },
});

const main = runMain(defineCommand({
  meta: {
    name: "ghost-engine",
    description: "Ghost Engine — GPU-accelerated HyperFrames renderer",
    version: "1.0.0",
  },
  subCommands: {
    render: renderCommand,
    inject: injectCommand,
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────

function parseEffects(effectsStr, preset) {
  if (preset) {
    const presets = {
      cinematic: ["bloom", "chromatic", "filmgrain", "vignette", "motionblur"],
      anime: ["bloom", "chromatic", "vignette"],
      neon: ["bloom", "chromatic", "vignette"],
      minimal: ["filmgrain", "vignette"],
      max: ["bloom", "chromatic", "filmgrain", "vignette", "motionblur"],
    };
    return presets[preset] || presets.cinematic;
  }

  if (effectsStr === "all") {
    return ["bloom", "chromatic", "filmgrain", "vignette", "motionblur"];
  }

  return effectsStr.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}
