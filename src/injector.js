/**
 * Ghost Engine — Composition Injector (Additive Effects Only)
 *
 * Injects ADDITIVE overlay effects into the composition HTML that
 * enhance the scene without needing to read the page content.
 * These effects COMPOSITE ON TOP of the existing composition:
 *
 * - Particle systems (Canvas2D)
 * - Light leaks / volumetric light
 * - Energy rings / pulse waves
 * - Glow overlays (CSS blur + screen blend)
 *
 * For full-frame effects (bloom, chromatic aberration, film grain, vignette),
 * use the GPU post-processor (Pass 2) which operates on captured frames.
 *
 * This injection is optional — it adds extra visual elements to the scene.
 * The main quality improvement comes from the GPU post-processing pipeline.
 */

import { readFileSync, writeFileSync } from "fs";
import consola from "consola";

// ─── Main Injection Function ────────────────────────────────────────

export async function injectPostProcessing(inputPath, outputPath, options = {}) {
  const {
    effects = [],  // Additive effects: particles, lightleaks, energyrings
    intensity = 1.0,
    width = 1920,
    height = 1080,
  } = options;

  // Filter to only additive effects (not full-frame effects)
  const additiveEffects = effects.filter(e =>
    ["particles", "lightleaks", "energyrings", "glow"].includes(e)
  );

  if (additiveEffects.length === 0) {
    // No additive effects to inject — just copy file
    if (inputPath !== outputPath) {
      const html = readFileSync(inputPath, "utf-8");
      writeFileSync(outputPath, html, "utf-8");
    }
    consola.info("No additive effects to inject (full-frame effects applied in Pass 2)");
    return;
  }

  let html = readFileSync(inputPath, "utf-8");
  const injectionBlock = buildAdditiveEffectsBlock({ effects: additiveEffects, intensity, width, height });

  if (html.includes("</body>")) {
    html = html.replace("</body>", `${injectionBlock}\n</body>`);
  } else {
    html += `\n${injectionBlock}`;
  }

  writeFileSync(outputPath, html, "utf-8");
  consola.info(`Injected additive effects: ${additiveEffects.join(", ")}`);
}

// ─── Build Additive Effects Block ───────────────────────────────────

function buildAdditiveEffectsBlock({ effects, intensity, width, height }) {
  const parts = [];

  // Glow overlay (CSS blur + screen blend)
  if (effects.includes("glow")) {
    parts.push(buildGlowOverlay());
  }

  // Canvas2D particle system
  if (effects.includes("particles")) {
    parts.push(buildParticleSystem({ intensity, width, height }));
  }

  // Light leaks
  if (effects.includes("lightleaks")) {
    parts.push(buildLightLeaks({ intensity, width, height }));
  }

  // Energy rings
  if (effects.includes("energyrings")) {
    parts.push(buildEnergyRings({ intensity, width, height }));
  }

  return `
<!-- ═══════════════════════════════════════════════════════════════
     GHOST ENGINE v1.0 — Additive Overlay Effects
     Effects: ${effects.join(", ")} | Intensity: ${intensity}
     ═══════════════════════════════════════════════════════════════ -->
${parts.join("\n")}
<!-- ═════════════════════════════ END GHOST ENGINE ADDITIVE ═════ -->`;
}

// ─── Glow Overlay ───────────────────────────────────────────────────

function buildGlowOverlay() {
  return `
<style>
  .ghost-glow-layer {
    position: fixed;
    top: 0; left: 0;
    width: 100vw; height: 100vh;
    z-index: 999998;
    pointer-events: none;
    filter: blur(20px) brightness(1.5);
    mix-blend-mode: screen;
    opacity: 0.3;
  }
</style>
<div class="ghost-glow-layer">
  <!-- Duplicated scene content creates a bloom-like glow via CSS blur -->
  <!-- This is lightweight compared to GPU bloom but adds atmosphere -->
</div>`;
}

// ─── Particle System ────────────────────────────────────────────────

