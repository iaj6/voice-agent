-- Index supporting the dropped-call claim.
--
-- claimResumable looks for the most recent *open* session for a subject, and
-- open sessions are a small and shrinking fraction of the table: every finished
-- call sets completed_at and leaves the set. The existing index spans the whole
-- table, so the lookup that decides whether a live call gets locked out from
-- under a participant scans finished records to find the one it wants.
--
-- Partial, because a predicate on completed_at is null keeps the index the size
-- of the calls actually in progress rather than the size of the study.
--
-- Strict DDL, deliberately: no "if not exists". 0001 is a baseline and carries
-- the guards it needs to adopt a database that already existed. From here on a
-- migration that cannot apply cleanly should fail and say so, not shrug.
create index check_in_session_open_idx
  on check_in_session (subject_id, created_at desc)
  where completed_at is null;
