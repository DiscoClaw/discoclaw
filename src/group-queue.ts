export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  size(): number {
    return this.tails.size;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(
      () => current,
      () => current,
    );
    this.tails.set(key, tail);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
