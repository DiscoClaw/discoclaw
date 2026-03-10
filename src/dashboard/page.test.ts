import { describe, expect, it } from 'vitest';
import { renderDashboardPage } from './page.js';

describe('renderDashboardPage', () => {
  it('renders user-friendly doctor controls and guidance', () => {
    const html = renderDashboardPage();

    expect(html).toContain('Discoclaw Control Panel');
    expect(html).toContain('>Refresh<');
    expect(html).toContain('Check service health, review settings, and make common changes from one place.');
    expect(html).toContain('This dashboard stays local by default.');
    expect(html).toContain('Runtime overrides: loading');
    expect(html).toContain('function formatServicePill');
    expect(html).toContain('function formatRuntimePill');
    expect(html).toContain('<select id="role-select"');
    expect(html).toContain('<select id="model-select"');
    expect(html).toContain("appendSelectOption(modelSelect, CUSTOM_MODEL_VALUE, '(custom)');");
    expect(html).toContain('Scan for config problems and cleanup suggestions.');
    expect(html).toContain('Safe fixes can be applied automatically; review-only items stay listed for manual cleanup.');
    expect(html).toContain('>Scan Now<');
    expect(html).toContain('>Apply Safe Fixes<');
    expect(html).toContain('id="doctor-fix-btn" type="button" disabled');
    expect(html).toContain('id="doctor-helper"');
    expect(html).toContain('Cleanup suggestions');
    expect(html).toContain('manual cleanup');
    expect(html).toContain('safe auto-fix');
  });
});
