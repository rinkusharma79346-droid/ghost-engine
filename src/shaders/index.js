/**
 * Ghost Engine — WebGL2 Fragment Shaders
 *
 * All shaders are written as GLSL ES 3.0 fragments that operate on a
 * screen-space texture. They're composed at runtime into a single
 * multi-effect pipeline.
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
// This is the main shader that combines ALL enabled effects in a single
// GPU pass for maximum performance.

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

uniform sampler2D uTexture;       // Page screenshot texture
uniform float uTime;              // Virtual time from performance.now()
uniform float uIntensity;         // Effect intensity 0.0-2.0
uniform vec2 uResolution;        // Video resolution
uniform float uFrame;            // Frame number for deterministic grain

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

  fragColor = color;
}`;
}

// ─── Bloom ───────────────────────────────────────────────────────────
// Multi-sample gaussian bloom with brightness extraction

const BLOOM_FUNCTIONS = `
// Bloom — multi-tap gaussian blur on bright pixels
vec3 sampleBright(sampler2D tex, vec2 uv, float threshold) {
  vec3 col = texture(tex, uv).rgb;
  float brightness = dot(col, vec3(0.2126, 0.7152, 0.0722));
  return col * smoothstep(threshold, threshold + 0.5, brightness);
}

vec4 applyBloom(sampler2D tex, vec2 uv, vec4 baseColor, float intensity) {
  vec2 texelSize = 1.0 / uResolution;

  // Brightness extraction threshold
  float threshold = 0.6;

  // Multi-tap gaussian blur (13 samples) for bloom
  vec3 bloom = vec3(0.0);
  float totalWeight = 0.0;

  // Kernel offsets and weights (gaussian distribution)
  const int KERNEL_SIZE = 7;
  const float offsets[7] = float[](-3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0);
  const float weights[7] = float[](0.015, 0.085, 0.242, 0.316, 0.242, 0.085, 0.015);

  // Horizontal pass
  vec3 hBlur = vec3(0.0);
  for (int i = 0; i < KERNEL_SIZE; i++) {
    vec2 sampleUv = uv + vec2(offsets[i] * texelSize.x * 4.0, 0.0);
    hBlur += sampleBright(tex, sampleUv, threshold) * weights[i];
  }

  // Vertical pass
  vec3 vBlur = vec3(0.0);
  for (int i = 0; i < KERNEL_SIZE; i++) {
    vec2 sampleUv = uv + vec2(0.0, offsets[i] * texelSize.y * 4.0);
    vBlur += sampleBright(tex, sampleUv, threshold) * weights[i];
  }

  bloom = (hBlur + vBlur) * 0.5;

  // Second wider pass for large glow
  vec3 wideBloom = vec3(0.0);
  for (int i = 0; i < KERNEL_SIZE; i++) {
    vec2 sampleUvH = uv + vec2(offsets[i] * texelSize.x * 12.0, 0.0);
    vec2 sampleUvV = uv + vec2(0.0, offsets[i] * texelSize.y * 12.0);
    wideBloom += sampleBright(tex, sampleUvH, threshold * 0.7) * weights[i];
    wideBloom += sampleBright(tex, sampleUvV, threshold * 0.7) * weights[i];
  }
  wideBloom *= 0.5;

  // Combine narrow + wide bloom
  vec3 finalBloom = bloom + wideBloom * 0.4;

  // Screen blend mode
  vec3 result = baseColor.rgb + finalBloom * intensity * 0.8;
  result = min(result, vec3(1.0)); // Clamp

  return vec4(result, baseColor.a);
}
`;

// ─── Chromatic Aberration ───────────────────────────────────────────
// Radial chromatic split with edge detection for smarter application

const CHROMATIC_FUNCTIONS = `
// Chromatic Aberration — radial RGB channel split
vec4 applyChromaticAberration(sampler2D tex, vec2 uv, float intensity) {
  vec2 center = vec2(0.5);
  vec2 dir = uv - center;
  float dist = length(dir);
  float aberration = dist * 0.008 * intensity;

  // Sample R, G, B channels at offset positions
  float r = texture(tex, uv + dir * aberration).r;
  float g = texture(tex, uv).g;
  float b = texture(tex, uv - dir * aberration).b;

  // Add secondary fringe (subtle, wider split)
  float fringe = dist * 0.003 * intensity;
  r += texture(tex, uv + dir * fringe * 2.0).r * 0.15;
  b += texture(tex, uv - dir * fringe * 2.0).b * 0.15;

  vec3 color = vec3(r, g, b);
  float a = texture(tex, uv).a;

  return vec4(color, a);
}
`;

// ─── Film Grain ─────────────────────────────────────────────────────
// Deterministic noise based on frame number (not random per pixel)

const FILMGRAIN_FUNCTIONS = `
// Film Grain — deterministic per-frame noise
float hash(vec2 p) {
  // Deterministic hash based on frame + position
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 applyFilmGrain(vec4 color, vec2 uv, float frame, float intensity) {
  // Use frame number for deterministic grain
  float seed = frame * 0.73 + uv.x * 17.3 + uv.y * 31.7;
  vec2 noiseCoord = vec2(seed, seed * 1.37);

  float noise = hash(noiseCoord) - 0.5;

  // Film grain characteristics:
  // - Luminance-dependent (more visible in shadows)
  // - Subtle color shift in addition to luminance
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  float grainStrength = mix(0.08, 0.03, lum) * intensity;

  // Luminance grain
  vec3 grain = vec3(noise * grainStrength);

  // Subtle color grain (slightly different per channel)
  float noiseR = hash(noiseCoord + vec2(1.0, 0.0)) - 0.5;
  float noiseB = hash(noiseCoord + vec2(0.0, 1.0)) - 0.5;
  grain.r += noiseR * grainStrength * 0.3;
  grain.b += noiseB * grainStrength * 0.3;

  return vec4(color.rgb + grain, color.a);
}
`;

// ─── Vignette ───────────────────────────────────────────────────────
// Smooth radial darkening toward edges

const VIGNETTE_FUNCTIONS = `
// Vignette — cinematic edge darkening
vec4 applyVignette(vec4 color, vec2 uv, float intensity) {
  vec2 center = vec2(0.5);
  float dist = distance(uv, center);

  // Smooth cubic falloff
  float vignette = 1.0 - smoothstep(0.3, 0.9, dist * (1.0 + intensity * 0.3));

  // Slight warm tint in shadow edges
  vec3 tint = mix(vec3(0.95, 0.9, 0.85), vec3(1.0), vignette);

  return vec4(color.rgb * vignette * tint, color.a);
}
`;

// ─── Motion Blur ────────────────────────────────────────────────────
// Directional blur based on velocity (uses time delta for direction)

const MOTIONBLUR_FUNCTIONS = `
// Motion Blur — velocity-based directional blur
vec4 applyMotionBlur(sampler2D tex, vec2 uv, float time, float intensity) {
  vec4 color = vec4(0.0);
  float totalWeight = 0.0;

  // Number of motion samples (more = smoother but slower)
  const int SAMPLES = 8;

  // Motion direction: subtle radial outwards from center
  vec2 center = vec2(0.5);
  vec2 motionDir = normalize(uv - center + 0.001);

  // Motion amount based on distance from center
  float motionAmount = length(uv - center) * 0.006 * intensity;

  for (int i = 0; i < SAMPLES; i++) {
    float t = float(i) / float(SAMPLES - 1) - 0.5; // -0.5 to 0.5
    vec2 sampleUv = uv + motionDir * t * motionAmount;

    // Weight: gaussian-like, center is strongest
    float weight = 1.0 - abs(t) * 1.5;
    weight = max(weight, 0.1);

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
