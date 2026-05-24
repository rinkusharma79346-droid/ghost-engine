# Ghost Engine

> HyperFrames fork optimized for After Effects–quality rendering on cloud GPUs.

## What is Ghost Engine?

Ghost Engine is a modified build of the HyperFrames rendering engine that prioritizes **GPU acceleration** and **visual fidelity** over the upstream defaults. It ships with aggressive GPU flags, NVENC support, and fallback overrides for environments where the stock WebGL probe fails (Google Colab, headless CI, Docker containers with passthrough GPUs).

The goal: render HyperFrames compositions at the same quality you'd get from After Effects, but on a $0.50/hr cloud T4 instead of a $50/hr workstation.

---

## Environment Variables

### `GHOST_GPU_MODE`

Directly set the browser GPU mode, bypassing the auto-detect probe entirely.

| Value        | Behavior                                            |
|--------------|-----------------------------------------------------|
| `hardware`   | Force hardware GPU mode (no probe, no fallback)    |
| `software`   | Force software/SwiftShader mode                    |

**When to use:** When you know your GPU is available and don't want to pay the ~1–2 s probe cost, or when the probe is unreliable in your environment.

```bash
export GHOST_GPU_MODE=hardware
```

### `GHOST_FORCE_GPU`

A softer override: when set to `1`, the auto-detect probe still runs, but if it **fails** (Chrome can't probe WebGL), the engine falls back to `hardware` instead of `software`. This is the recommended flag for Google Colab.

| Value | Behavior                                                        |
|-------|-----------------------------------------------------------------|
| `1`   | On probe failure, resolve to `hardware` instead of `software`  |

**When to use:** Google Colab T4/V100/A100 notebooks, Docker containers with GPU passthrough where the headless Chrome WebGL context may not initialize correctly but the GPU is still reachable.

```bash
export GHOST_FORCE_GPU=1
```

### `GHOST_NVENC`

Force the FFmpeg encoder to use NVIDIA's NVENC hardware encoder instead of the CPU-based `libx264`/`libx265`.

| Value | Behavior                                                    |
|-------|-------------------------------------------------------------|
| `1`   | Use `h264_nvenc` for h264, `hevc_nvenc` for h265          |

**When to use:** When you have an NVIDIA GPU with NVENC support and want 5–20× faster encoding. Especially useful on Colab T4 (Turing NVENC) and V100/A100.

```bash
export GHOST_NVENC=1
```

> **Note:** NVENC requires the `nvidia-driver` and FFmpeg built with `--enable-nvenc`. The stock Colab FFmpeg includes NVENC support.

---

## Quick Start: Google Colab

```python
# In a Colab cell (GPU runtime required: T4, V100, A100)
!pip install hyperframes  # or your Ghost Engine build

import os
os.environ["GHOST_FORCE_GPU"] = "1"   # Force GPU if probe fails
os.environ["GHOST_NVENC"] = "1"        # Use NVENC for encoding

# Your render code here
# from hyperframes import render
# render("composition.html", "output.mp4")
```

### What happens under the hood

1. **`GHOST_FORCE_GPU=1`** → `browserGpuMode` resolves to `"auto"`, and if the WebGL probe fails (common in Colab's headless Chrome), the fallback is `"hardware"` instead of `"software"`.
2. **`GHOST_NVENC=1`** → FFmpeg uses `h264_nvenc` instead of `libx264`, cutting encode time by 5–20× on the T4.
3. **Linux GPU flags** → Chrome launches with `--use-gl=egl --enable-gpu --enable-gpu-rasterization --enable-features=VaapiVideoDecoder --force-gpu-mem-available-mb=8192`, maximizing GPU utilization.

---

## Visual Quality Improvements Roadmap

### v1 (Current)
- ✅ GPU force mode for Colab / headless environments
- ✅ NVENC hardware encoding
- ✅ Aggressive Linux GPU Chrome flags
- ✅ 8 GB GPU memory allocation for large compositions

### v2 (Planned)
- 🔲 10-bit output pipeline (yuv420p10le by default for SDR)
- 🔲 ProRes 4444 XQ quality level for NLC round-trip
- 🔲 DNxHR HQX encoding option
- 🔲 Per-frame PSNR/SSIM quality validation

### v3 (Planned)
- 🔲 HDR PQ/HLG output with static metadata
- 🔲 Dolby Vision Profile 8.1 metadata injection
- 🔲 ACES color management pipeline
- 🔲 After Effects–matching motion blur (per-subframe accumulation)

### v4 (Planned)
- 🔲 Real-time preview via WebRTC streaming
- 🔲 Multi-GPU rendering (scene-level parallelism)
- 🔲 Distributed rendering across multiple Colab sessions
- 🔲 Automatic quality benchmarking vs. AE reference frames

---

## Technical Details

### Why does the WebGL probe fail on Colab?

Google Colab runs Chrome in a headless environment where the GPU is accessible via NVIDIA's container toolkit, but the standard WebGL context creation path can fail because:

1. Chrome's GPU process may not detect the GPU through the container's device mapper.
2. The `--use-gl=egl` flag is required (not the default ANGLE path).
3. Colab's `--disable-dev-shm-usage` reduces shared memory, which can affect GPU init.

Ghost Engine works around this by:
- Using `GHOST_FORCE_GPU=1` to bypass the failed probe and force hardware mode.
- Adding `--enable-gpu` and `--enable-features=VaapiVideoDecoder` Chrome flags.
- Allocating 8 GB of GPU memory with `--force-gpu-mem-available-mb=8192`.

### NVENC vs libx264 Quality

At the same CRF/CQ value, NVENC (Turing/Ampere) produces output that is visually comparable to `libx264 -preset medium` for most content. The trade-off:

| Encoder      | Speed (1080p30) | Quality (CRF 18) | File Size |
|-------------|-----------------|-------------------|-----------|
| libx264     | ~15 fps         | Reference         | 1×        |
| h264_nvenc  | ~200+ fps       | ~95% of reference | ~1.1×     |

For preview/draft quality, NVENC is a clear win. For final delivery, consider `libx264 -preset slow` or `hevc_nvenc -preset p7 -cq 18`.

---

## Compatibility

| Environment       | GHOST_FORCE_GPU | GHOST_NVENC | Notes                              |
|-------------------|-----------------|-------------|-------------------------------------|
| Google Colab T4   | ✅ Required      | ✅ Supported | Recommended setup                   |
| Google Colab V100 | ✅ Required      | ✅ Supported |                                     |
| Google Colab A100 | ✅ Required      | ✅ Supported |                                     |
| AWS EC2 (g4dn)    | ✅ Recommended   | ✅ Supported |                                     |
| Local Linux + GPU | ⬜ Optional      | ✅ Supported | Auto-detect usually works           |
| macOS             | ⬜ Not needed    | ❌ No NVENC  | Use VideoToolbox instead            |
| CPU-only          | ❌ N/A           | ❌ N/A       | Use stock HyperFrames               |

---

*Ghost Engine is not affiliated with the HyperFrames project. It is an independent fork focused on cloud GPU rendering.*
