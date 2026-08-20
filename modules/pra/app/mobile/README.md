# Sentinel PRA — mobile shell

A PWA client for `server/local_service.js`. Every route it calls is real
and tested — nothing here is a stub, mock, or planned endpoint.

## What's real and tested right now

| Piece | File | Proof |
|---|---|---|
| `push_subscriptions` table | `migrations/0006_push_subscriptions.sql` | applied to live Postgres, `schema_version` 0.7.4 |
| Repo methods (add/list/remove/record-outcome) | `server/metadata_repository.js` | `tests/push_notify.test.js` (offline, FakeDb) |
| Fan-out sender with 410-cleanup | `server/push_notify.js` | `tests/push_notify.test.js`; graceful no-op proven when VAPID unset |
| `GET /push/vapid-public-key`, `POST /push/subscribe`, `POST /push/unsubscribe`, `POST /push/test` | `server/local_service.js` | hand-run against a live `local_service` instance + live Postgres — see below |
| `GET /health`, `GET /dashboard`, `GET /clock` | `server/local_service.js` (pre-existing) | this shell's `app.js` renders their actual real field names, nothing invented |

Full suite: `cd modules/pra && node tests/run_all.js` → 321/321.

Live endpoint check performed during this build:
```
GET  /health                 -> {"ok":true,"db_available":true,...}
GET  /push/vapid-public-key  -> {"ok":true,"configured":false}   (no keys set yet — correct)
POST /push/subscribe         -> {"ok":true,"subscription_id":"1"}
POST /push/test              -> {"ok":true,"sent":0,...,"skipped":true,"reason":"PRA_VAPID_..."}
POST /push/unsubscribe       -> {"ok":true,"removed":true}
```

## Two things that are genuinely NOT code problems

**1. Reaching the service from a phone.** `local_service.js` refuses to bind
anywhere but `127.0.0.1` — on purpose, it's an investigative case store with
no auth, by design, because it assumed a single local operator. That
assumption doesn't change just because you also want a phone to reach it.
The honest fix is a private network, not a code change to the bind check:

- Install Tailscale (or WireGuard) on the Mac and the phone.
- Run `tailscale serve` (or an equivalent local tunnel) on the Mac, pointed
  at `127.0.0.1:4317`. This gives you a private, TLS-terminated address only
  your own devices can reach — never expose port 4317 to your LAN or the
  open internet without adding real authentication first, which
  `local_service.js` currently has none of, on purpose.
- Set `SENTINEL_API_BASE` in `config.js` to that address.

**2. Turning on push notifications.** This needs a one-time key generation
you must run yourself and keep the private half of secret:

```bash
cd modules/pra && npx web-push generate-vapid-keys
```

Set the two resulting values as environment variables wherever
`local_service.js` runs (e.g. in `.env`, which is already gitignored):

```
PRA_VAPID_PUBLIC_KEY=<the public key>
PRA_VAPID_PRIVATE_KEY=<the private key>
PRA_VAPID_CONTACT=mailto:you@example.com
```

Until both are set, `GET /push/vapid-public-key` correctly reports
`configured: false` and the shell disables the "enable notifications"
button with an explanation — that's the honest state, not a bug to hide.

## What still needs a *decision*, not more code

**When should a push actually fire?** `POST /push/test` proves the pipe
works end to end, but nothing yet calls `pushNotify.notifyAll()` on a real
event (a new lead, a contradiction, a request going overdue). That's a
product decision about which events are worth a phone buzz — wiring one
call to `pushNotify.notifyAll(repo, pushNotify.buildPayload({...}))` at
that call site is a 3-line change once you tell me which event(s) you want.
`modules/watch/notify.js` already enforces the same "doorbell, not delivery"
content rule for the desktop watcher; `push_notify.js` was written to match
it exactly, so wiring them to the same trigger point is straightforward.

## Run it locally

```bash
cd modules/pra
node -e "const {createService}=require('./server/local_service.js'); const {server,port,host}=createService(); server.listen(port,host);"
# separate terminal:
cd modules/pra/app/mobile && python3 -m http.server 8080
# visit http://127.0.0.1:8080 — health check will show real, live data.
```

"Add to Home Screen" install and push both require a secure context
(HTTPS or `localhost`) — `http://127.0.0.1:8080` satisfies that for local
testing; the Tailscale address will need TLS for the same reason once you
test from the phone.
