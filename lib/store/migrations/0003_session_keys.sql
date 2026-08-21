-- Per-session data keys, so a destruction date has something to act on.
--
-- The record itself is append-only and hash-chained, which is correct and which
-- leaves no way to destroy content: audit_entry rejects UPDATE and DELETE, and
-- sessions are referenced `on delete restrict`. Deleting a key is the only
-- deletion the design permits, so the key is what carries the destruction date.
--
-- Keyed by session rather than by subject because a session exists before anyone
-- knows who is on the call. Verification happens several turns in, and the date
-- of birth — the most identifying thing in the whole record — is spoken before
-- it. A key that only came into being at verification would leave exactly that
-- utterance unsealed. subject_id is stamped when verification succeeds, and
-- shredding a subject destroys every key bound to them.
create table session_key (
  session_id   uuid        primary key references check_in_session(id) on delete restrict,
  -- Null until verification succeeds. A session that never verified is shredded
  -- by session id; there is no subject to attach it to and no clinical content
  -- in it either.
  subject_id   text,
  -- Null once destroyed. The row survives so the destruction is provable: an
  -- absent row cannot be told apart from a key that never existed.
  key          bytea,
  created_at   timestamptz not null default now(),
  destroyed_at timestamptz,
  -- Free text, and required when destroying: "who authorised this and under what
  -- retention rule" is the question asked afterwards, and it has to have been
  -- recorded at the time.
  destroyed_reason text,
  constraint session_key_destruction_is_complete
    check ((key is null) = (destroyed_at is not null))
);

create index session_key_subject_idx on session_key (subject_id)
  where subject_id is not null;
