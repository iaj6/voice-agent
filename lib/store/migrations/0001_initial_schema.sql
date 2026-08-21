-- ONX-301 check-in persistence — baseline.
--
-- The first migration, and the only one allowed to be idempotent. It has to be:
-- it was adopted from a database that already existed, so it must apply cleanly
-- whether the objects are there or not. Every migration after this one is strict
-- DDL, and a migration that cannot apply is a failure rather than a no-op.
--
-- Never edit this file. The runner checksums applied migrations and refuses to
-- start when one has changed underneath a database, because a schema that no
-- longer matches its own recorded history cannot say which shape a record was
-- captured under. Change the schema by adding a migration.
--
-- Two tables with deliberately different characters. `check_in_session` is
-- mutable working state — the conversation and the clinical record as they
-- accumulate during a call. `audit_entry` is the regulated record, and it is
-- append-only at the schema level rather than by convention.

create table if not exists check_in_session (
  id            uuid primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  status        text        not null,
  subject_id    text,
  -- The instrument that produced this record: model, voice, prompt hash.
  -- A record that cannot say which version of the agent captured it is not
  -- reconstructable, and reconstructability is the whole point (SPEC.md §7).
  instrument    jsonb       not null default '{}'::jsonb,
  -- Clinical record: adverse events, safety screen, adherence, con meds,
  -- escalations. Held as a document because it is written and read whole, and
  -- because its shape is still moving.
  record        jsonb       not null,
  -- The model conversation, replayed verbatim on resume.
  messages      jsonb       not null,
  summary       text,
  completed_at  timestamptz
);

create index if not exists check_in_session_subject_idx
  on check_in_session (subject_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

create table if not exists audit_entry (
  session_id   uuid        not null references check_in_session(id) on delete restrict,
  seq          integer     not null,
  recorded_at  timestamptz not null,
  actor        text        not null,
  action       text        not null,
  entity       text        not null,
  entity_id    text,
  before_value jsonb,
  after_value  jsonb,
  reason       text        not null,
  prev_hash    char(64)    not null,
  hash         char(64)    not null,
  -- Written once, at insert. Distinct from recorded_at, which is the
  -- application's clock: a gap between them is itself evidence.
  inserted_at  timestamptz not null default now(),
  primary key (session_id, seq),
  constraint audit_entry_hash_unique unique (hash)
);

create index if not exists audit_entry_session_idx on audit_entry (session_id, seq);

-- 21 CFR 11.10(e) requires that an audit trail not obscure previously recorded
-- information. A hash chain makes tampering *detectable*; this makes the
-- ordinary paths to it *impossible*. The threat being defended against is an
-- application bug — a careless UPDATE in code written six months from now —
-- not a determined operator with owner rights, who can drop this trigger. That
-- is the honest scope of the guarantee.
create or replace function audit_entry_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'audit_entry is append-only: % on session % seq % was rejected',
    tg_op, coalesce(old.session_id::text, '?'), coalesce(old.seq::text, '?')
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists audit_entry_no_mutate on audit_entry;
create trigger audit_entry_no_mutate
  before update or delete on audit_entry
  for each row execute function audit_entry_is_append_only();

-- A session that has been completed is locked. The record stops being working
-- state and becomes the thing a coordinator reviews.
create or replace function check_in_session_locked_when_complete()
returns trigger
language plpgsql
as $$
begin
  if old.completed_at is not null then
    raise exception
      'check_in_session % is complete and locked; further writes were rejected', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists check_in_session_lock on check_in_session;
create trigger check_in_session_lock
  before update on check_in_session
  for each row execute function check_in_session_locked_when_complete();
