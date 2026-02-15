import type { RuntimeAdapter } from './types.js';

export class RuntimeRegistry {
  private adapters = new Map<string, RuntimeAdapter>();

  register(name: string, adapter: RuntimeAdapter): void {
    this.adapters.set(name, adapter);
  }

  get(name: string): RuntimeAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }
}
