# Anonymous Feedback

A small Node.js application for collecting anonymous text feedback with no logins, no accounts, no applicant IDs, and no special links tied to a person. The app uses a public feedback page, a private admin page, SQLite for storage, and a Sunday-only rule for viewing unread feedback.

## What this application does

This application is designed to collect plain-text feedback while minimizing stored metadata. It uses Fastify route schemas for request validation, SQLite for a minimal local database, and a `reviewed` flag stored as an integer because SQLite commonly represents Boolean-like values as `0` and `1`.

The current design intentionally keeps the data model small:

- Public users can submit anonymous text feedback.
- The application stores the feedback text and whether it has been reviewed.
- Unread feedback is only visible on Sundays.
- Reviewed feedback remains visible in the admin interface.
- Public and admin entry pages can be moved to randomized paths.

## Privacy model

The application is designed around data minimization rather than a promise of perfect anonymity. OWASP guidance warns that logs and operational metadata can contain sensitive information, so the app avoids storing unnecessary fields and keeps logging intentionally minimal.

Important privacy limits:

- This app avoids logins and avoids storing explicit user identifiers.
- This app does **not** make a person untraceable at the network level.
- Writing style, infrastructure logs, reverse-proxy logs, and operational mistakes can still reduce anonymity.
- Admin URLs hidden behind random paths are only light obscurity, not real security on their own.

For real-world use, protect the admin route with a reverse proxy, basic auth, or another proper access control mechanism. Hidden URLs should be treated as convenience and noise reduction, not as the primary security boundary.

## Content Security Policy and XSS handling

Feedback bodies are treated as untrusted user input at every layer:

- **Rendering.** The admin UI (`public/admin.js`) always inserts feedback text via `textContent`. `innerHTML` (and equivalents like `insertAdjacentHTML` or `document.write`) is never used for DB-sourced data, so payloads such as `<script>alert(1)</script>` or `"><img src=x onerror=alert(1)>` are shown verbatim as text.
- **Content Security Policy.** `@fastify/helmet` is configured in `src/server.js` with a strict policy: `default-src 'self'`, `script-src 'self'`, `script-src-attr 'none'`, `style-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. Notably, **`'unsafe-inline'` is not present** for `script-src` or `style-src`. Any inline `<script>...</script>`, inline event handler (`onclick="..."`), or inline `style="..."` attribute will be blocked by the browser.
- **Static assets.** All JavaScript and CSS live in dedicated files under `public/` and are served under the fixed `/assets/<name>` route (see `src/server.js`). Only an explicit allow-list of asset names is exposed.

### Adding a new script or stylesheet

1. Create the file in `public/` (e.g. `public/foo.js`).
2. Add its filename to the `staticAssets` allow-list in `src/server.js`.
3. Reference it from the HTML via `<script src="/assets/foo.js"></script>` or `<link rel="stylesheet" href="/assets/foo.css">`.
4. **Do not** add inline `<script>`/`<style>` blocks or inline event-handler attributes; they will be blocked by the CSP. If inline code is ever truly required, prefer switching to a CSP nonce over reintroducing `'unsafe-inline'`.

## Stack

| Component | Choice | Notes |
|---|---|---|
| Runtime | Node.js | Uses native ESM imports and environment variables through `process.env`. |
| Web framework | Fastify | Fastify supports schema-based route validation and explicit route handling. |
| Static files | `@fastify/static` | With `serve: false`, files are only exposed through explicit routes. |
| Database | SQLite | Simple embedded storage, appropriate for a small single-app deployment. |
| SQLite driver | `better-sqlite3` | Supports straightforward prepared statements and direct access patterns. |
| Security headers | `@fastify/helmet` | Applies a strict Content Security Policy, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. |

## Features

- Anonymous text submission form.
- No public login flow.
- Sunday-only unread review gate.
- Separate reviewed and unread views in admin.
- Randomized public and admin paths via environment variables.
- Admin page and admin API protected by a shared `ADMIN_TOKEN` secret.
- Strict Content Security Policy and other security headers via `@fastify/helmet` (no `'unsafe-inline'` for scripts or styles).
- Per-IP rate limiting on `POST /api/feedback` via `@fastify/rate-limit`.
- Startup logs that can print the full public and admin URLs.
- Minimal database schema.

## Project structure

```text
anonymous-feedback/
  data/
    feedback.sqlite
  public/
    admin.html
    admin.css
    admin.js
    index.html
    index.css
    index.js
  src/
    data.js
    server.js
  test/
    server.test.js
  package.json
