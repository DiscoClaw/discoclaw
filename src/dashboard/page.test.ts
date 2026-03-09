import { describe, expect, it } from 'vitest';
import { renderDashboardPage } from './page.js';

describe('renderDashboardPage', () => {
  it('renders user-friendly doctor controls and guidance', () => {
    const html = renderDashboardPage();

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
