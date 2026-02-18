export type MemoryStats = {
  /** Current RSS in bytes */
  rssBytes: number;
  /** Current heap used in bytes */
  heapUsedBytes: number;
  /** Current heap total in bytes */
  heapTotalBytes: number;
  /** External (C++ objects bound to V8) in bytes */
  externalBytes: number;
  /** High-water mark RSS seen since sampler start */
  rssHwmBytes: number;
  /** High-water mark heap used seen since sampler start */
  heapUsedHwmBytes: number;
  /** Number of samples taken */
  sampleCount: number;
};

export type MemoryUsageSource = () => NodeJS.MemoryUsage;

export class MemorySampler {
  private rssHwm = 0;
  private heapUsedHwm = 0;
  private count = 0;
  private readonly source: MemoryUsageSource;

  constructor(source: MemoryUsageSource = process.memoryUsage) {
    this.source = source;
  }

  /** Take a sample and update high-water marks. Returns current stats. */
  sample(): MemoryStats {
    const usage = this.source();
    this.count++;
    if (usage.rss > this.rssHwm) this.rssHwm = usage.rss;
    if (usage.heapUsed > this.heapUsedHwm) this.heapUsedHwm = usage.heapUsed;
    return this.current(usage);
  }

  /** Read current stats without updating counters or HWMs. */
  peek(): MemoryStats {
    return this.current(this.source());
  }

  /** Reset high-water marks and sample count. */
  reset(): void {
    this.rssHwm = 0;
    this.heapUsedHwm = 0;
    this.count = 0;
  }

  private current(usage: NodeJS.MemoryUsage): MemoryStats {
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      externalBytes: usage.external,
      rssHwmBytes: Math.max(this.rssHwm, usage.rss),
      heapUsedHwmBytes: Math.max(this.heapUsedHwm, usage.heapUsed),
      sampleCount: this.count,
    };
  }
}

/** Format bytes as a human-readable MiB string, e.g. "42.1 MiB" */
export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Render a one-line memory summary suitable for `!health verbose`. */
export function renderMemoryLine(stats: MemoryStats): string {
  return (
    `Memory: rss=${formatMiB(stats.rssBytes)} heapUsed=${formatMiB(stats.heapUsedBytes)}` +
    ` heapTotal=${formatMiB(stats.heapTotalBytes)}` +
    ` hwm(rss=${formatMiB(stats.rssHwmBytes)} heap=${formatMiB(stats.heapUsedHwmBytes)})` +
    ` samples=${stats.sampleCount}`
  );
}
