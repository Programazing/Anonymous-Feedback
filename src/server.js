import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyHelmet from "@fastify/helmet";
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

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publicPath = process.env.PUBLIC_PATH;
const adminPath = process.env.ADMIN_PATH;
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const normalizedPublicPath = normalizePath(publicPath, "/f/replace-me");
const normalizedAdminPath = normalizePath(adminPath, "/r/replace-me");

export async function buildApp() {
  const app = Fastify({
    logger: true,
    bodyLimit: 16 * 1024
  });

  await app.register(fastifyHelmet, {
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
    const queryToken = request.query && request.query.token;
    const provided = typeof headerToken === "string"
        ? headerToken
        : typeof queryToken === "string"
            ? queryToken
            : "";

    if (!timingSafeEqualStr(provided, adminToken)) {
      return reply.code(401).send({ ok: false, error: "Unauthorized." });
    }
  }

  function isSunday() {
    const now = new Date();
    return now.getDay() === 0;
  }

  app.addHook("onRequest", async (request) => {
    app.log.info({
      method: request.method,
      url: request.url,
      normalizedPublicPath,
      normalizedAdminPath
    }, "incoming request");
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const url = request.raw.url || "";
    const routeUrl = url.split("?")[0];
    if (
        routeUrl === normalizedPublicPath ||
        routeUrl === normalizedAdminPath ||
        routeUrl === "/debug/routes" ||
        routeUrl === "/healthz" ||
        routeUrl.startsWith("/api/")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get("/healthz", async () => {
    return {
      ok: true,
      port,
      host
    };
  });

  app.get("/debug/routes", async () => {
    return {
      ok: true,
      publicPath: normalizedPublicPath,
      adminPath: normalizedAdminPath,
      host,
      port,
      publicBaseUrl,
      cwd: process.cwd()
    };
  });

  app.get("/", async (request, reply) => {
    return reply.redirect(normalizedPublicPath);
  });

  app.get(normalizedPublicPath, async (request, reply) => {
    app.log.info({ file: "index.html" }, "serving public form");
    return reply.sendFile("index.html");
  });

  app.get(normalizedAdminPath, { preHandler: requireAdminToken }, async (request, reply) => {
    app.log.info({ file: "admin.html" }, "serving admin page");
    return reply.sendFile("admin.html");
  });

  app.post("/api/feedback", {
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
    app.log.warn({ url: request.url }, "route not found");
    reply.code(404).send({ ok: false, error: "Not found." });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      app.log.error({ err: error, method: request.method, url: request.url }, "request failed");
      return reply.code(500).send({ ok: false, error: "Internal error." });
    }

    if (error.validation) {
      return reply.code(statusCode).send({ ok: false, error: "Invalid request." });
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
    const adminUrl = `${publicBaseUrl}${normalizedAdminPath}`;

    const logPublicUrl = (process.env.LOG_PUBLIC_URL ?? "true").toLowerCase() !== "false";
    const logAdminUrl = (process.env.LOG_ADMIN_URL ?? "false").toLowerCase() === "true";

    app.log.info({
      port,
      host,
      publicBaseUrl,
      normalizedPublicPath,
      normalizedAdminPath,
      cwd: process.cwd()
    }, "server configuration");

    console.log(`Server listening on ${publicBaseUrl}`);
    if (logPublicUrl) {
      console.log(`Public feedback URL: ${publicUrl}`);
    } else {
      console.log("Public feedback URL logging disabled (set LOG_PUBLIC_URL=true to enable).");
    }
    if (logAdminUrl) {
      console.log(`Admin review URL: ${adminUrl}`);
    } else {
      console.log("Admin review URL logging disabled (set LOG_ADMIN_URL=true to enable).");
    }
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