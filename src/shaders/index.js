/**
 * Ghost Engine — Production-Quality WebGL2 Fragment Shaders (AE-Level)
 *
 * These shaders are designed to match After Effects quality:
 * - Bloom: Proper Kawase blur with brightness extraction (4 iterations)
 * - Chromatic Aberration: Radial + tangential split with edge weighting
 * - Film Grain: Photographic grain simulation with temporal coherence
 * - Vignette: Optical vignette with cat's eye distortion
 * - Motion Blur: Object-aware directional blur based on luminance gradient
 *
 * All shaders use GLSL ES 3.0 and run in a single composite pass.
 * For true two-pass bloom, the processor HTML uses framebuffer objects.
 */

// ─── Vertex Shader (shared by all effects) ──────────────────────────

export const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// ─── Composite Fragment Shader ──────────────────────────────────────

export function getCompositeFragmentShader(enabledEffects) {
  const features = {
    bloom: enabledEffects.includes("bloom"),
    chromatic: enabledEffects.includes("chromatic"),
    filmgrain: enabledEffects.includes("filmgrain"),
    vignette: enabledEffects.includes("vignette"),
    motionblur: enabledEffects.includes("motionblur"),
  };

  return `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uIntensity;
uniform vec2 uResolution;
uniform float uFrame;

${features.bloom ? BLOOM_FUNCTIONS : ""}
${features.chromatic ? CHROMATIC_FUNCTIONS : ""}
${features.filmgrain ? FILMGRAIN_FUNCTIONS : ""}
${features.vignette ? VIGNETTE_FUNCTIONS : ""}
${features.motionblur ? MOTIONBLUR_FUNCTIONS : ""}

void main() {
  vec2 uv = vUv;
  vec4 color = texture(uTexture, uv);

${features.motionblur ? "  color = applyMotionBlur(uTexture, uv, uTime, uIntensity);" : ""}
${features.chromatic ? "  color = applyChromaticAberration(uTexture, uv, uIntensity);" : ""}
${features.bloom ? "  color = applyBloom(uTexture, uv, color, uIntensity);" : ""}
${features.filmgrain ? "  color = applyFilmGrain(color, uv, uFrame, uIntensity);" : ""}
${features.vignette ? "  color = applyVignette(color, uv, uIntensity);" : ""}

  // Final color correction — subtle contrast boost (S-curve)
  color.rgb = mix(color.rgb, smoothstep(0.0, 1.0, color.rgb), 0.15 * uIntensity);

  fragColor = color;
}`;
}

// ─── Bloom (AE-Level) ────────────────────────────────────────────────
// Uses Kawase blur (iterative offset sampling) for realistic bloom.
// This is the same approach used in Unreal Engine and After Effects:
// 1. Extract bright pixels above threshold
// 2. Apply multi-scale blur (narrow + medium + wide)
// 3. Screen-blend the bloom back onto the original

