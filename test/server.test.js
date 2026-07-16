import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set env BEFORE importing server / data modules.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "afb-test-"));
process.env.DB_PATH = path.join(tmpDir, "feedback.sqlite");
process.env.PUBLIC_PATH = "/f/test-public";
process.env.ADMIN_PATH = "/r/test-admin";
process.env.ADMIN_TOKEN = "test-admin-token-1234567890";

const { buildApp } = await import("../src/server.js");
const { closeDatabase } = await import("../src/data.js");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

let app;

// Force a non-Sunday date (2024-01-01 was a Monday) for isSunday()-related tests.
const RealDate = Date;
function stubDateTo(iso) {
  const fixed = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  };
}
function restoreDate() {
  globalThis.Date = RealDate;
}

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  try { closeDatabase(); } catch {}
  restoreDate();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("POST /api/feedback accepts valid input", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: { body: "This is a valid piece of feedback." },
    headers: { "content-type": "application/json" }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("POST /api/feedback rejects too-short input", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: { body: "short" },
    headers: { "content-type": "application/json" }
  });
  assert.equal(res.statusCode, 400);
});

test("unread admin route is blocked on non-Sunday", async () => {
  stubDateTo("2024-01-01T12:00:00Z"); // Monday
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/feedback/unreviewed",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().ok, false);
  } finally {
    restoreDate();
  }
});

test("reviewed route requires admin token", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/feedback/reviewed"
  });
  assert.equal(res.statusCode, 401);

  const ok = await app.inject({
    method: "GET",
    url: "/api/admin/feedback/reviewed",
    headers: { "x-admin-token": ADMIN_TOKEN }
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.ok(Array.isArray(ok.json().items));
});

test("mark-reviewed works", async () => {
  // Insert a fresh feedback item.
  const post = await app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: { body: "Feedback that will be reviewed." },
    headers: { "content-type": "application/json" }
  });
  assert.equal(post.statusCode, 200);

  // Fetch reviewed list length before.
  const before = await app.inject({
    method: "GET",
    url: "/api/admin/feedback/reviewed",
    headers: { "x-admin-token": ADMIN_TOKEN }
  });
  const beforeCount = before.json().items.length;

  // Use raw DB access to find the newly inserted id (unreviewed items).
  const { getUnreviewedFeedback } = await import("../src/data.js");
  const unreviewed = getUnreviewedFeedback();
  assert.ok(unreviewed.length > 0);
  const targetId = unreviewed[unreviewed.length - 1].id;

  const mark = await app.inject({
    method: "POST",
    url: `/api/admin/feedback/${targetId}/review`,
    headers: { "x-admin-token": ADMIN_TOKEN }
  });
  assert.equal(mark.statusCode, 200);
  assert.deepEqual(mark.json(), { ok: true });

  const after = await app.inject({
    method: "GET",
    url: "/api/admin/feedback/reviewed",
    headers: { "x-admin-token": ADMIN_TOKEN }
  });
  assert.equal(after.json().items.length, beforeCount + 1);
  assert.ok(after.json().items.some((i) => i.id === targetId));

  // Mark-reviewed on unknown id returns 404.
  const missing = await app.inject({
    method: "POST",
    url: "/api/admin/feedback/999999/review",
    headers: { "x-admin-token": ADMIN_TOKEN }
  });
  assert.equal(missing.statusCode, 404);
});
