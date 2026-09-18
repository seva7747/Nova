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
    id TEXT PRIMARY KEY,              -- a slug derived from "First Last" (see services/auth.ts's slugifyName) — this IS the Composio/GPT-Live "userId" used everywhere else
    display_name TEXT,                -- "First Last" as typed
    phone_number TEXT UNIQUE,         -- only set for accounts created by texting Nova's number (see smsDelegate.ts) — nullable, since name-based sign-in never sets it
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Self-healing migration for the OLD schema (back when a phone number WAS
// the identity, before name-based sign-in): phone_number used to be NOT
// NULL, which breaks every name-based sign-up. CONFIRMED BY TESTING: deleting
// backend/data/nova.db by hand to force a fresh schema doesn't reliably
// work either — this project's folder lives inside OneDrive sync, which
// silently restored the deleted file from its own cache a moment later. So
// migrate in place instead of depending on the file being gone. SQLite has
// no ALTER COLUMN to drop a NOT NULL constraint directly — the standard
// workaround is rebuild-and-swap.
const usersInfo = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string; notnull: number }>;
const phoneNumberCol = usersInfo.find((c) => c.name === "phone_number");
if (phoneNumberCol?.notnull) {
  console.log("[db] migrating users table: phone_number NOT NULL → nullable (old phone-based schema)");
  db.exec(`
    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      phone_number TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users_new (id, display_name, phone_number, created_at) SELECT id, display_name, phone_number, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
}
