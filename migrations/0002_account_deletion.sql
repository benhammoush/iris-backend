-- Durable work and status metadata only; never retain saved references for recovery.
ALTER TABLE watchlist_accounts ADD COLUMN deletion_id TEXT;
ALTER TABLE watchlist_accounts ADD COLUMN deletion_at INTEGER;
ALTER TABLE watchlist_accounts ADD COLUMN completed_at INTEGER;
ALTER TABLE watchlist_accounts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_accounts ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_accounts ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX watchlist_deletion_id ON watchlist_accounts(deletion_id);
CREATE INDEX watchlist_cleanup_due ON watchlist_accounts(state, next_attempt_at);
CREATE INDEX watchlist_orphan_scan ON watchlist_accounts(state, checked_at, uid);
CREATE INDEX watchlist_completed ON watchlist_accounts(state, completed_at);
