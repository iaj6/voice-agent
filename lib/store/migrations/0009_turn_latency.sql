-- What a participant actually waited, per turn.
--
-- N-01 asks for time to first audio under 2s at p50 and 4s at p95, and until now
-- that was an assertion: "~2.5s p50, unmeasured p95". A voice agent's whole
-- failure mode is dead air, and a requirement nobody measures is a requirement
-- nobody meets.
--
-- The headline number is `first_audio_ms`, and it can only be observed in the
-- browser — the server knows when it dispatched a sentence, not when the
-- participant heard one. The server segments are here so a bad p95 can be
-- attributed rather than just noticed: a slow model, a slow first sentence, or a
-- slow synthesis are three different problems with three different fixes.
create table turn_latency (
  id text primary key,
  session_id uuid not null references check_in_session (id) on delete cascade,
  -- Which turn of the call, so an opening turn is distinguishable from a
  -- mid-screen one. The first turn includes answering the phone; the rest do not.
  turn_index integer not null,
  -- 'subject' or 'system'. The call-start turn is not a participant waiting for
  -- an answer, and averaging it in flatters the number.
  source text not null,
  -- Dispatch to audible, measured in the browser. Null when the turn produced no
  -- speech at all, which is itself worth being able to count.
  first_audio_ms integer,
  -- Server-side attribution, all measured from the moment the turn arrived.
  first_token_ms integer,
  first_sentence_ms integer,
  total_ms integer,
  -- Whether the turn made tool calls before speaking. The acknowledge-before-
  -- tools rule exists because it did, and this is how you tell if it held.
  spoke_before_tools boolean,
  created_at timestamptz not null default now(),
  -- The server writes its segments when the turn ends; the browser reports what
  -- it heard whenever it hears it, which can be either side of that. Keying on
  -- the turn lets whichever arrives first create the row and the other fill it
  -- in, so neither has to wait for the other or know it happened.
  unique (session_id, turn_index)
);

-- The reporting query is "every measured turn for a window of calls", newest
-- first, and the p95 is only meaningful across a lot of them.
create index turn_latency_created_idx on turn_latency (created_at desc);
