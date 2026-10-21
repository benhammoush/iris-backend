-- Private identity lifecycle is separate from public market KV data.
CREATE TABLE watchlist_accounts (
  uid TEXT PRIMARY KEY NOT NULL CHECK(length(uid) BETWEEN 1 AND 128),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'deleting', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE watchlist_items (
  owner_uid TEXT NOT NULL REFERENCES watchlist_accounts(uid) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('asset', 'wallet')),
  address TEXT NOT NULL COLLATE BINARY,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_uid, kind, address)
);

CREATE INDEX watchlist_order ON watchlist_items(owner_uid, kind, saved_at DESC, address);

CREATE TRIGGER watchlist_insert_guard BEFORE INSERT ON watchlist_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM watchlist_accounts WHERE uid = NEW.owner_uid AND state = 'active'
  ) THEN RAISE(ABORT, 'ACCOUNT_DELETING') END;
  -- Duplicates at capacity still succeed and never update saved_at.
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM watchlist_items
    WHERE owner_uid = NEW.owner_uid AND kind = NEW.kind AND address = NEW.address
  ) AND (SELECT COUNT(*) FROM watchlist_items
    WHERE owner_uid = NEW.owner_uid AND kind = NEW.kind) >= 100
  THEN RAISE(ABORT, 'WATCHLIST_LIMIT_REACHED') END;
END;

CREATE TRIGGER watchlist_update_guard BEFORE UPDATE ON watchlist_items
BEGIN
  SELECT RAISE(ABORT, 'WATCHLIST_ITEMS_IMMUTABLE');
END;
