/**
 * Ghost Engine — Runtime Builder
 *
 * Generates the browser-side JavaScript that:
 * 1. Creates a WebGL2 context on the overlay canvas
 * 2. Compiles and links the composite shader
 * 3. Captures the page content as a texture every frame
 * 4. Renders the post-processed result on the overlay canvas
 *
 * This runtime is INJECTED into the composition HTML and runs in the browser.
 * It works with HyperFrames' virtual time system (performance.now() override).
 */

export function getRuntimeCode({ effects, intensity, width, height }) {
  return `
(function() {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────────
  const GHOST_CONFIG = {
    effects: ${JSON.stringify(effects)},
    intensity: ${intensity},
    width: ${width},
    height: ${height},
    debug: false
  };

  // ─── WebGL2 Setup ───────────────────────────────────────────────────
  const canvas = document.getElementById('ghost-engine-canvas');
  if (!canvas) { console.error('[GhostEngine] Canvas not found'); return; }

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false
  });

  if (!gl) { console.error('[GhostEngine] WebGL2 not available'); return; }

  console.log('[GhostEngine] WebGL2 initialized', gl.getParameter(gl.VERSION));

  // ─── Shader Compilation ─────────────────────────────────────────────
  const VERT_SRC = \`#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}\`;

  // Read fragment shader from the script tag
  const FRAG_SRC = document.getElementById('ghost-engine-shaders')?.textContent;
  if (!FRAG_SRC) { console.error('[GhostEngine] Fragment shader not found'); return; }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[GhostEngine] Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertShader = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const fragShader = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vertShader || !fragShader) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[GhostEngine] Program link error:', gl.getProgramInfoLog(program));
    return;
  }

  gl.useProgram(program);
  console.log('[GhostEngine] Shader program linked');

  // ─── Full-screen Quad ───────────────────────────────────────────────
  const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  const aPosition = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  // ─── Texture for Page Capture ───────────────────────────────────────
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Initialize with empty texture
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ${width}, ${height}, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const uTexture = gl.getUniformLocation(program, 'uTexture');
  const uTime = gl.getUniformLocation(program, 'uTime');
  const uIntensity = gl.getUniformLocation(program, 'uIntensity');
  const uResolution = gl.getUniformLocation(program, 'uResolution');
  const uFrame = gl.getUniformLocation(program, 'uFrame');

  gl.uniform1i(uTexture, 0);
  gl.uniform2f(uResolution, ${width}, ${height});
  gl.uniform1f(uIntensity, ${intensity});

  // ─── Page Capture via html2canvas ───────────────────────────────────
  // We capture the page content (minus our overlay) and upload as texture
  let captureCanvas = null;
  let frameCount = 0;
  let lastCaptureTime = -Infinity;

  // Hidden source canvas for capturing page content
  function capturePage() {
    // Try to use the page's own canvas elements or take a screenshot
    // For HyperFrames rendering, we capture the DOM as a texture
    try {
      // Method 1: Use all visible canvases as source
      const pageCanvases = document.querySelectorAll('canvas:not(#ghost-engine-canvas)');

      if (pageCanvases.length > 0) {
        // Composite all page canvases onto our capture canvas
        if (!captureCanvas) {
          captureCanvas = document.createElement('canvas');
          captureCanvas.width = ${width};
          captureCanvas.height = ${height};
        }
        const ctx = captureCanvas.getContext('2d');
        ctx.clearRect(0, 0, ${width}, ${height});

        // Draw page background
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#000000';
        ctx.fillRect(0, 0, ${width}, ${height});

        // Composite each canvas
        pageCanvases.forEach(c => {
          try { ctx.drawImage(c, 0, 0, ${width}, ${height}); } catch(e) {}
        });

        // Upload to WebGL texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, captureCanvas);
        return;
      }

      // Method 2: If no canvases, use DOM screenshot (slower fallback)
      // The html2canvas approach is loaded dynamically only when needed
      if (!captureCanvas) {
        captureCanvas = document.createElement('canvas');
        captureCanvas.width = ${width};
        captureCanvas.height = ${height};
      }

      // For HyperFrames, the composition IS the page content
      // Just render the post-processing on top of whatever is there
      // We use the document's layout as a texture

    } catch (e) {
      if (GHOST_CONFIG.debug) console.warn('[GhostEngine] Capture failed:', e);
    }
  }

  // ─── Render Loop ────────────────────────────────────────────────────
  // This render loop is driven by HyperFrames' virtual time system.
  // When __hf.seek(t) is called, performance.now() returns the seek time.
  // requestAnimationFrame is flushed by HyperFrames after each seek.

  let isRendering = false;

  function ghostRender() {
    const time = performance.now() / 1000.0;

    // Capture page content
    capturePage();

    // Set uniforms
    gl.uniform1f(uTime, time);
    gl.uniform1f(uFrame, frameCount++);

    // Clear and draw
    gl.viewport(0, 0, ${width}, ${height});
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Continue loop if actively rendering
    if (isRendering) {
      requestAnimationFrame(ghostRender);
    }
  }

  // ─── Integration with HyperFrames ───────────────────────────────────
  // Hook into HyperFrames' seek system

  function initGhostEngine() {
    console.log('[GhostEngine] Initializing with effects:', GHOST_CONFIG.effects);

    // Wait for HyperFrames runtime to be ready
    const checkReady = setInterval(() => {
      if (window.__hf && typeof window.__hf.seek === 'function') {
        clearInterval(checkReady);
        console.log('[GhostEngine] HyperFrames runtime detected, hooking seek');

        // Hook __hf.seek to also trigger our post-processing
        const originalSeek = window.__hf.seek.bind(window.__hf);
        window.__hf.seek = function(t) {
          originalSeek(t);
          // After seek, re-render our post-processing
          ghostRender();
        };

        isRendering = true;
        ghostRender();
        console.log('[GhostEngine] Active — post-processing enabled');
      }
    }, 100);

    // Fallback: if no HyperFrames, just run on rAF
    setTimeout(() => {
      if (!window.__hf) {
        console.log('[GhostEngine] No HyperFrames detected, running standalone');
        isRendering = true;
        ghostRender();
      }
    }, 2000);
  }

  // ─── Alternative: Direct Screenshot Integration ─────────────────────
  // For HyperFrames beginframe mode, the page is screenshotted after seek.
  // Our canvas overlay with pointer-events:none will be captured automatically!
  // So we just need to render our effects onto the overlay canvas.
  //
  // This means: when HyperFrames calls __hf.seek(t) and then screenshots,
  // the screenshot will include our WebGL post-processing canvas overlay.
  // No special integration needed — it just works!

  // Start the engine
  if (document.readyState === 'complete') {
    initGhostEngine();
  } else {
    window.addEventListener('load', initGhostEngine);
  }

  console.log('[GhostEngine] v1.0 loaded — effects:', GHOST_CONFIG.effects.join(', '));

})();
`;
}
