-- ============================================================================
-- Al-Rifai Data Game — additive migration (safe to run many times).
-- Creates ONLY new tables; never alters/drops/rewrites any existing ERP table.
-- Applied automatically at server start by src/db/gameSchema.js, and can also
-- be pasted into the Supabase SQL editor.
-- Rollback (manual, only if you ever need it):
--   DROP TABLE game_achievements, game_actions, game_task_skips,
--              game_task_claims, game_field_state;
-- ============================================================================

-- 1) Per-field verification state. Missing/non-missing is derived live from
--    `products`; this table only remembers "a human confirmed THIS value".
--    value_snapshot makes verification self-invalidating: if the ERP changes
--    the value later, the snapshot no longer matches and the field becomes
--    unverified again automatically (no triggers on the ERP tables needed).
CREATE TABLE IF NOT EXISTS game_field_state (
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field          TEXT    NOT NULL CHECK (field IN ('name','sale_price','cost_price','category','color','image')),
  status         TEXT    NOT NULL CHECK (status IN ('verified','rejected')),
  value_snapshot TEXT,
  actor_id       INTEGER REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, field)
);

-- 2) Task leases. Tasks themselves are NOT stored (they are derived from
--    unresolved fields); only the short-lived claim on one (product, task) is.
--    The partial unique index is the actual concurrency guarantee: the
--    database refuses a 2nd ACTIVE claim for the same (product, task_key).
CREATE TABLE IF NOT EXISTS game_task_claims (
  id          BIGSERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  task_key    TEXT    NOT NULL,  -- field name, or 'count:<location_id>'
  kind        TEXT    NOT NULL CHECK (kind IN ('missing','verify','replace','count')),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','completed','skipped','released','expired')),
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_active_claim
  ON game_task_claims (product_id, task_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_game_claims_user_active
  ON game_task_claims (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_game_claims_expiry
  ON game_task_claims (expires_at) WHERE status = 'active';

-- 3) Skip history (rotation / cooldown per user).
CREATE TABLE IF NOT EXISTS game_task_skips (
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  task_key        TEXT    NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  skip_count      INTEGER NOT NULL DEFAULT 1,
  last_skipped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, task_key, user_id)
);

-- 4) Append-only action ledger: source of truth for XP, streaks, achievements,
--    idempotency (request_id) and the game-side audit trail. XP is written by
--    the server only. product_id has no FK on purpose so history survives a
--    product deletion.
CREATE TABLE IF NOT EXISTS game_actions (
  id          BIGSERIAL PRIMARY KEY,
  request_id  TEXT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  product_id  INTEGER,
  task_key    TEXT,
  action      TEXT NOT NULL CHECK (action IN
              ('confirm','set','upload','count','reject_image','skip','product_complete','conflict')),
  old_value   TEXT,
  new_value   TEXT,
  xp          INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  claim_id    BIGINT,
  location_id INTEGER,
  detail      TEXT,
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_actions_request ON game_actions (request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_product_complete ON game_actions (product_id) WHERE action = 'product_complete';
CREATE INDEX IF NOT EXISTS idx_game_actions_user_time ON game_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_actions_time ON game_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_actions_conflict ON game_actions (created_at DESC) WHERE action = 'conflict';

-- 5) Unlocked achievements (definitions live in code; unlocks are server-side).
CREATE TABLE IF NOT EXISTS game_achievements (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code        TEXT    NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code)
);

-- Defense in depth: if Supabase's public REST API (PostgREST) is enabled, the
-- anon/authenticated roles get ZERO access to these tables (RLS on, no
-- policies). The app talks to Postgres only through the Node server, which
-- connects as the table owner and bypasses RLS.
ALTER TABLE game_field_state   ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_task_claims   ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_task_skips    ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_actions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_achievements  ENABLE ROW LEVEL SECURITY;
