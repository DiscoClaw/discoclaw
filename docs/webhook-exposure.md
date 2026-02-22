# Exposing Webhooks to External Services

## Overview

The DiscoClaw webhook server binds to `127.0.0.1` (loopback only) by design.
External services — GitHub, Linear, Stripe, etc. — cannot reach a loopback
address. This guide explains how to expose the listener so those services can
deliver payloads to your instance.

None of the approaches below change DiscoClaw's bind behavior. Exposure is
configured entirely outside the process.

---

## Why localhost?

Binding to loopback by default means the webhook port is unreachable from the
network until **you** take a deliberate action to open it. This limits the blast
radius of misconfiguration: a webhook endpoint that nobody can reach cannot be
abused, even if HMAC verification were somehow bypassed.

When you expose the port you control exactly how, when, and to whom — using one
of the methods below.

---

## Tailscale Funnel (recommended)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes a local TCP
port on the public internet through Tailscale's infrastructure, with no inbound
firewall rules needed. It is the first-choice option because:

- Traffic is TLS-terminated at Tailscale's edge — no cert management on your machine.
- You get a stable public hostname (`<machine>.<tailnet>.ts.net`) tied to your
  Tailscale account, so the URL survives restarts.
- No third-party account beyond Tailscale is required.
- Funnel can be toggled off in one command, making it easy to limit exposure to
  the exact window you need.

### Quick setup

1. Install and authenticate Tailscale: <https://tailscale.com/download>
2. Enable Funnel for the webhook port:

```bash
tailscale funnel 9400
```

3. Tailscale prints a public URL such as `https://my-machine.tail1234.ts.net`.
   Append the path when registering the webhook in GitHub or another service:

   ```
   https://my-machine.tail1234.ts.net/webhook/<source>
   ```

   Replace `<source>` with the source name you configured (e.g. `github`).

4. When you no longer need external access:

```bash
tailscale funnel off
```

> **Note:** Funnel availability depends on your Tailscale plan. As of early
> 2026, Funnel is available on the Personal (free) tier. Check the Tailscale
> docs for current plan details.

---

## Alternatives

### ngrok (dev/testing only)

[ngrok](https://ngrok.com) creates a public HTTPS tunnel in a single command.
Convenient for short-lived testing, but the public URL changes on each restart
unless you pay for a reserved domain.

```bash
ngrok http 9400
```

ngrok prints a URL like `https://abc123.ngrok-free.app`. Use it as the webhook
base URL in the external service. Remember to update the URL each time ngrok
restarts.

### Caddy reverse proxy

If DiscoClaw runs on a machine that already has a public IP and a domain, Caddy
handles TLS automatically with a minimal config:

```
webhooks.example.com {
    reverse_proxy 127.0.0.1:9400
}
```

Run `caddy run` (or configure Caddy as a systemd service). Caddy obtains a
Let's Encrypt certificate automatically. This requires owning a domain and
managing DNS records.

### Raw public IP with firewall rules

If the machine has a publicly routable IP and you control its firewall, you can
open the webhook port directly. This skips TLS termination — most external
services require HTTPS, so you would also need to handle TLS yourself (e.g. via
`stunnel` or a self-managed certificate). Only use this if you understand the
exposure: an open port is reachable from the full internet. Restrict source IPs
in the firewall where the external service publishes its IP ranges.

---

## Verifying it works

After configuring exposure, confirm the endpoint is reachable from outside your
machine:

```bash
curl -i https://<your-public-url>/webhook/<source>
```

A `400 Bad Request` or `401 Unauthorized` response means the server is
reachable and HMAC validation is running — that is the expected response for a
request with no valid signature. A connection timeout or `Connection refused`
means the tunnel or firewall rule is not working yet.

To confirm DiscoClaw received the request, check the logs:

```bash
journalctl --user -u discoclaw.service -n 50 | grep webhook
```

You should see an incoming request log line even for rejected payloads.

---

## Security reminder

HMAC signature verification is always enforced — every incoming payload is
checked against the secret configured for that source (the `"secret"` field in
the JSON config file referenced by `DISCOCLAW_WEBHOOK_CONFIG`). Exposing the
HTTP listener does not grant callers arbitrary access; it only makes the
endpoint reachable so that legitimate signed payloads can be delivered.

Keep your webhook secrets strong and do not share them. If a secret is
compromised, rotate it in both the DiscoClaw webhook config file and the
external service's webhook settings.