```

## How it works

### Public flow

1. A person opens the randomized public feedback URL.
2. They type plain-text feedback into a textarea.
3. The browser sends a `POST /api/feedback` request.
4. The server validates the request body using a Fastify schema and stores the text with `reviewed = 0`.

### Admin flow

1. An admin opens the randomized admin URL.
2. The admin page requests unread feedback from `/api/admin/feedback/unreviewed`, sending the `x-admin-token` header.
3. If the token is missing or wrong, the server returns `401`.
4. If the current server day is not Sunday, the server returns `403` and the page shows a locked message.
5. If it is Sunday, unread feedback is returned.
6. When the admin marks an item as reviewed, the app updates that row to `reviewed = 1`.
7. Reviewed items are available from `/api/admin/feedback/reviewed` (also token-protected).

### Why there is no `submitted_at`

This version intentionally avoids a submission timestamp to reduce stored timing metadata. The Sunday delay is implemented as an application rule rather than a per-record release schedule, which keeps the system simpler at the cost of less granular delayed-release logic.

## Database schema

The application uses a single table:

```sql
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);
```

SQLite does not provide a dedicated Boolean storage type in the way many other databases do, so `INTEGER` with `0` and `1` is the practical pattern for a field like `reviewed`.

## API overview

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/feedback` | Submit anonymous feedback. |
| `GET` | `/api/admin/feedback/unreviewed` | Get unread feedback, but only on Sunday. Requires `x-admin-token`. |
| `GET` | `/api/admin/feedback/reviewed` | Get reviewed feedback. Requires `x-admin-token`. |
| `POST` | `/api/admin/feedback/:id/review` | Mark one item as reviewed. Requires `x-admin-token`. |

### `POST /api/feedback`

Request body:

```json
{
  "body": "This is anonymous feedback"
}
```

Validation rules:

- `body` is required.
- `body` must be a string.
- `body` must be at least 10 characters.
- `body` must be no more than 3000 characters.
- Extra properties are rejected.

Fastify recommends schema-based validation for routes, which keeps request rules close to the endpoint definition.

Success response:

```json
{
  "ok": true
}
```

Example error response (validation failure):

```json
{
  "ok": false,
  "error": "Invalid request."
}
```

Validation errors are intentionally reported with a generic message so that request-body details are not echoed back in responses or logs.

## Setup

### Prerequisites

- Node.js 20+ is recommended.
- npm is required.
- SQLite is not required as a separate service because the app uses an embedded SQLite database file.

### Installation

1. Clone or copy the project.
2. Open a terminal in the project folder.
3. Install dependencies:

```bash
npm install
```

### Required packages

```bash
npm install fastify @fastify/static @fastify/helmet better-sqlite3
```

## Configuration

The app can be configured with environment variables.

| Variable | Purpose | Example |
|---|---|---|
| `PORT` | Port the Node app listens on | `3000` |
| `HOST` | Bind address for the Node app | `127.0.0.1` |
| `PUBLIC_BASE_URL` | Base URL used in startup logs | `https://feedback.example.com` |
| `PUBLIC_PATH` | Randomized public feedback path | `/f/1c3f4d9a7b21e8d44f8c1a0b` |
| `ADMIN_PATH` | Randomized admin path | `/r/8aa2e1f4d7c903b18d2f6c55` |
| `ADMIN_TOKEN` | Secret token required for the admin page and admin API (min 16 chars). Sent only as the `x-admin-token` request header — query-string tokens are not accepted. | `s3cret-admin-token-please-change` |
| `LOG_PUBLIC_URL` | Whether to print the full public feedback URL (including `PUBLIC_PATH`) at startup. Defaults to `false` when `NODE_ENV=production`, and `true` otherwise. Set to `true` temporarily to debug on a production host, then unset. | `false` |
| ~~`LOG_ADMIN_URL`~~ | **Removed.** The admin review URL is never printed to logs, regardless of environment. Read `ADMIN_PATH` from your `.env` on the host to obtain it. | — |
| `DB_PATH` | Override the SQLite database file path. Defaults to `data/feedback.sqlite`. Primarily used by the test suite to isolate a temporary database. | `/tmp/afb-test/feedback.sqlite` |
| `FEEDBACK_RATE_MAX` | Max `POST /api/feedback` submissions per IP per window. Defaults to `7`. | `5` |
| `FEEDBACK_RATE_WINDOW` | Time window for `FEEDBACK_RATE_MAX`. Accepts `@fastify/rate-limit` duration strings or milliseconds. Defaults to `1 minute`. | `1 minute` |
| `ENABLE_HEALTHCHECK` | Register the `GET /healthz` liveness probe. **Defaults to `false`.** When `true`, responds with `{"ok":true}` — no auth, no secrets, no DB access. Intended for container-internal healthchecks (Docker Compose, Kubernetes, Dokploy). Do not expose `/healthz` through the public reverse proxy unless you add an IP allowlist. | `false` |
| `ENABLE_DEBUG_ROUTES` | Register the `GET /debug/routes` diagnostic endpoint. **Defaults to `false`.** Even when `true`, the endpoint requires the `x-admin-token` header (`ADMIN_TOKEN`) and its response never includes `PUBLIC_PATH`, `ADMIN_PATH`, `ADMIN_TOKEN`, raw environment variables, or database contents. Enable only briefly on a scratch instance. | `false` |

