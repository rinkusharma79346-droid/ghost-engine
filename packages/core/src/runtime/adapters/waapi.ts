import type { RuntimeDeterministicAdapter } from "../types";
import { swallow } from "../diagnostics";

export function createWaapiAdapter(): RuntimeDeterministicAdapter {
  return {
    name: "waapi",
    discover: () => {},
    seek: (ctx) => {
      if (!document.getAnimations) return;
      const timeMs = Math.max(0, (Number(ctx.time) || 0) * 1000);
      for (const animation of document.getAnimations()) {
        try {
          animation.currentTime = timeMs;
        } catch (err) {
          // ignore animations that reject currentTime writes
          swallow("runtime.adapters.waapi.site1", err);
        }
        try {
          animation.pause();
        } catch (err) {
          // infinite unresolved animations can throw here until currentTime resolves
          swallow("runtime.adapters.waapi.site2", err);
        }
      }
    },
    pause: () => {
      if (!document.getAnimations) return;
      for (const animation of document.getAnimations()) {
        try {
          animation.pause();
        } catch (err) {
          // ignore animation edge-cases
          swallow("runtime.adapters.waapi.site3", err);
        }
      }
    },
  };
}
