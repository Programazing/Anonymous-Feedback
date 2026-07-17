import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import {
  insertFeedback,
  getUnreviewedFeedback,
  getReviewedFeedback,
  markFeedbackReviewed,
  closeDatabase
} from "./data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

function normalizePath(value, fallback) {
  if (!value || typeof value !== "string") {
    return fallback;
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function envFlag(value, fallback = false) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === "true";
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publicPath = process.env.PUBLIC_PATH;
const adminPath = process.env.ADMIN_PATH;
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const normalizedPublicPath = normalizePath(publicPath, "/f/replace-me");
const normalizedAdminPath = normalizePath(adminPath, "/r/replace-me");
const enableHealthcheck = envFlag(process.env.ENABLE_HEALTHCHECK, false);
const enableDebugRoutes = envFlag(process.env.ENABLE_DEBUG_ROUTES, false);

export async function buildApp() {
  const feedbackRateMax = Number(process.env.FEEDBACK_RATE_MAX || 7);
  const feedbackRateWindow = process.env.FEEDBACK_RATE_WINDOW || "1 minute";
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: true
  });

  await app.register(fastifyRateLimit, {
    global: false,
    max: feedbackRateMax,
    timeWindow: feedbackRateWindow,
    // Use req.ip so the real client IP (from X-Forwarded-For via trustProxy) is honored.
    keyGenerator: (request) => request.ip
    // Note: the friendly 429 JSON body is produced by the app's setErrorHandler,
    // which reads the Retry-After header set by @fastify/rate-limit. Avoiding a
    // custom errorResponseBuilder keeps client IPs and request bodies out of the
    // thrown error object (and therefore out of any error logs).
  });

  await app.register(fastifyHelmet, {
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    // Strict CSP: no 'unsafe-inline' for scripts or styles. All JS/CSS lives in
    // external files under /assets/* (see public/*.js and public/*.css). This
    // means any user-submitted feedback that ends up in the DOM cannot execute
    // as a script, even if it slipped past the textContent rendering used by
    // admin.js. To add a new script or stylesheet:
    //   1. Drop the file into public/ and expose it under /assets/<name>.
    //   2. Reference it from HTML via <script src="/assets/..."> or
    //      <link rel="stylesheet" href="/assets/...">.
    //   3. Do NOT add inline <script>...</script> blocks or style="..." attrs;
    //      they will be blocked by the browser under this policy.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  });

  await app.register(fastifyStatic, {
    root: publicDir,
    serve: false
  });

  if (!process.env.PUBLIC_PATH || process.env.PUBLIC_PATH === "/f/replace-me") {
    throw new Error("PUBLIC_PATH must be set to a randomized value.");
  }

  if (!process.env.ADMIN_PATH || process.env.ADMIN_PATH === "/r/replace-me") {
    throw new Error("ADMIN_PATH must be set to a randomized value.");
  }

  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 16) {
    throw new Error("ADMIN_TOKEN must be set to a strong secret (at least 16 characters).");
  }

  const adminToken = process.env.ADMIN_TOKEN;

  function timingSafeEqualStr(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  async function requireAdminToken(request, reply) {
    const headerToken = request.headers["x-admin-token"];
    const provided = typeof headerToken === "string" ? headerToken : "";

    if (!timingSafeEqualStr(provided, adminToken)) {
      return reply.code(401).send({ ok: false, error: "Unauthorized." });
    }
  }

  function isSunday() {
    const now = new Date();
    return now.getDay() === 0;
  }

  app.addHook("onSend", async (request, reply, payload) => {
    const url = request.raw.url || "";
    const routeUrl = url.split("?")[0];
    if (
        routeUrl === normalizedPublicPath ||
        routeUrl === normalizedAdminPath ||
        (enableHealthcheck && routeUrl === "/healthz") ||
        (enableDebugRoutes && routeUrl === "/debug/routes") ||
        routeUrl.startsWith("/api/")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  // /healthz — opt-in liveness probe.
  //
  // Disabled by default (ENABLE_HEALTHCHECK=false). When enabled, returns a
  // tiny JSON body with no secrets, no environment data, and no database
  // access. Safe to expose to a container orchestrator (Docker/Compose,
  // Kubernetes, Traefik) as an HTTP healthcheck. Do NOT expose it publicly
  // through the reverse proxy unless you actually need external monitoring;
  // container-internal healthchecks (e.g. `docker compose` healthcheck) reach
  // it without a public route.
  if (enableHealthcheck) {
    app.get("/healthz", async () => {
      return { ok: true };
    });
  }

  // /debug/routes — opt-in, admin-only diagnostic endpoint.
  //
  // Disabled by default (ENABLE_DEBUG_ROUTES=false). Even when enabled it
  // requires the admin token (x-admin-token header, same as /api/admin/*).
  // The response is intentionally minimal: it lists the registered route
  // patterns and the configured HOST/PORT only. It MUST NOT include:
  //   - the randomized PUBLIC_PATH or ADMIN_PATH,
  //   - the ADMIN_TOKEN or any other secret,
  //   - raw process.env, process.cwd(), or database contents.
  // Keep this list conservative when adding fields.
  if (enableDebugRoutes) {
    app.get("/debug/routes", { preHandler: requireAdminToken }, async () => {
      const routes = app
        .printRoutes({ commonPrefix: false })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        // Redact the randomized public/admin path patterns so the response
        // never leaks them, even to an authenticated admin viewing this over
        // a shoulder / screenshot.
        .map((line) => {
          if (line.includes(normalizedPublicPath)) return "<public-path> (redacted)";
          if (line.includes(normalizedAdminPath)) return "<admin-path> (redacted)";
          return line;
        });

      return {
        ok: true,
        host,
        port,
        routes
      };
    });
  }

  app.get("/", async (request, reply) => {
    return reply.redirect(normalizedPublicPath);
  });

  app.get(normalizedPublicPath, async (request, reply) => {
    return reply.sendFile("index.html");
  });

  // The admin HTML page itself is served without a token check because
  // browsers cannot attach the X-Admin-Token header on a plain navigation.
  // The page is still protected by the randomized ADMIN_PATH, and every
  // admin API endpoint below enforces the header token.
  app.get(normalizedAdminPath, async (request, reply) => {
    return reply.sendFile("admin.html");
  });

  // Serve the small set of static JS/CSS assets referenced by index.html and
  // admin.html under a fixed /assets/ prefix. Only explicitly listed files
  // are exposed so we don't accidentally serve the entire public/ directory
  // (which also contains the HTML pages protected by randomized paths).
  const staticAssets = new Set([
    "index.css",
    "index.js",
    "admin.css",
    "admin.js"
  ]);

  app.get("/assets/:name", async (request, reply) => {
    const name = request.params.name;
    if (!staticAssets.has(name)) {
      return reply.code(404).send({ ok: false, error: "Not found." });
    }
    return reply.sendFile(name);
  });

  app.post("/api/feedback", {
    config: {
      rateLimit: {
        max: feedbackRateMax,
        timeWindow: feedbackRateWindow
      }
    },
    preValidation: async (request) => {
      if (request.body && typeof request.body === "object" && typeof request.body.body === "string") {
        request.body.body = request.body.body.trim();
      }
    },
    schema: {
      body: {
        type: "object",
        required: ["body"],
        additionalProperties: false,
        properties: {
          body: { type: "string", minLength: 10, maxLength: 3000 }
        }
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" }
          }
        }
      }
    }
  }, async (request, reply) => {
    insertFeedback(request.body.body);
    return reply.send({ ok: true });
  });

  app.get("/api/admin/feedback/unreviewed", { preHandler: requireAdminToken }, async (request, reply) => {
    if (!isSunday()) {
      return reply.code(403).send({
        ok: false,
        error: "Unread feedback is only available on Sundays."
      });
    }

    return reply.send({
      ok: true,
      items: getUnreviewedFeedback()
    });
  });

  app.get("/api/admin/feedback/reviewed", { preHandler: requireAdminToken }, async (request, reply) => {
    return reply.send({
      ok: true,
      items: getReviewedFeedback()
    });
  });

  app.post("/api/admin/feedback/:id/review", {
    preHandler: requireAdminToken,
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "integer", minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const result = markFeedbackReviewed(Number(request.params.id));

    if (result.changes === 0) {
      return reply.code(404).send({
        ok: false,
        error: "Feedback not found."
      });
    }

    return reply.send({ ok: true });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ ok: false, error: "Not found." });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      // Log only the matched route pattern (e.g. "/api/admin/feedback/:id/review"),
      // never request.raw.url. This prevents randomized admin paths, query strings,
      // and any tokens from ever reaching stdout/stderr. If the route is unknown
      // (e.g. 404-turned-500), fall back to a generic marker.
      const routePattern =
          (request.routeOptions && request.routeOptions.url) ||
          request.routerPath ||
          "<unmatched>";
      console.error(`[error] ${request.method} ${routePattern} -> ${statusCode}`);
      return reply.code(500).send({ ok: false, error: "Internal error." });
    }

    if (error.validation) {
      return reply.code(statusCode).send({ ok: false, error: "Invalid request." });
    }

    if (statusCode === 429) {
      const retryAfterSec = Number(reply.getHeader("retry-after")) || 60;
      return reply.code(429).send({
        ok: false,
        error: `Too many requests. Please retry in ${retryAfterSec}s.`
      });
    }

    return reply.code(statusCode).send({
      ok: false,
      error: error.message || "Request failed."
    });
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const app = await buildApp();

  try {
    await app.listen({ port, host });

    const publicUrl = `${publicBaseUrl}${normalizedPublicPath}`;

    // LOG_PUBLIC_URL default is environment-aware: in production we default to
    // false so the randomized public path is not written to persistent logs
    // (log aggregators, container stdout, etc.). In non-production the URL is
    // convenient to have printed for local development.
    // LOG_ADMIN_URL is intentionally NOT read: the admin URL is sensitive
    // operational data and is never logged, regardless of environment. To see
    // it, read it from the .env file directly on the host.
    const isProduction = process.env.NODE_ENV === "production";
    const logPublicUrl = envFlag(process.env.LOG_PUBLIC_URL, !isProduction);

    console.log(`Server listening on ${publicBaseUrl}`);
    if (logPublicUrl) {
      console.log(`Public feedback URL: ${publicUrl}`);
    } else {
      console.log("Public feedback URL logging disabled (set LOG_PUBLIC_URL=true to enable).");
    }
    console.log("Admin review URL is not logged. Read ADMIN_PATH from your .env file to obtain it.");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    try {
      await app.close();
      closeDatabase();
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      try { closeDatabase(); } catch {}
      process.exit(1);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}