Node exposes environment variables through `process.env`, and current Node versions also support loading them from a file with `--env-file`.

### Example `.env`

```env
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=http://localhost:3000
PUBLIC_PATH=/f/1c3f4d9a7b21e8d44f8c1a0b
ADMIN_PATH=/r/8aa2e1f4d7c903b18d2f6c55
ADMIN_TOKEN=s3cret-admin-token-please-change
LOG_PUBLIC_URL=false
```

### Generating randomized paths

Use a strong random string instead of a human-readable path name:

```bash
openssl rand -hex 12
```

This produces a 24-character hex string that can be used as part of the public or admin path.

Example:

```env
PUBLIC_PATH=/f/1c3f4d9a7b21e8d44f8c1a0b
ADMIN_PATH=/r/8aa2e1f4d7c903b18d2f6c55
ADMIN_TOKEN=s3cret-admin-token-please-change
```

Use the same command (`openssl rand -hex 32`) to generate a strong `ADMIN_TOKEN`.

## Running the app

### Standard start

```bash
npm start
```

### Start with `.env`

```bash
node --env-file=.env src/server.js
```

### Run with Docker Compose

The repository includes a `Dockerfile` and a `docker-compose.yml` so the app can be launched with a single command.

1. Create a `.env` file (copy from `.env.example` and set strong values for `PUBLIC_PATH`, `ADMIN_PATH`, and `ADMIN_TOKEN`).
2. Build and start the container:

   ```bash
   docker compose up -d --build
   ```

3. The app will be available on `http://localhost:${PORT:-3000}`.
4. The SQLite database is persisted on the host under `./data/feedback.sqlite` via a bind mount.

To stop and remove the container:

```bash
docker compose down
```

Notes:

- Inside the container, `HOST` is forced to `0.0.0.0` and `DB_PATH` to `/app/data/feedback.sqlite`; other variables (including `PUBLIC_BASE_URL`, `PUBLIC_PATH`, `ADMIN_PATH`, `ADMIN_TOKEN`) are read from `.env`.
- The published host port defaults to `3000` and can be overridden with the `PORT` variable in `.env`.

### Example startup output

```text
Server listening on http://localhost:3000
Public feedback URL logging disabled (set LOG_PUBLIC_URL=true to enable).
Admin review URL is not logged. Read ADMIN_PATH from your .env file to obtain it.
```

### Safe logging practices

The app is designed so that sensitive operational data — randomized `PUBLIC_PATH` and `ADMIN_PATH`, the `ADMIN_TOKEN`, and any query strings — cannot appear in logs by default. OWASP guidance warns that log aggregators, container stdout, and archived log files should not be trusted with secrets.

What **is** logged:

- A single `Server listening on <PUBLIC_BASE_URL>` line at startup.
- For 5xx errors, a `[error] <METHOD> <ROUTE_PATTERN> -> <STATUS>` line, where `<ROUTE_PATTERN>` is the Fastify route template (e.g. `/api/admin/feedback/:id/review`) — never `request.url`, so randomized paths, ids, and query strings are not written to logs.
- Shutdown signals (`SIGINT` / `SIGTERM`).

What is **never** logged:

