import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(path.resolve("data"), "feedback.sqlite");

const dbDir = path.dirname(dbPath);

// Ensure the DB directory exists and is writable BEFORE opening SQLite.
// Failing fast here (with a clear error) is much easier to debug than a
// cryptic "unable to open database file" from better-sqlite3 later.
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (err) {
  throw new Error(
    `Failed to create database directory "${dbDir}": ${err.message}. ` +
    `Check that the parent path exists and that the process user has write permission ` +
    `(in Docker: ensure the /app/data volume is writable by the "node" user).`
  );
}

try {
  fs.accessSync(dbDir, fs.constants.W_OK);
} catch (err) {
  throw new Error(
    `Database directory "${dbDir}" is not writable by the current process user: ${err.message}. ` +
    `Fix filesystem permissions (chown/chmod) or the Docker volume mount before starting the app.`
  );
}

let db;
try {
  db = new Database(dbPath);
} catch (err) {
  throw new Error(
    `Failed to open SQLite database at "${dbPath}": ${err.message}. ` +
    `The application cannot start without a working database.`
  );
}

// Pragmas:
//   journal_mode=WAL       -> better concurrency for readers vs. a single writer.
//   busy_timeout=5000      -> wait up to 5s on a locked DB instead of immediately
//                             throwing SQLITE_BUSY under concurrent writes.
//   synchronous=NORMAL     -> safe with WAL, faster than FULL.
//   foreign_keys=ON        -> enforce FK constraints if/when added later.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    reviewed_at TEXT
  );
`);

// Lightweight in-place migration for databases created before the auditing
// columns existed. SQLite's ALTER TABLE ADD COLUMN is cheap and idempotent
// when guarded like this.
const existingColumns = new Set(
  db.prepare("PRAGMA table_info(feedback)").all().map((row) => row.name)
);
if (!existingColumns.has("created_at")) {
  // NOTE: SQLite disallows non-constant defaults in ALTER TABLE, so backfill
  // existing rows explicitly after adding the column as nullable.
  db.exec("ALTER TABLE feedback ADD COLUMN created_at TEXT");
  db.exec(
    "UPDATE feedback SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE created_at IS NULL"
  );
}
if (!existingColumns.has("reviewed_at")) {
  db.exec("ALTER TABLE feedback ADD COLUMN reviewed_at TEXT");
}

db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_reviewed ON feedback(reviewed)");

const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedback (body, reviewed)
  VALUES (?, 0)
`);

const getUnreviewedStmt = db.prepare(`
  SELECT id, body
  FROM feedback
  WHERE reviewed = 0
  ORDER BY id ASC
`);

const getReviewedStmt = db.prepare(`
  SELECT id, body
  FROM feedback
  WHERE reviewed = 1
  ORDER BY id DESC
`);

const markReviewedStmt = db.prepare(`
  UPDATE feedback
  SET reviewed = 1,
      reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

export function insertFeedback(body) {
  return insertFeedbackStmt.run(body);
}

export function getUnreviewedFeedback() {
  return getUnreviewedStmt.all();
}

export function getReviewedFeedback() {
  return getReviewedStmt.all();
}

export function markFeedbackReviewed(id) {
  return markReviewedStmt.run(id);
}

export function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

// Lightweight readiness probe: runs a trivial query against the DB.
// Returns true if the DB is open and responsive, false otherwise.
// Intended for use by /healthz or an orchestrator readiness check so the
// container is marked unhealthy if the SQLite file becomes unreadable
// (e.g. permissions changed, volume detached).
export function pingDatabase() {
  try {
    if (!db.open) return false;
    const row = db.prepare("SELECT 1 AS ok").get();
    return row && row.ok === 1;
  } catch {
    return false;
  }
}

export function getDatabasePath() {
  return dbPath;
}
