# Webhook Exposure Guide

How to expose DiscoClaw's webhook server to external services (GitHub, Stripe, etc.) and keep it secure.

---

## Background

The webhook server (`src/webhook/server.ts`) binds to `127.0.0.1:8080` by default — loopback only. External services like GitHub can't reach it unless you expose the port through a tunnel or reverse proxy.

## Exposure options

### Tailscale Funnel

Zero-config HTTPS with a stable hostname. Best if you already use Tailscale.

```bash
# Expose port 8080 on your Tailscale hostname
tailscale funnel 8080
```

Your webhook URL becomes `https://<machine>.<tailnet>.ts.net/webhook/<source>`.

### ngrok

Quick tunnel for development or testing.

```bash
ngrok http 8080
```

Copy the `https://` URL ngrok prints and append `/webhook/<source>`.

### Caddy reverse proxy

For a VPS or always-on server with a real domain. Caddy handles TLS automatically.

```
# Caddyfile
webhooks.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### SSH remote forwarding

Forward from a public server to your local machine.

```bash
ssh -R 8080:127.0.0.1:8080 user@public-server
```

Pair with a reverse proxy on the public server for TLS.

---

## Security

### HMAC-SHA256 signature verification

Every request must include an `X-Hub-Signature-256` header with value `sha256=<hex-digest>`, computed over the raw request body using the per-source secret. This is the same convention GitHub uses.

The server performs constant-time comparison via `crypto.timingSafeEqual` to prevent timing attacks.

### Source isolation

Each webhook source gets its own entry in the config file with an independent secret and target channel. An attacker who compromises one source's secret cannot inject into another source's channel.

### Unknown sources return 404

Requests to undefined sources receive a `404 Not Found` — the server does not reveal which sources are configured.

### Body size limit

Request bodies are capped at 256 KB. Oversized payloads are rejected with `413 Payload Too Large`.

### Rate limiting

The webhook server does not implement application-level rate limiting. If you expose it to the public internet, place a reverse proxy in front that enforces rate limits. Caddy, nginx, and Cloudflare all support this.

### IP allowlisting

For maximum security, restrict inbound traffic to known sender IPs at the firewall or reverse-proxy level:

- **GitHub webhooks:** [GitHub's published IP ranges](https://api.github.com/meta) under the `hooks` key
- **Stripe webhooks:** [Stripe's IP list](https://docs.stripe.com/ips)
- **General:** your reverse proxy's `allow`/`deny` directives

---

## Configuration

Set these env vars to enable the webhook server:

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_WEBHOOK_ENABLED` | `false` | Set to `1` or `true` to start the server |
| `DISCOCLAW_WEBHOOK_PORT` | `8080` | Port to listen on |
| `DISCOCLAW_WEBHOOK_CONFIG` | — | Absolute path to the JSON config file |

### Config file format

```json
{
  "github": {
    "secret": "whsec_your_github_secret",
    "channel": "dev-alerts",
    "prompt": "A GitHub event arrived from {{source}}:\n\n{{body}}\n\nSummarize the event and post to the channel."
  },
  "stripe": {
    "secret": "whsec_your_stripe_secret",
    "channel": "billing"
  }
}
```

Each source has:

- **`secret`** (required) — HMAC-SHA256 key for signature verification
- **`channel`** (required) — target Discord channel name or ID
- **`prompt`** (optional) — instruction sent to the runtime; supports `{{body}}` and `{{source}}` placeholders. If omitted, a default prompt is built from the source name and payload.

### Registering a webhook with GitHub

1. Go to your repo → Settings → Webhooks → Add webhook
2. Set **Payload URL** to `https://<your-host>/webhook/github`
3. Set **Content type** to `application/json`
4. Set **Secret** to the same value as `secret` in your config
5. Choose events (or "Send me everything")

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` | Signature mismatch | Ensure the secret in your config matches the one registered with the sender |
| `404 Not Found` | Source not in config, or wrong URL path | Check that the `:source` segment in the URL matches a key in your config file |
| `413 Payload Too Large` | Body exceeds 256 KB | Check what the sender is posting; consider filtering event types |
| Server not reachable | Bound to loopback, no tunnel/proxy | Set up one of the exposure options above |