- The admin URL / `ADMIN_PATH` (regardless of `NODE_ENV`).
- `ADMIN_TOKEN` or any request header.
- Raw request URLs, query strings, request bodies, or client IPs.
- Feedback submissions.

Defaults per environment:

- `NODE_ENV=production`: `LOG_PUBLIC_URL` defaults to `false`. The public URL line is replaced with a `Public feedback URL logging disabled` notice.
- Non-production (local dev): `LOG_PUBLIC_URL` defaults to `true` for convenience.

#### Temporarily enabling verbose logging for debugging

If you need to confirm the public URL a running production instance is serving, or diagnose a startup issue, do the following on the host — **not** by adding permanent config:

1. Export the flag inline for a single run, e.g. `LOG_PUBLIC_URL=true node src/server.js` (or `docker compose run --rm -e LOG_PUBLIC_URL=true app`).
2. Copy the URL from stdout.
3. Do **not** commit `LOG_PUBLIC_URL=true` to your `.env` on a production host, and do not enable a global request logger. If you must enable Fastify's built-in request logger (`logger: true` in `src/server.js`) for deep debugging, do it on a scratch instance, redirect logs to a file readable only by you, and revert the change before redeploying.

There is no supported way to log the admin URL — that is deliberate. Read `ADMIN_PATH` directly from the host's `.env` file when you need it.

## Using the app

### Submitting feedback

1. Open the public feedback URL.
2. Type feedback into the textarea.
3. Submit the form.
4. On success, the page shows a generic confirmation message.

There is no reply link, no receipt code, and no edit token. That keeps the public flow minimal and avoids introducing identifiers tied to a single submission.

### Reviewing feedback

1. Open the randomized admin URL in a browser.
2. The admin page prompts once for the admin token and keeps it in `sessionStorage` for the lifetime of the tab. The token is sent as the `x-admin-token` header on every admin API call.
3. If it is Sunday, unread items are displayed.
4. If it is not Sunday, the unread section remains locked.
5. Reviewed items are shown in a separate list.
6. Click **Mark reviewed** to move an item out of the unread list.

### Passing the admin token

The admin page and admin API require the `ADMIN_TOKEN` secret. The server accepts it **only** as the `x-admin-token` request header. Query-string tokens (`?token=...`) are not accepted and, since v2, are rejected as unauthenticated.

In a browser:

- Open the randomized admin URL (without any token in the URL).
- When prompted, paste the `ADMIN_TOKEN` value. It is stored in `sessionStorage` for the tab and included on every admin API call as `x-admin-token`.
- To clear it, close the tab or run `sessionStorage.removeItem("adminToken")` in the browser dev tools.

Why no query-string token:

- Tokens in URLs leak into browser history, `Referer` headers, reverse-proxy access logs, and error logs.
- The header-only flow keeps the secret out of the address bar and out of any URL-based log line.
- Rotate `ADMIN_TOKEN` in your `.env` if you suspect it has been exposed.

For non-browser clients (e.g. `curl`), send the token as a header:

```bash
curl -H "x-admin-token: your-admin-token" http://localhost:3000/api/admin/feedback/reviewed
```

## Testing

The project includes a small `node:test` suite that covers the most important behaviors of the HTTP API. Tests use Fastify's in-process `app.inject()` — no ports are bound and no network requests are made.

Run the suite with:

```bash
npm test
```

What is covered:

- `POST /api/feedback` accepts a valid payload and rejects too-short input (schema validation).
- `GET /api/admin/feedback/unreviewed` is blocked with `403` on non-Sunday (the current date is stubbed to a Monday for the test).
- `GET /api/admin/feedback/reviewed` requires a valid `x-admin-token` header (`401` without it, `200` with it).
- `POST /api/admin/feedback/:id/review` marks an item as reviewed and returns `404` for an unknown id.

Implementation notes:

- `src/server.js` exports a `buildApp()` factory so tests can construct a fresh app without triggering `listen()` or signal handlers. The auto-start block only runs when the file is executed directly (`node src/server.js`).
- `src/data.js` honors a `DB_PATH` environment variable so the test suite can point at a temporary SQLite file (created under the OS temp directory and cleaned up afterwards).
- The test file sets `PUBLIC_PATH`, `ADMIN_PATH`, `ADMIN_TOKEN`, and `DB_PATH` before importing the server modules, so the app boots in an isolated, deterministic configuration.

## Abuse protection (rate limiting)

