import { describe, expect, it } from 'vitest';
import { renderDashboardPage } from './page.js';

describe('renderDashboardPage', () => {
  it('renders user-friendly doctor controls and guidance', () => {
    const html = renderDashboardPage();

    expect(html).toContain('Discoclaw Control Panel');
    expect(html).toContain('>Refresh<');
    expect(html).toContain('Check service health, review current settings, and make common changes from one local dashboard.');
    expect(html).toContain('This dashboard stays local by default.');
    expect(html).toContain('Runtime overrides: loading');
    expect(html).toContain('Dashboard URL: loading');
    expect(html).toContain('function formatServicePill');
    expect(html).toContain('function formatRuntimePill');
    expect(html).toContain('const ROLE_LABELS = {');
    expect(html).toContain("chat: 'Chat'");
    expect(html).toContain("fast: 'Quick Tasks'");
    expect(html).toContain('const ROLE_HELP = {');
    expect(html).toContain("function formatModelOptionLabel(role, model)");
    expect(html).toContain('<select id="role-select"');
    expect(html).toContain('<select id="model-select"');
    expect(html).not.toContain('custom-model-input');
    expect(html).not.toContain('CUSTOM_MODEL_OPTION');
    expect(html).toContain('Choose a role, then pick one of the valid saved options for that role.');
    expect(html).toContain('id="model-form-help"');
    expect(html).toContain('Pick one of the valid saved options for this role.');
    expect(html).toContain('>Save Model<');
    expect(html).toContain("button.textContent = 'Change';");
    expect(html).toContain('Scan for config problems and cleanup suggestions.');
    expect(html).toContain('Safe fixes can be applied automatically; review-only items stay listed below.');
    expect(html).toContain('>Scan<');
    expect(html).toContain('>Apply Safe Fixes<');
    expect(html).toContain('id="doctor-fix-btn" type="button" disabled');
    expect(html).toContain('id="doctor-helper"');
    expect(html).toContain('Cleanup suggestions');
    expect(html).toContain('manual cleanup');
    expect(html).toContain('safe auto-fix');
  });
});
