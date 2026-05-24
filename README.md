# Ghost Engine v1.0

**GPU-Accelerated HyperFrames Renderer** — After Effects quality post-processing for HyperFrames compositions.

## What It Does

Ghost Engine wraps [HyperFrames](https://github.com/heygen-com/hyperframes) and adds a GPU post-processing pipeline:

| Pass | Engine | What Happens |
|------|--------|-------------|
| **Pass 1** | HyperFrames | Renders base composition → PNG frames |
| **Pass 2** | Ghost Engine (WebGL2) | Applies bloom, chromatic aberration, film grain, vignette, motion blur |
| **Pass 3** | FFmpeg | Encodes post-processed frames → final video |

## Effects

| Effect | Description | GPU Shader |
|--------|------------|-----------|
| **Bloom** | Multi-pass gaussian bloom on bright pixels | ✅ WebGL2 fragment shader |
| **Chromatic Aberration** | Radial RGB channel split with fringe | ✅ WebGL2 fragment shader |
| **Film Grain** | Deterministic per-frame luminance + color noise | ✅ WebGL2 fragment shader |
| **Vignette** | Cinematic edge darkening with warm tint | ✅ WebGL2 fragment shader |
| **Motion Blur** | Velocity-based directional blur | ✅ WebGL2 fragment shader |

## Install

### From GitHub (recommended)
```bash
npm install -g rinkusharma79346-droid/ghost-engine
```

### From npm (when published)
```bash
npm install -g ghost-engine
# or use without installing:
npx ghost-engine render ./composition --output video.mp4
```

## Usage

### Render with GPU effects (default: bloom + chromatic + grain + vignette)
```bash
ghost-engine render ./my-composition --output video.mp4
```

### Render with all effects
```bash
ghost-engine render ./my-composition --output video.mp4 --effects all
```

### Render with specific effects
```bash
ghost-engine render ./my-composition --output video.mp4 --effects bloom,chromatic,filmgrain
```

### Use a preset
```bash
ghost-engine render ./my-composition --output video.mp4 --preset cinematic
```

Available presets:
- `cinematic` — bloom, chromatic aberration, film grain, vignette, motion blur
- `anime` — bloom, chromatic aberration, vignette
- `neon` — bloom, chromatic aberration, vignette
- `minimal` — film grain, vignette
- `max` — all effects at maximum

### Adjust intensity
```bash
ghost-engine render ./my-composition --output video.mp4 --intensity 1.5
```

### Plain HyperFrames render (no effects)
```bash
ghost-engine render ./my-composition --output video.mp4 --no-effects
```

### Custom resolution and FPS
```bash
ghost-engine render ./my-composition --output video.mp4 --width 3840 --height 2160 --fps 60
```

### Hardware GPU acceleration
```bash
ghost-engine render ./my-composition --output video.mp4 --gpu hardware
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PASS 1: Base Render (HyperFrames)                         │
│  ├── hyperframes render composition → base video            │
│  ├── FFmpeg extracts → PNG frames                           │
│  └── Deterministic seek + screenshot for each frame        │
├─────────────────────────────────────────────────────────────┤
│  PASS 2: GPU Post-Processing (Ghost Engine)                │
│  ├── Puppeteer + WebGL2 headless browser                   │
│  ├── Load PNG frame → WebGL texture                        │
│  ├── Apply fragment shaders:                                │
│  │   ├── Bloom (multi-tap gaussian)                        │
│  │   ├── Chromatic Aberration (radial RGB split)           │
│  │   ├── Film Grain (deterministic hash noise)             │
│  │   ├── Vignette (cubic falloff + warm tint)              │
│  │   └── Motion Blur (velocity-based directional)          │
│  └── Capture result → new PNG frame                        │
├─────────────────────────────────────────────────────────────┤
│  PASS 3: Video Encode (FFmpeg)                             │
│  └── Post-processed PNGs → H.264 + faststart               │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

- **Node.js** >= 22
- **HyperFrames** CLI (installed automatically as dependency)
- **FFmpeg** (must be in PATH)
- **Chrome/Chromium** (for WebGL2 post-processing)
- **GPU** (optional — SwiftShader fallback available)

## License

MIT
