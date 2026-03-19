import { describe, expect, it } from 'vitest';
import { renderCanvasShellHtml } from './shell.js';

describe('renderCanvasShellHtml', () => {
  it('escapes inline JSON config so closing script tags cannot break out', () => {
    const html = renderCanvasShellHtml({
      nonce: 'nonce-1',
      discordClientId: 'client-id',
      writeBridgeEnabled: true,
      defaultLandingMessage: '</script><script>alert(1)</script>',
    });

    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
    expect(html).not.toContain('const config = {"clientId":"client-id","writeBridgeEnabled":true,"defaultLandingMessage":"</script>');
  });
});
