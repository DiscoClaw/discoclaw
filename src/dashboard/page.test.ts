import { describe, expect, it } from 'vitest';
import { renderDashboardPage } from './page.js';

describe('renderDashboardPage', () => {
  it('renders dashboard with all key sections and controls', () => {
    const html = renderDashboardPage();

    expect(html).toContain('<title>Dashboard</title>');
    expect(html).toContain('Discoclaw');
    expect(html).toContain('>Refresh<');
    expect(html).toContain('Dashboard: loading');
    expect(html).toContain('function formatServicePill');
    expect(html).toContain('function updateDashboardLocation()');
    expect(html).toContain("document.title = 'Dashboard");
    expect(html).toContain('const ROLE_LABELS = {');
    expect(html).toContain("chat: 'Chat'");
    expect(html).toContain("fast: 'Quick Tasks'");
    expect(html).toContain('const ROLE_HELP = {');
    expect(html).toContain("function formatModelOptionLabel(role, model)");
    expect(html).toContain('<select id="role-select"');
    expect(html).toContain('<select id="model-select"');
    expect(html).not.toContain('custom-model-input');
    expect(html).not.toContain('CUSTOM_MODEL_OPTION');
    expect(html).toContain('>Readiness<');
    expect(html).toContain('>Service<');
    expect(html).toContain('>Current Models<');
    expect(html).toContain('>Config Doctor<');
    expect(html).toContain('>Advanced<');
    expect(html).toContain('id="model-form-help"');
    expect(html).toContain('Choose one of the valid saved options below.');
    expect(html).toContain('>Scan<');
    expect(html).toContain('>Apply Safe Fixes<');
    expect(html).toContain('id="doctor-fix-btn" type="button" disabled');
    expect(html).toContain('id="doctor-helper"');
    expect(html).toContain('<select id="preset-select"');
    expect(html).toContain('id="preset-apply-btn"');
    expect(html).toContain('>Apply Preset<');
    expect(html).toContain('id="preset-status"');
    expect(html).toContain('Runtime Preset');
    expect(html).toContain('presetSelect.value = snapshot.primaryRuntime');
    expect(html).toContain('id="mcp-summary"');
    expect(html).toContain('id="mcp-servers"');
    expect(html).toContain('safe auto-fix');
    expect(html).toContain('status-dot');
    expect(html).toContain('btn-danger');
    expect(html).toContain('chat-forms');
  });
});
