# Dashboard Tailscale Access

How to reach the DiscoClaw dashboard from another device on your Tailscale tailnet, such as a phone browser, without an SSH tunnel.

---

## Background

By default, the dashboard is loopback-only:

- it binds to `127.0.0.1`
- it rejects any `Host` header that is not a loopback address

That default is deliberate. It prevents casual exposure on the LAN and adds DNS-rebinding protection.

If you want to open the dashboard from a phone over Tailscale, configure an explicit allowlist of trusted dashboard hosts. When that allowlist is non-empty, DiscoClaw binds the dashboard to `0.0.0.0` and still rejects requests whose `Host` header is not loopback or on the allowlist.

## What to set in `.env`

Add the dashboard settings you need:

```dotenv
DISCOCLAW_DASHBOARD_ENABLED=1
DISCOCLAW_DASHBOARD_PORT=9401
DISCOCLAW_DASHBOARD_TRUSTED_HOSTS=100.64.0.12,macbook.tailnet.ts.net
```

Notes:

- `DISCOCLAW_DASHBOARD_ENABLED=1` starts the dashboard server.
- `DISCOCLAW_DASHBOARD_PORT` is optional; `9401` is the default.
- `DISCOCLAW_DASHBOARD_TRUSTED_HOSTS` is a comma-separated allowlist of exact hosts the dashboard will accept in the `Host` header.
- Hostnames are normalized to lowercase and trailing dots are ignored, so `Phone.Tailnet.ts.net.` and `phone.tailnet.ts.net` are treated the same.

## Multiple local instances

If you run two DiscoClaw instances on the same machine and enable the dashboard for both, they cannot share the same port.

Set a different `DISCOCLAW_DASHBOARD_PORT` in each instance's `.env`, for example:

```dotenv
# instance A
DISCOCLAW_DASHBOARD_PORT=9401

# instance B
DISCOCLAW_DASHBOARD_PORT=9402
```

If you forget, the later instance will keep running but its dashboard will stay disabled for that process, and the startup error will name the conflicting bind target and URL.

## Supported host values

`DISCOCLAW_DASHBOARD_TRUSTED_HOSTS` supports:

- Tailscale IPv4 addresses such as `100.64.0.12`
- Tailscale or MagicDNS hostnames such as `macbook.tailnet.ts.net`

It does not support IPv6 literals. Use hostnames or IPv4 addresses only.

This restriction is intentional. The dashboard allowlist parser rejects values containing `:`, so entries like `fd7a:115c:a1e0::1` will fail startup.

## Why `0.0.0.0` is used

Once trusted hosts are configured, the dashboard must listen on a non-loopback interface or your phone cannot reach it over Tailscale. DiscoClaw uses `0.0.0.0` for that bind so the OS accepts connections arriving on the machine's Tailscale IPv4 address.

This does not disable host validation. Binding to `0.0.0.0` only makes the TCP listener reachable. The dashboard still checks the incoming `Host` header and accepts only:

- loopback hosts such as `127.0.0.1` and `localhost`
- hosts listed in `DISCOCLAW_DASHBOARD_TRUSTED_HOSTS`

Everything else is rejected.

## Security model

The real security boundary here is Tailscale's authenticated private network. Treat the dashboard as a service intended for devices that are already members of your tailnet.

The dashboard `Host` header allowlist is defense-in-depth:

- it preserves DNS-rebinding protection for unexpected hostnames
- it prevents accidental access via arbitrary LAN names or public reverse-proxy hostnames
- it keeps the default loopback-only behavior unless you explicitly opt in

Do not put public internet hostnames in `DISCOCLAW_DASHBOARD_TRUSTED_HOSTS`.

Examples to avoid:

- `dashboard.example.com`
- `my-public-vps.com`
- any hostname served through a public reverse proxy, tunnel, or ingress

If you need internet exposure, use a separate hardened publishing path and treat that as a different threat model.

## Verifying from a phone

1. Make sure the phone is connected to the same Tailscale tailnet.
2. Start or restart DiscoClaw so it picks up the `.env` change.
3. On the DiscoClaw machine, run:

```bash
discoclaw dashboard
```

4. Confirm the CLI prints a trusted-host URL such as:

```text
Trusted host URL: http://macbook.tailnet.ts.net:9401/
```

5. On the phone, open one of these:

- `http://<tailscale-ip>:9401/`
- `http://<magicdns-hostname>:9401/`

6. Verify the dashboard page loads and the browser address matches a host you explicitly allowlisted.

If the page does not load:

- confirm the phone can reach the machine over Tailscale
- confirm the hostname or IPv4 address in the browser exactly matches an entry in `DISCOCLAW_DASHBOARD_TRUSTED_HOSTS`
- confirm you did not use an IPv6 literal
- confirm the service restarted after the `.env` change
