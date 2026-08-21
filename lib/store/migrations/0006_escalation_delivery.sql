-- Whether an escalation actually reached a human.
--
-- Until now the system recorded that a coordinator was notified and the agent
-- told the participant so out loud — "your coordinator has been alerted" — while
-- nothing had been sent anywhere. SPEC.md's own risk table names it: escalation
-- not delivered, participant harm, record claims otherwise. This table is what
-- turns that claim into something the record can support.
--
-- One row per attempt, not per escalation. A retry is a new attempt with its own
-- outcome, and collapsing them would lose the fact that the first one failed —
-- which is the part a monitor asks about.
create table escalation_delivery (
  id              uuid        primary key,
  session_id      uuid        not null references check_in_session(id) on delete restrict,
  -- ESC-001 and friends; unique within a session, not globally.
  escalation_id   text        not null,
  subject_id      text,
  urgency         text        not null,
  channel         text        not null,
  -- The coordinator's address. Site staff, not a participant, so this is not
  -- subject data and is deliberately not sealed — a destination nobody can read
  -- cannot be audited for having been the wrong one.
  destination     text        not null,
  attempt         integer     not null default 1,
  -- queued -> sent -> acknowledged, or queued -> failed.
  status          text        not null,
  provider_id     text,
  error           text,
  -- Only the hash. The token goes out in the link and is never stored, so a
  -- database read cannot forge an acknowledgement — the same reason a password
  -- reset token is stored this way.
  ack_token_hash  char(64),
  acknowledged_at timestamptz,
  acknowledged_by text,
  -- When this stops being "in flight" and starts being a problem. Set from the
  -- urgency at send time rather than computed on read, so a change to the SLA
  -- table does not silently rewrite whether past escalations were late.
  deadline_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (session_id, escalation_id, attempt)
);

create index escalation_delivery_open_idx
  on escalation_delivery (deadline_at)
  where acknowledged_at is null and status <> 'failed';

create index escalation_delivery_session_idx
  on escalation_delivery (session_id, escalation_id);
