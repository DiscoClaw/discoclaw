# Exposing Webhooks to External Services

By default the webhook server binds to `127.0.0.1` (loopback only).
That is the correct safe default for a single-user personal orchestrator —
but it means external services such as GitHub, Linear, or Stripe **cannot
reach it** without extra configuration.

This page describes the recommended and alternative approaches.
None of them change DiscoClaw's bind behavior; you configure exposure
entirely outside the process.

---

## Recommended: Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes a local TCP
port on the public internet through Tailscale's infrastructure, with no
inbound firewall rules needed. It is the first-choice option because:

- Traffic is TLS-terminated at Tailscale's edge — no cert management on your machine.
- You get a stable public hostname (`<machine>.<tailnet>.ts.net`) tied to your
  Tailscale account.
- No third-party account beyond Tailscale is required.
- Funnel can be toggled off in one command, making it easy to limit exposure
  to the exact window you need.

### Quick setup

1. Install and authenticate Tailscale: <https://tailscale.com/download>
2. Enable Funnel for port 8080 (adjust if you changed `WEBHOOK_PORT`):

```bash
tailscale funnel 8080
```

3. Tailscale prints a public URL such as
   `https://my-machine.tail1234.ts.net`. Use that as the webhook base URL
   when configuring GitHub or another service:

   ```
   https://my-machine.tail1234.ts.net/webhook/<source>
   ```

4. When you no longer need external access:

```bash
tailscale funnel --bg=false 8080   # or: tailscale funnel off
```

> **Note:** Funnel availability depends on your Tailscale plan. As of 2025,
> Funnel is available on the Personal (free) tier. Check the Tailscale docs
> for current plan details.

---

## Alternative: ngrok (dev/testing only)

[ngrok](https://ngrok.com) creates a public HTTPS tunnel to a local port
with a single command. It is convenient for short-lived testing but is not
recommended for long-running deployments because the public URL changes on
each restart (unless you pay for a reserved domain).

```bash
ngrok http 8080
```

ngrok prints a URL like `https://abc123.ngrok-free.app`. Use it as the webhook
base URL in the external service and update it each time ngrok restarts.

---

## Alternative: Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`cloudflared`) proxies local services through Cloudflare's network.
It requires a Cloudflare account and a domain managed by Cloudflare, but
provides a stable hostname and is suitable for longer-running deployments.

```bash
cloudflared tunnel --url http://localhost:8080
```

For a persistent named tunnel, follow the [Cloudflare Tunnel guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/).

---

## Alternative: Reverse proxy on a VPS / public server

If DiscoClaw runs on a machine with a public IP (or you already operate a
reverse proxy on a VPS), you can terminate TLS there and proxy to
`127.0.0.1:8080` with nginx, Caddy, or similar.

Example minimal Caddy config:

```
webhooks.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

This requires owning a domain, managing DNS records, and keeping the proxy
server updated. It is the most work but gives you the most control.

---

## Changing the bind address

If you want DiscoClaw's webhook server to bind to a non-loopback interface
directly (e.g. inside a private network), set `WEBHOOK_HOST` in your `.env`:

```
WEBHOOK_HOST=0.0.0.0   # listen on all interfaces
```

> **Warning:** binding to `0.0.0.0` without a firewall exposes the webhook
> endpoint to every network interface on the machine. HMAC signature
> verification protects the endpoint from unauthorized callers, but limit
> exposure where possible.