To keep the public submission endpoint resistant to floods and spam while preserving a friction-free UX (no CAPTCHA, no login), the app applies a per-IP rate limit on `POST /api/feedback` using [`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit).

Defaults:

- `FEEDBACK_RATE_MAX = 7` submissions
- `FEEDBACK_RATE_WINDOW = "1 minute"`

When the limit is exceeded, the server responds with HTTP `429` and a minimal JSON body:

```json
{ "ok": false, "error": "Too many requests. Please retry in 42s." }
```

Because the app runs behind Traefik, Fastify is started with `trustProxy: true` so `request.ip` reflects the real client IP from `X-Forwarded-For` instead of the proxy address. The rate limiter uses `request.ip` as its key, and its error responses intentionally do not include the client IP or the request body, keeping logs free of sensitive data.

Only `POST /api/feedback` is rate-limited (the plugin is registered with `global: false`); admin endpoints are unaffected and remain gated by `ADMIN_TOKEN`.

Tuning:

- Lower `FEEDBACK_RATE_MAX` (e.g. `5`) for stricter protection against bursty spam.
- Raise it (e.g. `20`) if you expect legitimate users on a shared NAT (schools, offices) to submit multiple items in quick succession.
- `FEEDBACK_RATE_WINDOW` accepts human-readable strings (`"30 seconds"`, `"5 minutes"`) or a number of milliseconds.

## Hidden routes and static-file behavior

The app uses `@fastify/static` with `serve: false`, which means static files are not exposed automatically by filename. This allows `reply.sendFile()` to work only for the explicit routes registered by the application, reducing accidental exposure of `index.html` or `admin.html` under default paths.

This means the intended behavior is:

- `/` returns `404`.
- `/admin` returns `404`.
- `/index.html` returns `404`.
- Only the randomized public path serves the feedback page.
- Only the randomized admin path serves the admin page.

## Deployment behind Traefik / Dokploy

This app is designed to run behind a reverse proxy (Traefik, as configured by Dokploy). A few assumptions follow from that:

- **Bind address.** Inside the container the app listens on `0.0.0.0:${PORT:-3000}`. Traefik reaches it on the internal Docker network; the container port is not published to the host in production.
- **Trusted proxy.** Fastify is initialized with `trustProxy: true` (see `src/server.js`). This means:
  - `request.ip` reflects the real client IP taken from `X-Forwarded-For` (the left-most non-proxy address), not Traefik's internal container IP.
  - `request.protocol` and `request.hostname` follow `X-Forwarded-Proto` / `X-Forwarded-Host`, so redirects and logs use the externally visible scheme/host.
  - The per-IP rate limiter (`@fastify/rate-limit`, see the "Abuse protection" section) keys on `request.ip`, so limits are applied per **real client IP**, not per proxy.
- **Only trust proxies you control.** `trustProxy: true` is safe here because the only network path to the app is through Traefik on the Docker network. Do **not** publish the container port directly to the internet with `trustProxy: true` enabled — clients could then forge `X-Forwarded-For` and bypass the rate limiter.
- **Entrypoints.** The Dokploy/Traefik router is currently attached to the `web` (HTTP, port 80) entrypoint because the deployment domain (e.g. an `sslip.io` hostname) does not have a TLS certificate. Once the app is moved to a domain with a valid certificate, the router should be switched to the `websecure` (HTTPS, port 443) entrypoint and a redirect from `web` → `websecure` should be added.
- **`PUBLIC_BASE_URL`.** In HTTP-only deployments this is `http://<host>`. Once TLS is available it **must** be updated to `https://<host>` so that links printed at startup and any absolute URLs match the entrypoint clients actually reach.

### Checklist: migrating from HTTP to HTTPS

When the deployment domain gains a valid TLS certificate (Let's Encrypt via Traefik, or an uploaded cert), work through this list:

1. Confirm Traefik has a working certresolver (e.g. `letsencrypt`) and that the domain resolves to the Traefik host.
2. In Dokploy (or the Traefik dynamic config), switch the router's `entrypoints` from `web` to `websecure` and set `tls.certresolver` (or `tls: true` with an uploaded cert).
3. Add a second router on the `web` entrypoint that redirects everything to `https://` (Traefik `redirectscheme` middleware, `scheme=https`, `permanent=true`).
4. Update `PUBLIC_BASE_URL` in the deployment's `.env` to the `https://…` form and redeploy.
5. Verify externally:
   - `curl -I http://<host>/<PUBLIC_PATH>` returns a `301`/`308` to `https://…`.
   - `curl -I https://<host>/<PUBLIC_PATH>` returns `200` and a valid certificate.
   - The startup log line `Server listening on https://<host>` matches the certificate's CN/SAN.
6. Consider enabling HSTS at Traefik (`Strict-Transport-Security`) once you're confident the domain will stay on HTTPS. Do **not** enable HSTS while still testing on plain HTTP — browsers will remember it.
7. Optionally, add a production-only guard so the app refuses to start when `NODE_ENV=production` and `PUBLIC_BASE_URL` does not begin with `https://`. This is intentionally **not** enforced today because the current `sslip.io`-style host is HTTP-only.

## Security notes

This application aims for simplicity and privacy, but it is not a complete hardened anonymous reporting system. Hidden URLs are not a replacement for access control, and the admin route should be protected with a reverse proxy and authentication.

Recommended deployment protections:

- Put the Node app behind Caddy or Nginx.
- Protect the admin route with HTTP basic auth or stronger access control.
- Prefer binding the app to `127.0.0.1` when the reverse proxy runs on the same machine.
- Avoid request-body logging.
- Avoid third-party analytics, cookies, and other tracking features.

Binding to `0.0.0.0` exposes the app on all IPv4 interfaces, while `127.0.0.1` keeps it local to the machine. For a same-box reverse proxy setup, `127.0.0.1` is usually the safer default.

## Local development tips

For local development, this is a useful configuration:

```env
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=http://localhost:3000
PUBLIC_PATH=/f/local-test-path
ADMIN_PATH=/r/local-admin-path
ADMIN_TOKEN=local-dev-admin-token-please-change
```

Then verify behavior:

```bash
curl -i http://localhost:3000/
curl -i http://localhost:3000/index.html
curl -i http://localhost:3000/f/local-test-path
curl -i http://localhost:3000/r/local-admin-path
```

Expected results:

- `/` should return `404`.
- `/index.html` should return `404`.
- The randomized paths should return `200`.

## Troubleshooting

### `ERR_MODULE_NOT_FOUND`

If Node reports `ERR_MODULE_NOT_FOUND`, check that all referenced files exist at the exact paths used in imports. With ESM, relative imports are resolved literally, including filename and extension.

Examples:

- `./data.js` requires a file named exactly `data.js`.
- `Data.js` is not the same as `data.js` on Linux.
- A file created in an editor but not saved to disk will still be treated as missing.

### `/` still shows `index.html`

If `http://localhost:3000/` still serves the public page, `@fastify/static` is probably still auto-serving files from `public/`. Set `serve: false` in the static registration block so files are only served through explicit routes.

Example:

```js
await app.register(fastifyStatic, {
  root: publicDir,
  serve: false
});
```

### `/index.html` still works

If `/index.html` still works, one of these is likely true:

- `serve: false` is not actually active.
- A custom route explicitly serves `index.html`.
- A reverse proxy is serving static files directly.
- A catch-all route or not-found handler is returning `index.html`.

### Unread feedback is never visible

Unread feedback is only available when the server thinks it is Sunday. Check the server timezone and current date if the route appears locked unexpectedly.

### The app is reachable from the network when it should be local-only

If `HOST=0.0.0.0` is set, the application listens on all IPv4 interfaces. Change it to `127.0.0.1` if the app should only be reachable from the local machine or from a same-host reverse proxy.

## Current limitations

- No attachments.
- No threaded replies.
- No anti-spam system.
- No moderation queue beyond the `reviewed` flag.
- No per-item release schedule.
- No search.
- No user accounts.
- No true network-layer anonymity guarantee.

These limitations are deliberate in many cases because each added feature increases complexity, metadata, and privacy risk.

## Suggested next improvements

- Add reverse-proxy authentication for the admin route.
- Add TLS termination at Caddy or Nginx.
- Add automated backups for `data/feedback.sqlite`.
- Add a private deployment runbook.
- Add optional export to Markdown or CSV.
- Add light abuse protection only if needed, while being careful not to introduce new tracking surfaces.
- Expand the test suite (e.g. helmet/CSP headers, Sunday-allowed unread path, rate limiting once added).


## License

MIT License. Copyright (c) 2026 Christopher Johnson.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files to deal in the Software without restriction, subject to the license terms in `LICENSE`.
