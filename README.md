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
- Strict Content Security Policy and other security headers via `@fastify/helmet`.
- Startup logs that can print the full public and admin URLs.
- Minimal database schema.

## Project structure

```text
anonymous-feedback/
  data/
    feedback.sqlite
  public/
    admin.html
    index.html
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
| `ADMIN_TOKEN` | Secret token required for the admin page and admin API (min 16 chars). Sent as `x-admin-token` header or `?token=` query param. | `s3cret-admin-token-please-change` |
| `LOG_PUBLIC_URL` | Whether to print the full public feedback URL at startup. Defaults to `true`. | `true` |
| `LOG_ADMIN_URL` | Whether to print the full admin review URL at startup. Defaults to `false` to keep sensitive operational data out of logs (OWASP guidance). | `false` |
| `DB_PATH` | Override the SQLite database file path. Defaults to `data/feedback.sqlite`. Primarily used by the test suite to isolate a temporary database. | `/tmp/afb-test/feedback.sqlite` |

Node exposes environment variables through `process.env`, and current Node versions also support loading them from a file with `--env-file`.

### Example `.env`

```env
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=http://localhost:3000
PUBLIC_PATH=/f/1c3f4d9a7b21e8d44f8c1a0b
ADMIN_PATH=/r/8aa2e1f4d7c903b18d2f6c55
ADMIN_TOKEN=s3cret-admin-token-please-change
LOG_PUBLIC_URL=true
LOG_ADMIN_URL=false
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
Public feedback URL: http://localhost:3000/f/1c3f4d9a7b21e8d44f8c1a0b
Admin review URL logging disabled (set LOG_ADMIN_URL=true to enable).
```

Printing the full admin URL is convenient, but it also makes that log output sensitive operational data. OWASP guidance warns against exposing sensitive information in logs, so admin URL logging is disabled by default. Set `LOG_ADMIN_URL=true` to include it (and restrict access to deployment logs accordingly). Similarly, `LOG_PUBLIC_URL=false` replaces the public URL line with a `Public feedback URL logging disabled` notice.

## Using the app

### Submitting feedback

1. Open the public feedback URL.
2. Type feedback into the textarea.
3. Submit the form.
4. On success, the page shows a generic confirmation message.

There is no reply link, no receipt code, and no edit token. That keeps the public flow minimal and avoids introducing identifiers tied to a single submission.

### Reviewing feedback

1. Open the admin URL, appending the admin token as a `?token=...` query parameter (see [Passing the admin token in a browser](#passing-the-admin-token-in-a-browser)).
2. If it is Sunday, unread items are displayed.
3. If it is not Sunday, the unread section remains locked.
4. Reviewed items are shown in a separate list.
5. Click **Mark reviewed** to move an item out of the unread list.

### Passing the admin token in a browser

The admin page and admin API require the `ADMIN_TOKEN` secret. In a browser, pass it by appending it as a `?token=...` query parameter to the admin URL:

```
http://localhost:3000/r/8aa2e1f4d7c903b18d2f6c55?token=your-admin-token
```

The admin page (`public/admin.html`) reads `token` from the URL and automatically forwards it as the `x-admin-token` header on every subsequent admin API call, so you only need to include it once when opening the page.

Tips:

- Bookmark the full URL (path + `?token=...`) so you don't have to type it each time.
- Keep the tab/window private — the token is visible in the address bar and browser history.
- To avoid the token appearing in server access logs, use a browser extension (e.g. ModHeader) to send `x-admin-token` as a header instead, and open the admin URL without the query string.
- Rotate `ADMIN_TOKEN` in your `.env` if it may have been exposed.

For non-browser clients (e.g. `curl`), send the token as a header instead:

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

## Hidden routes and static-file behavior

The app uses `@fastify/static` with `serve: false`, which means static files are not exposed automatically by filename. This allows `reply.sendFile()` to work only for the explicit routes registered by the application, reducing accidental exposure of `index.html` or `admin.html` under default paths.

This means the intended behavior is:

- `/` returns `404`.
- `/admin` returns `404`.
- `/index.html` returns `404`.
- Only the randomized public path serves the feedback page.
- Only the randomized admin path serves the admin page.

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
