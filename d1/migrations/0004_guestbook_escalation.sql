-- Record that a panel looked at an entry and declined to decide.
--
-- `escalate` deliberately writes no status: the entry stays `pending` for a
-- human, which is the whole point of the vocabulary. But nothing recorded it
-- either, so the dispatch hub kept re-offering the same entries on every notify
-- and every alarm and the panel re-judged them forever. Seen live: two
-- identical jobs for the same two entries eight seconds apart. Harmless with a
-- rules-only panel; once a model plugin answers, it is a bill.
--
-- `escalated_by` names the panel, not just the fact, because "already
-- escalated" must not mean "never look again". A rules-only freehold escalates
-- nearly everything; the cron sweep's model panel would then never see those
-- entries at all. Skipping re-offer only to the SAME panel keeps the loop
-- closed while leaving every better panel its first look.
--
-- Nullable and unset for existing rows: an entry nobody has judged reads as
-- "no panel has escalated this", which is exactly true.
ALTER TABLE guestbook_entry ADD COLUMN escalated_at TEXT;
ALTER TABLE guestbook_entry ADD COLUMN escalated_by TEXT;

-- Every automatic judge path filters on this pair, and every one of them is
-- already narrowed to pending, undeleted rows.
CREATE INDEX IF NOT EXISTS guestbook_entry__escalated_by__idx
	ON guestbook_entry (status, escalated_by);
