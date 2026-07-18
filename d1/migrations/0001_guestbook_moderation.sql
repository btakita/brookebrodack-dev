-- Guestbook moderation.
--
-- Entries land as 'pending' and are only served to the public page once an
-- AI moderation pass (scripts/guestbook-moderate.ts) promotes them to
-- 'approved'. Nothing reaches the page without passing that gate.
ALTER TABLE guestbook_entry ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE guestbook_entry ADD COLUMN moderated_at TEXT;
ALTER TABLE guestbook_entry ADD COLUMN moderation_reason TEXT;
-- The public read path is "approved, newest first".
CREATE INDEX IF NOT EXISTS guestbook_entry__status__create_dts
	ON guestbook_entry (status, create_dts DESC);
-- The moderation queue is "pending, oldest first".
CREATE INDEX IF NOT EXISTS guestbook_entry__status__id
	ON guestbook_entry (status, id);