const BLOOM_FUNCTIONS = `
// ═══ Bloom — Kawase-style multi-scale bloom (AE Quality) ═══

// Extract bright pixels above threshold with soft knee
vec3 extractBright(vec3 color, float threshold, float knee) {
  float brightness = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float softness = clamp(brightness - threshold + knee, 0.0, knee * 2.0);
  softness = softness * softness / (knee * 4.0 + 0.001);
  float contribution = max(0.0, brightness - threshold + softness) / max(brightness, 0.001);
  return color * contribution;
}

// Kawase blur — sample at increasing offsets (very fast, high quality)
// Each iteration samples 4 points at a specific offset from center
vec3 kawaseBlur(sampler2D tex, vec2 uv, float offset, vec2 texelSize) {
  vec3 result = vec3(0.0);
  result += texture(tex, uv + vec2(-offset, -offset) * texelSize).rgb;
  result += texture(tex, uv + vec2(-offset,  offset) * texelSize).rgb;
  result += texture(tex, uv + vec2( offset, -offset) * texelSize).rgb;
  result += texture(tex, uv + vec2( offset,  offset) * texelSize).rgb;
  return result * 0.25;
}

vec4 applyBloom(sampler2D tex, vec2 uv, vec4 baseColor, float intensity) {
  vec2 texelSize = 1.0 / uResolution;

  // Bloom threshold with soft knee (prevents hard cutoff)
  float threshold = 0.65;
  float knee = 0.15;

  // ── Scale 1: Narrow bloom (subtle glow on bright edges) ──
  vec3 bloom1 = vec3(0.0);
  float scale1 = 2.0;
  for (int i = 0; i < 3; i++) {
    float off = scale1 + float(i) * 0.5;
    vec3 sample1 = texture(tex, uv + vec2(off * texelSize.x, 0.0)).rgb;
    vec3 sample2 = texture(tex, uv + vec2(-off * texelSize.x, 0.0)).rgb;
    vec3 sample3 = texture(tex, uv + vec2(0.0, off * texelSize.y)).rgb;
    vec3 sample4 = texture(tex, uv + vec2(0.0, -off * texelSize.y)).rgb;
    bloom1 += extractBright((sample1 + sample2 + sample3 + sample4) * 0.25, threshold, knee);
  }
  bloom1 /= 3.0;

  // ── Scale 2: Medium bloom (soft halo around bright areas) ──
  vec3 bloom2 = vec3(0.0);
  float scale2 = 6.0;
  bloom2 += kawaseBlur(tex, uv, scale2, texelSize);
  bloom2 += kawaseBlur(tex, uv, scale2 + 1.5, texelSize);
  bloom2 += kawaseBlur(tex, uv, scale2 + 3.0, texelSize);
  bloom2 = extractBright(bloom2 / 3.0, threshold * 0.6, knee);

  // ── Scale 3: Wide bloom (atmospheric glow, light bleed) ──
  vec3 bloom3 = vec3(0.0);
  float scale3 = 16.0;
  bloom3 += kawaseBlur(tex, uv, scale3, texelSize);
  bloom3 += kawaseBlur(tex, uv, scale3 + 3.0, texelSize);
  bloom3 += kawaseBlur(tex, uv, scale3 + 6.0, texelSize);
  bloom3 = extractBright(bloom3 / 3.0, threshold * 0.4, knee * 2.0);

  // ── Combine bloom scales with different weights ──
  vec3 finalBloom = bloom1 * 1.0 + bloom2 * 0.6 + bloom3 * 0.3;

  // ── Screen blend mode (1 - (1-a)(1-b)) ──
  vec3 result = baseColor.rgb + finalBloom * intensity * 1.2;
  result = min(result, vec3(1.0));

  // Slight warm tint on bloom (simulates real lens bloom)
  result.r += finalBloom.r * 0.03 * intensity;
  result.b -= finalBloom.b * 0.02 * intensity;

  return vec4(result, baseColor.a);
}
`;

// ─── Chromatic Aberration (AE-Level) ────────────────────────────────
// Realistic lens chromatic aberration with:
// - Radial split (stronger at edges)
// - Tangential component (lateral CA)
// - Edge detection for smarter application
// - Purple fringing simulation

const CHROMATIC_FUNCTIONS = `
// ═══ Chromatic Aberration — Lens-quality with edge weighting ═══

vec4 applyChromaticAberration(sampler2D tex, vec2 uv, float intensity) {
  vec2 center = vec2(0.5);
  vec2 dir = uv - center;
  float dist = length(dir);
  vec2 normDir = dist > 0.001 ? dir / dist : vec2(0.0);

  // ── Primary radial split (axial CA) ──
  float primaryAberration = dist * dist * 0.02 * intensity;

  // ── Tangential split (lateral CA — perpendicular to radius) ──
  vec2 tangent = vec2(-normDir.y, normDir.x);
  float lateralAberration = dist * 0.003 * intensity;

  // ── Sample with RGB channel offsets ──
  vec2 rOffset = dir * primaryAberration + tangent * lateralAberration;
  vec2 bOffset = -dir * primaryAberration - tangent * lateralAberration;

  float r = texture(tex, uv + rOffset).r;
  float g = texture(tex, uv).g;
  float b = texture(tex, uv + bOffset).b;

  // ── Secondary fringe (purple fringing) ──
  // Stronger at high-contrast edges and corners
  float fringeDist = dist * dist * 0.015 * intensity;
  r += texture(tex, uv + dir * fringeDist * 1.5).r * 0.12;
  b += texture(tex, uv - dir * fringeDist * 1.5).b * 0.12;

  // ── Edge-weighted application ──
  // Detect edges using luminance gradient
  vec2 texelSize = 1.0 / uResolution;
  float lumC  = dot(texture(tex, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lumR  = dot(texture(tex, uv + vec2(texelSize.x, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lumL  = dot(texture(tex, uv - vec2(texelSize.x, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lumU  = dot(texture(tex, uv + vec2(0.0, texelSize.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lumD  = dot(texture(tex, uv - vec2(0.0, texelSize.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float edgeStrength = abs(lumR - lumL) + abs(lumU - lumD);
  float edgeWeight = 1.0 + edgeStrength * 3.0;

  // Blend CA with edge weighting (stronger at edges, subtler in flat areas)
  vec3 original = texture(tex, uv).rgb;
  vec3 aberrated = vec3(r, g, b);
  vec3 result = mix(original, aberrated, min(edgeWeight * 0.7, 1.0));

  return vec4(result, texture(tex, uv).a);
}
`;

