import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Nova's persistent storage — real user accounts now that Nova is meant to
 * support more than one person, not just the "demo-user" hardcoded
 * everywhere before. Uses Node's own built-in `node:sqlite` (stable on the
 * Node 24 this project runs on) rather than adding a native dependency like
 * better-sqlite3 — one less thing that can fail to build on someone else's
 * machine, consistent with this project's preference for fewer dependencies
 * generally (raw fetch over heavy SDKs, etc.).
 *
 * A single file on disk (backend/data/nova.db) is the right amount of
 * database for a personal project run from one machine. It will NOT survive
 * a real multi-instance deployment (e.g. serverless, multiple servers behind
 * a load balancer) — that's a real, later problem, not one to solve
 * speculatively now.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "nova.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,              -- the user's own phone number (E.164-ish), doubles as the Composio/GPT-Live "userId" used everywhere else
    phone_number TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    phone_number TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
