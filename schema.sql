-- El Ranchito record-book schema (D1). Run once:
--   npx wrangler d1 execute el-ranchito-park --file=./schema.sql
--   npx wrangler d1 execute el-ranchito-park --file=./schema.sql --remote
CREATE TABLE IF NOT EXISTS park_state (
  id INTEGER PRIMARY KEY,
  state TEXT,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS park_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