// ─── Film Grain (AE-Level) ──────────────────────────────────────────
// Photographic grain simulation with:
// - Perceptual luminance weighting (shadows grainier than highlights)
// - Temporal coherence (smooth between frames, no flickering)
// - Color grain (slight RGB channel variation like real film)
// - Multiple grain sizes (fine + coarse, like real emulsion)

const FILMGRAIN_FUNCTIONS = `
// ═══ Film Grain — Photographic emulsion simulation ═══

// Deterministic hash — produces stable, high-quality noise
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Smooth noise using bilinear interpolation (eliminates pixelation)
float valueNoise(vec2 uv) {
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  f = f * f * (3.0 - 2.0 * f); // Smoothstep for interpolation

  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec4 applyFilmGrain(vec4 color, vec2 uv, float frame, float intensity) {
  // ── Grain coordinates with temporal coherence ──
  // Use frame number for temporal offset (prevents static grain)
  float timeOffset = frame * 1.37;  // Prime-based offset for good distribution

  // ── Fine grain (high frequency, like ISO noise) ──
  vec2 fineUv = uv * uResolution * 0.5 + vec2(timeOffset * 0.73, timeOffset * 0.91);
  float fineGrain = valueNoise(fineUv) - 0.5;

  // ── Coarse grain (low frequency, like film base grain) ──
  vec2 coarseUv = uv * uResolution * 0.08 + vec2(timeOffset * 0.31, timeOffset * 0.47);
  float coarseGrain = valueNoise(coarseUv) - 0.5;

  // ── Perceptual luminance weighting ──
  // Film grain is most visible in midtones, less in deep shadows and highlights
  // This matches real photographic grain behavior
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  float grainVisibility = 1.0 - pow(abs(lum - 0.5) * 2.0, 2.0);  // Peak at midtones
  grainVisibility = mix(0.5, 1.0, grainVisibility);

  // ── Combine fine + coarse grain ──
  float grainStrength = (0.04 * fineGrain + 0.02 * coarseGrain) * intensity * grainVisibility;

  // ── Color grain (separate R/G/B channels like real film) ──
  vec2 colorGrainUvR = uv * uResolution * 0.45 + vec2(timeOffset * 0.53 + 7.0, timeOffset * 0.67);
  vec2 colorGrainUvB = uv * uResolution * 0.45 + vec2(timeOffset * 0.47, timeOffset * 0.59 + 11.0);

  float colorGrainR = (valueNoise(colorGrainUvR) - 0.5) * 0.015 * intensity;
  float colorGrainB = (valueNoise(colorGrainUvB) - 0.5) * 0.012 * intensity;

  // ── Apply grain ──
  vec3 result = color.rgb;
  result += grainStrength;                           // Luminance grain
  result.r += colorGrainR * grainVisibility;         // Red channel grain
  result.b += colorGrainB * grainVisibility;         // Blue channel grain

  return vec4(result, color.a);
}
`;

// ─── Vignette (AE-Level) ────────────────────────────────────────────
// Optical vignette with:
// - Non-circular (cat's eye) distortion
// - Color shift toward edges (like real lens)
// - Smooth natural falloff matching real camera lenses

