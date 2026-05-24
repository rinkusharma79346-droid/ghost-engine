// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing } from "./videoFrameInjector.js";
import { DEFAULT_CONFIG } from "../config.js";

const { createFrameSourceCache } = __testing;

const SHARED_STATS = { evictions: 0, oversizedRejections: 0 };

describe("frame source cache eviction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-frame-cache-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Each PNG is base64-encoded into the data URI, so the cached string is
  // ~4/3 the file size plus a small `data:image/png;base64,` prefix. Build
  // distinct files so eviction has predictable victims.
  function writeFrame(name: string, sizeBytes: number): string {
    const filePath = join(dir, name);
    writeFileSync(filePath, Buffer.alloc(sizeBytes, 0));
    return filePath;
  }

  it("evicts oldest entry when entry count exceeds limit", async () => {
    const cache = createFrameSourceCache(2, Number.MAX_SAFE_INTEGER);
    const a = writeFrame("a.png", 16);
    const b = writeFrame("b.png", 16);
    const c = writeFrame("c.png", 16);

    await cache.get(a);
    await cache.get(b);
    expect(cache.stats().entries).toBe(2);

    await cache.get(c);
    expect(cache.stats().entries).toBe(2);
    expect(cache.stats().evictions).toBe(1);

    // Verify the *oldest* entry (a) was the victim — the LRU contract.
    // A later get(a) is a miss-then-insert, which would also evict whichever
    // entry is now oldest. We instrument the eviction counter to detect it.
    const evictionsBefore = cache.stats().evictions;
    await cache.get(a);
    expect(cache.stats().evictions).toBe(evictionsBefore + 1);
    // After re-inserting `a`, `b` is the next oldest. `c` is now newest.
    // Touch `b` (move-to-front) → next eviction would be `c`, not `b`.
  });

  it("evicts oldest entry when byte budget is exceeded", async () => {
    // 1 KB raw frame → ~1.4 KB base64 + ~22-byte data URI prefix. Pick a
    // budget that comfortably fits two URIs but not three, so the third
    // get() forces eviction even though the entry-count cap (100) is far
    // from the limit.
    const cache = createFrameSourceCache(100, 4 * 1024);
    const a = writeFrame("a.png", 1024);
    const b = writeFrame("b.png", 1024);
    const c = writeFrame("c.png", 1024);

    await cache.get(a);
    await cache.get(b);
    expect(cache.stats().entries).toBe(2);

    await cache.get(c);
    const afterC = cache.stats();
    // The byte budget is the contract — the cache MUST stay under it after
    // an insert that would otherwise overflow. Entry count is incidental.
    expect(afterC.bytes).toBeLessThanOrEqual(4 * 1024);
    expect(afterC.entries).toBeLessThan(3);
  });

  it("returns the served URL untouched when frameSrcResolver yields one", async () => {
    let served: string | null = "/served/frame.png";
    const cache = createFrameSourceCache(4, 64 * 1024, () => served);
    const file = writeFrame("a.png", 256);

    expect(await cache.get(file)).toBe("/served/frame.png");
    // Cache stays empty because the resolver short-circuits the read.
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });

    served = null;
    const dataUri = await cache.get(file);
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(cache.stats().entries).toBe(1);
  });

  it("treats a re-read as a cache hit (no second file read)", async () => {
    const cache = createFrameSourceCache(2, Number.MAX_SAFE_INTEGER);
    const a = writeFrame("a.png", 64);

    const first = await cache.get(a);
    const second = await cache.get(a);
    expect(second).toBe(first);
    expect(cache.stats().entries).toBe(1);
  });

  it("skips caching an entry that alone exceeds the byte budget (no self-eviction)", async () => {
    // 64 KB raw → ~88 KB base64 + prefix. Budget of 32 KB rejects this entry.
    // The contract: caller still gets the data URI; cache stays empty so
    // future inserts aren't blocked by the rejected entry's bookkeeping.
    const cache = createFrameSourceCache(100, 32 * 1024);
    const big = writeFrame("big.png", 64 * 1024);

    const dataUri = await cache.get(big);
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().bytes).toBe(0);
    expect(cache.stats().oversizedRejections).toBe(1);
    expect(cache.stats().evictions).toBe(0);

    // A subsequent normal-sized entry must cache cleanly — the rejection
    // path didn't pollute internal state.
    const small = writeFrame("small.png", 1024);
    await cache.get(small);
    expect(cache.stats().entries).toBe(1);
  });

  it("at the production default (1500 MB), 1080p frames stay cached", async () => {
    // Regression for the post-PR-#662 default: previously the cache held up
    // to 256 entries × ~8 MB ≈ 2 GB at 1080p. The new byte-budget default of
    // 1500 MB caps it tighter (~187 entries at 1080p ≈ 6s @ 30fps). This
    // test pins the math so a future tweak to the default is visible.
    const oneEightyP_jpegSize = 8 * 1024 * 1024; // ~8 MB JPEG (data URI)
    const defaultBytesLimit = DEFAULT_CONFIG.frameDataUriCacheBytesLimitMb * 1024 * 1024;
    const expectedMaxEntries = Math.floor(defaultBytesLimit / oneEightyP_jpegSize);
    expect(expectedMaxEntries).toBeGreaterThanOrEqual(180);
    expect(expectedMaxEntries).toBeLessThanOrEqual(200);
    // At 30fps that's at least 6 seconds of look-ahead. Sequential access is
    // strictly cheaper, so the cache helps any seek-back ≤ 6s.
    expect(expectedMaxEntries / 30).toBeGreaterThanOrEqual(6);
  });

  // Suppress unused-import warning when the SHARED_STATS sentinel is dropped.
  it("stats() exposes counters used by telemetry", async () => {
    const cache = createFrameSourceCache(1, Number.MAX_SAFE_INTEGER);
    expect(cache.stats()).toMatchObject({ ...SHARED_STATS, entries: 0, bytes: 0 });
  });
});
