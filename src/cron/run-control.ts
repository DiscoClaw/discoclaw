export class CronRunControl {
  private cancelers = new Map<string, () => void>();

  register(jobId: string, cancel: () => void): void {
    this.cancelers.set(jobId, cancel);
  }

  clear(jobId: string, cancel?: () => void): void {
    const current = this.cancelers.get(jobId);
    if (!current) return;
    if (!cancel || current === cancel) {
      this.cancelers.delete(jobId);
    }
  }

  requestCancel(jobId: string): boolean {
    const cancel = this.cancelers.get(jobId);
    if (!cancel) return false;
    cancel();
    return true;
  }

  has(jobId: string): boolean {
    return this.cancelers.has(jobId);
  }
}