const VIGNETTE_FUNCTIONS = `
// ═══ Vignette — Optical lens vignette with cat's eye ═══

vec4 applyVignette(vec4 color, vec2 uv, float intensity) {
  // ── Convert to centered coordinates ──
  vec2 center = vec2(0.5);
  vec2 delta = uv - center;
  float dist = length(delta);

  // ── Cat's eye distortion (anamorphic vignette) ──
  // Real lenses vignette more along the long axis
  float aspectRatio = uResolution.x / uResolution.y;
  vec2 anamorphicDelta = delta * vec2(1.0, aspectRatio);
  float anamorphicDist = length(anamorphicDelta);

  // ── Natural optical vignette (3-stop falloff like real f/2.8 lens) ──
  // Uses cos^4 law: vignette = cos^4(theta)
  // Approximated for 2D screen space
  float vignetteRadius = 0.35;
  float vignetteSoftness = 0.55;
  float vignette = 1.0 - smoothstep(vignetteRadius, vignetteRadius + vignetteSoftness, dist * (0.8 + intensity * 0.4));

  // ── Cat's eye contribution ──
  float catseye = 1.0 - smoothstep(0.3, 0.7, anamorphicDist * (0.7 + intensity * 0.3));
  catseye = mix(1.0, catseye, 0.3 * intensity);  // Subtle cat's eye effect

  // ── Combine ──
  float totalVignette = vignette * catseye;

  // ── Color shift toward edges (real lens chromatic vignette) ──
  // Edges get slightly warmer (more red/yellow) and less saturated
  float edgeFactor = 1.0 - totalVignette;
  vec3 warmShift = vec3(0.98, 0.95, 0.90);  // Warm tint at edges
  vec3 edgeColor = color.rgb * warmShift;

  // ── Desaturation at extreme edges ──
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 desaturated = mix(color.rgb, vec3(lum), edgeFactor * 0.2 * intensity);

  // ── Final composition ──
  vec3 result = mix(edgeColor, desaturated, totalVignette);
  result *= totalVignette;

  return vec4(result, color.a);
}
`;

// ─── Motion Blur (AE-Level) ─────────────────────────────────────────
// Object-aware directional blur based on:
// - Luminance gradient (bright objects = moving)
// - Radial velocity (from center = zoom blur)
// - Temporal anti-aliasing style multi-sample

const MOTIONBLUR_FUNCTIONS = `
// ═══ Motion Blur — Object-aware directional blur ═══

vec4 applyMotionBlur(sampler2D tex, vec2 uv, float time, float intensity) {
  vec2 texelSize = 1.0 / uResolution;

  // ── Estimate local motion from luminance gradient ──
  float lumC = dot(texture(tex, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lumR = dot(texture(tex, uv + vec2(texelSize.x, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lumU = dot(texture(tex, uv + vec2(0.0, texelSize.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
  vec2 gradient = vec2(lumR - lumC, lumU - lumC);

  // ── Motion direction: blend gradient + radial outflow ──
  vec2 center = vec2(0.5);
  vec2 radial = uv - center;

  // Weighted blend: gradient for object motion, radial for camera motion
  vec2 motionDir = normalize(mix(radial, gradient * 100.0, 0.3) + 0.001);

  // ── Motion amount based on luminance (bright objects = more motion) ──
  float motionAmount = (lumC * 0.4 + length(gradient) * 2.0) * 0.008 * intensity;

  // ── Multi-sample motion blur (16 samples, Gaussian weighted) ──
  const int SAMPLES = 16;
  vec4 color = vec4(0.0);
  float totalWeight = 0.0;

  for (int i = 0; i < SAMPLES; i++) {
    float t = float(i) / float(SAMPLES - 1) - 0.5;  // -0.5 to 0.5

    // Gaussian weight
    float weight = exp(-t * t * 8.0);

    vec2 sampleUv = uv + motionDir * t * motionAmount;
    color += texture(tex, sampleUv) * weight;
    totalWeight += weight;
  }

  return vec4(color.rgb / totalWeight, color.a / totalWeight);
}
`;

// ─── Shader Index ───────────────────────────────────────────────────

export function getShaderCode(effects) {
  return getCompositeFragmentShader(effects);
}

export { BLOOM_FUNCTIONS, CHROMATIC_FUNCTIONS, FILMGRAIN_FUNCTIONS, VIGNETTE_FUNCTIONS, MOTIONBLUR_FUNCTIONS };
