-- Subject-level state, which the schema had nowhere to put.
--
-- Everything until now was keyed by session: there was no row that represents a
-- participant across their calls, so there was nowhere to record that someone
-- has withdrawn. The safety net already *detects* a withdrawal statement and
-- escalates it — "withdraw from the study" is a matched phrase — and then
-- nothing acted on it. The intent was captured, paged to a coordinator, and the
-- next scheduled call went ahead exactly as before.
--
-- Withdrawal stops future collection. It does not unmake what was lawfully
-- collected already: under ICH E6 and EDPB Opinion 3/2019, withdrawing informed
-- consent does not retroactively invalidate the data gathered before it. That is
-- why this table records a state rather than triggering a deletion, and why
-- shredding is a separate, deliberate act with its own authorisation.
create table subject_state (
  subject_id     text        primary key,
  withdrawn_at   timestamptz,
  -- Who recorded it and why. A withdrawal that cannot say who accepted it is not
  -- evidence of anything.
  withdrawn_by   text,
  withdrawn_note text,
  updated_at     timestamptz not null default now(),
  constraint subject_state_withdrawal_is_attributable
    check ((withdrawn_at is null) = (withdrawn_by is null))
);
