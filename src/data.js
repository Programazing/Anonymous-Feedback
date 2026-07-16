import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "feedback.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
  );
`);

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
  SET reviewed = 1
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
