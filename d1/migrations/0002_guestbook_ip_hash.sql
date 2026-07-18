-- Salted hash of the submitter's IP, used only for submission rate limiting.
-- The raw IP is never stored.
ALTER TABLE guestbook_entry ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS guestbook_entry__ip_hash__create_dts
	ON guestbook_entry (ip_hash, create_dts DESC);
