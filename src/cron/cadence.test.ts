import { describe, expect, it } from 'vitest';
import { detectCadence } from './cadence.js';

describe('detectCadence', () => {
  it('detects frequent for wildcard minute', () => {
    expect(detectCadence('* * * * *')).toBe('frequent');
  });

  it('detects frequent for step minute', () => {
    expect(detectCadence('*/5 * * * *')).toBe('frequent');
    expect(detectCadence('*/15 * * * *')).toBe('frequent');
  });

  it('detects hourly for specific minute + wildcard hour', () => {
    expect(detectCadence('0 * * * *')).toBe('hourly');
    expect(detectCadence('30 * * * *')).toBe('hourly');
  });

  it('detects daily for specific minute + hour', () => {
    expect(detectCadence('0 7 * * *')).toBe('daily');
    expect(detectCadence('30 12 * * *')).toBe('daily');
  });

  it('detects weekly for specific dow', () => {
    expect(detectCadence('0 7 * * 1-5')).toBe('weekly');
    expect(detectCadence('0 9 * * 1')).toBe('weekly');
    expect(detectCadence('0 0 * * 0')).toBe('weekly');
  });

  it('detects monthly for specific dom', () => {
    expect(detectCadence('0 7 1 * *')).toBe('monthly');
    expect(detectCadence('0 0 15 * *')).toBe('monthly');
  });

  it('returns daily for invalid schedule', () => {
    expect(detectCadence('not a cron')).toBe('daily');
  });

  it('returns daily for empty string', () => {
    expect(detectCadence('')).toBe('daily');
  });

  it('handles complex schedules', () => {
    expect(detectCadence('0 7,19 * * *')).toBe('daily');
    expect(detectCadence('0 7 * * 1,3,5')).toBe('weekly');
  });
});
