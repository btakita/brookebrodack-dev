-- Soft delete.
--
-- Admin "delete" used to run `DELETE FROM guestbook_entry`, which destroyed the
-- message. Every entry is now retained: deletion sets `deleted_at` and the read
-- paths filter on it. Nothing a visitor wrote is ever removed from the table.
--
-- `deleted_at` is kept separate from `status` on purpose, so a deleted entry
-- still records the moderation verdict it carried when it was removed.
ALTER TABLE guestbook_entry ADD COLUMN deleted_at TEXT;
-- Both read paths are "not deleted, by status" — the public page and the admin
-- queue — so status leads the index and `deleted_at` narrows it.
CREATE INDEX IF NOT EXISTS guestbook_entry__status__deleted_at__create_dts
	ON guestbook_entry (status, deleted_at, create_dts DESC);
-- Listing the deleted entries themselves, newest first.
CREATE INDEX IF NOT EXISTS guestbook_entry__deleted_at
	ON guestbook_entry (deleted_at, create_dts DESC);
