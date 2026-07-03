# Incident Runbook: Hermes Outage — Nameservers Switched from Cloudflare to Vercel

**Incident date:** detected 2026-07-03 (change occurred ~2026-06-08 per SOA serial)
**Status:** diagnosed; repair requires manual changes at Namecheap and Cloudflare
**Severity:** external path to Hermes fully severed; Vercel-hosted root site unaffected

## Summary

The authoritative nameservers for `thefinesthomesutah.com` were switched from
Cloudflare (`maria.ns.cloudflare.com` / `miguel.ns.cloudflare.com`) to Vercel
(`ns1.vercel-dns.com` / `ns2.vercel-dns.com`), most likely via an accidental
"use Vercel nameservers" selection when the domain was added to a Vercel
project. This is a DNS-level failure, **not** a Mac Mini or gateway failure.

### Impact

| Hostname | State | Why |
|---|---|---|
| `thefinesthomesutah.com` | ✅ 200 | Served directly by Vercel; unaffected |
| `hermes.thefinesthomesutah.com` | ❌ 503 | Cloudflare Tunnel route no longer in DNS path |
| `app.thefinesthomesutah.com` | ❌ 503 | No matching route on Vercel's edge |
| `docs.thefinesthomesutah.com` | ❌ 503 | No matching route on Vercel's edge |

### Consequences of the nameserver switch

1. **Cloudflare Tunnel is unreachable.** Tunnel hostnames only work as proxied
   records inside a Cloudflare-managed zone. With Vercel DNS authoritative,
   `hermes.` resolves to Vercel's edge, which has no route for it → 503. The
   `cloudflared` connector on the Mac Mini may be connected and healthy, but
   nothing points at it.
2. **Cloudflare Access is bypassed/broken** — the auth layer in front of
   Hermes is out of the request path entirely.
3. **AEO/WAF bot rules are moot** — Cloudflare is not in the request path.
4. This also explains why the tunnel migration parallel-run would never
   promote cleanly.

## Repair procedure

> None of these steps were performed automatically. Each requires access to
> the Namecheap, Cloudflare, or Vercel dashboards, or the Mac Mini itself.

### Step 1 — Namecheap: restore Cloudflare nameservers

Domain List → `thefinesthomesutah.com` → Nameservers → **Custom DNS**:

```
maria.ns.cloudflare.com
miguel.ns.cloudflare.com
```

If the Cloudflare dashboard shows the zone as **"Moved"**, reactivate it —
records are typically retained for a grace period.

### Step 2 — Cloudflare: verify zone records

| Record | Type | Target | Proxy |
|---|---|---|---|
| `hermes` | CNAME | `<named-tunnel-id>.cfargotunnel.com` | **Proxied (orange cloud)** — required |
| `@` | CNAME | `cname.vercel-dns.com` | keeps Vercel-hosted site working |
| `app` | CNAME | `cname.vercel-dns.com` | keeps Vercel-hosted app working |
| `docs` | — | confirm intended target (Vercel or tunnel) | per intent |

Also confirm the Cloudflare Access application covering `hermes.` is still
present and enabled.

### Step 3 — Vercel: prevent recurrence

In the Vercel project that claimed the domain (Settings → Domains), keep the
domain but ensure it is configured **via CNAME, not Vercel nameservers**, so
the dashboard doesn't prompt another NS switch. Vercel verifies fine through a
Cloudflare-proxied CNAME.

### Step 4 — Mac Mini: confirm the local stack is healthy

```bash
# gateway service loaded?
launchctl list | grep ai.hermes.gateway

# local gateway responding? (replace PORT with the gateway's port)
curl -s -o /dev/null -w "local hermes: %{http_code}\n" http://localhost:PORT/health

# tunnel connector registered with Cloudflare edge?
cloudflared tunnel info <named-tunnel-name>
```

### Step 5 — After propagation (15 min – 2 hrs)

Run the verification script from any machine with normal network access:

```bash
./scripts/check-hermes-dns.sh
```

All checks must pass: Cloudflare NS authoritative, `hermes.` behind Cloudflare
(server header `cloudflare`), and non-503 responses on all three subdomains.

## Prevention

- **Add the DNS/tunnel health check to `dan-daily-repair` permanently.** This
  outage is exactly the failure mode that check exists to catch — the tunnel
  connector was likely green the whole time while nothing routed to it. Use
  `scripts/check-hermes-dns.sh` (exit code 0 = healthy, non-zero = alert).
- When adding domains to Vercel projects in the future, always choose the
  **CNAME / A-record** verification path, never "use Vercel nameservers".
- The daily check verifies the NS delegation itself, not just endpoint HTTP
  status, so a future NS flip is caught within a day even before caches expire.
