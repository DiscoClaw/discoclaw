import { describe, expect, it, vi } from 'vitest';
import { CronRunControl } from './run-control.js';

describe('CronRunControl', () => {
  it('registers and cancels a running job', () => {
    const control = new CronRunControl();
    const cancel = vi.fn();
    control.register('job-1', cancel);

    expect(control.has('job-1')).toBe(true);
    expect(control.requestCancel('job-1')).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('clear with mismatched cancel function is ignored', () => {
    const control = new CronRunControl();
    const cancel = vi.fn();
    control.register('job-1', cancel);

    control.clear('job-1', () => {});
    expect(control.has('job-1')).toBe(true);
  });

  it('clear removes registered cancel function', () => {
    const control = new CronRunControl();
    const cancel = vi.fn();
    control.register('job-1', cancel);

    control.clear('job-1', cancel);
    expect(control.has('job-1')).toBe(false);
    expect(control.requestCancel('job-1')).toBe(false);
  });
});