function buildParticleSystem({ intensity, width, height }) {
  return `
<canvas id="ghost-particles" width="${width}" height="${height}"
  style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999997;pointer-events:none;mix-blend-mode:screen;"></canvas>
<script>
(function(){
  const c=document.getElementById('ghost-particles');
  const ctx=c.getContext('2d');
  const W=${width},H=${height};
  const INTENSITY=${intensity};
  const COUNT=Math.round(200*INTENSITY);
  const particles=[];

  // Initialize particles with deterministic positions
  for(let i=0;i<COUNT;i++){
    particles.push({
      x:(i*7919+1)%W,
      y:(i*6271+1)%H,
      vx:((i*3571)%100-50)*0.02*INTENSITY,
      vy:((i*2143)%100-50)*0.02*INTENSITY,
      r:((i*1321)%100)*0.04+0.5,
      a:((i*4219)%100)*0.005+0.01,
      hue:(i*137.5)%360,
    });
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    const t=performance.now()*0.001;

    for(const p of particles){
      p.x+=p.vx;
      p.y+=p.vy;
      if(p.x<0)p.x=W; if(p.x>W)p.x=0;
      if(p.y<0)p.y=H; if(p.y>H)p.y=0;

      const pulse=0.5+0.5*Math.sin(t*2+p.hue);
      const alpha=p.a*(0.5+pulse*0.5);

      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle='hsla('+p.hue+',100%,70%,'+alpha+')';
      ctx.fill();

      // Glow
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r*4,0,Math.PI*2);
      ctx.fillStyle='hsla('+p.hue+',100%,60%,'+(alpha*0.15)+')';
      ctx.fill();
    }

    if(window.__hf&&typeof window.__hf.seek==='function'){
      // HyperFrames mode — requestAnimationFrame is controlled by seek
    } else {
      requestAnimationFrame(draw);
    }
  }

  // Hook into HyperFrames seek
  if(window.__hf){
    const origSeek=window.__hf.seek.bind(window.__hf);
    window.__hf.seek=function(t){
      origSeek(t);
      draw();
    };
  }

  draw();
})();
</script>`;
}

// ─── Light Leaks ────────────────────────────────────────────────────

function buildLightLeaks({ intensity, width, height }) {
  return `
<canvas id="ghost-lightleaks" width="${width}" height="${height}"
  style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999996;pointer-events:none;mix-blend-mode:screen;opacity:${0.4*intensity};"></canvas>
<script>
(function(){
  const c=document.getElementById('ghost-lightleaks');
  const ctx=c.getContext('2d');
  const W=${width},H=${height};

  const leaks=[
    {x:0,y:0,r:W*0.4,hue:30,drift:0.3},
    {x:W,y:H,r:W*0.35,hue:220,drift:0.5},
    {x:W*0.5,y:0,r:W*0.3,hue:50,drift:0.2},
  ];

  function draw(){
    ctx.clearRect(0,0,W,H);
    const t=performance.now()*0.001;

    for(const l of leaks){
      const ox=Math.sin(t*l.drift)*W*0.1;
      const oy=Math.cos(t*l.drift*0.7)*H*0.05;
      const pulse=0.6+0.4*Math.sin(t*0.5+l.drift*10);

      const grad=ctx.createRadialGradient(l.x+ox,l.y+oy,0,l.x+ox,l.y+oy,l.r*pulse);
      grad.addColorStop(0,'hsla('+l.hue+',100%,80%,0.3)');
      grad.addColorStop(0.5,'hsla('+l.hue+',80%,50%,0.1)');
      grad.addColorStop(1,'hsla('+l.hue+',60%,30%,0)');

      ctx.fillStyle=grad;
      ctx.fillRect(0,0,W,H);
    }

    if(window.__hf&&typeof window.__hf.seek==='function'){}else{requestAnimationFrame(draw);}
  }

  if(window.__hf){
    const origSeek=window.__hf.seek.bind(window.__hf);
    window.__hf.seek=function(t){origSeek(t);draw();};
  }

  draw();
})();
</script>`;
}

// ─── Energy Rings ───────────────────────────────────────────────────

function buildEnergyRings({ intensity, width, height }) {
  return `
<canvas id="ghost-rings" width="${width}" height="${height}"
  style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999995;pointer-events:none;mix-blend-mode:screen;"></canvas>
<script>
(function(){
  const c=document.getElementById('ghost-rings');
  const ctx=c.getContext('2d');
  const W=${width},H=${height};
  const CX=W/2,CY=H/2;
  const INTENSITY=${intensity};

  function draw(){
    ctx.clearRect(0,0,W,H);
    const t=performance.now()*0.001;

    // Concentric ring pulses
    for(let i=0;i<3;i++){
      const phase=t*0.5+i*2.1;
      const radius=((phase%6)/6)*Math.max(W,H)*0.6;
      const alpha=Math.max(0,1-phase%6/6)*0.3*INTENSITY;

      ctx.beginPath();
      ctx.arc(CX,CY,radius,0,Math.PI*2);
      ctx.strokeStyle='hsla('+(200+i*40)+',100%,70%,'+alpha+')';
      ctx.lineWidth=2+alpha*4;
      ctx.stroke();
    }

    if(window.__hf&&typeof window.__hf.seek==='function'){}else{requestAnimationFrame(draw);}
  }

  if(window.__hf){
    const origSeek=window.__hf.seek.bind(window.__hf);
    window.__hf.seek=function(t){origSeek(t);draw();};
  }

  draw();
})();
</script>`;
}
