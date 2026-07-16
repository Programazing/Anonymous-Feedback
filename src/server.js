import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import {
  insertFeedback,
  getUnreviewedFeedback,
  getReviewedFeedback,
  markFeedbackReviewed
} from "./data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

const app = Fastify({
  logger: false
});

await app.register(fastifyStatic, {
  root: publicDir,
  serve: false
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const publicPath = process.env.PUBLIC_PATH || "/f/replace-me";
const adminPath = process.env.ADMIN_PATH || "/r/replace-me";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

function isSunday() {
  const now = new Date();
  return now.getDay() === 0;
}

function trimBody(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(value, fallback) {
  if (!value || typeof value !== "string") {
    return fallback;
  }

  return value.startsWith("/") ? value : `/${value}`;
}

const normalizedPublicPath = normalizePath(publicPath, "/f/replace-me");
const normalizedAdminPath = normalizePath(adminPath, "/r/replace-me");

app.get(normalizedPublicPath, async (request, reply) => {
  return reply.sendFile("index.html");
});

app.get(normalizedAdminPath, async (request, reply) => {
  return reply.sendFile("admin.html");
});

app.post("/api/feedback", {
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
  const body = trimBody(request.body.body);

  if (!body) {
    return reply.code(400).send({ ok: false, error: "Feedback is required." });
  }

  if (body.length < 10) {
    return reply.code(400).send({ ok: false, error: "Feedback must be at least 10 characters." });
  }

  insertFeedback(body);
  return reply.send({ ok: true });
});

app.get("/api/admin/feedback/unreviewed", async (request, reply) => {
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

app.get("/api/admin/feedback/reviewed", async (request, reply) => {
  return reply.send({
    ok: true,
    items: getReviewedFeedback()
  });
});

app.post("/api/admin/feedback/:id/review", {
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

try {
  await app.listen({ port, host });

  const publicUrl = `${publicBaseUrl}${normalizedPublicPath}`;
  const adminUrl = `${publicBaseUrl}${normalizedAdminPath}`;

  console.log(`Server listening on ${publicBaseUrl}`);
  console.log(`Public feedback URL: ${publicUrl}`);
  console.log(`Admin review URL: ${adminUrl}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
