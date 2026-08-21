-- Reinstatement, recorded rather than erased.
--
-- Un-withdrawing used to null out withdrawn_at, withdrawn_by and withdrawn_note,
-- so after a withdraw-then-reinstate nothing said the participant had ever
-- withdrawn, or that a check-in had been refused while they had. In a table
-- whose whole premise is that a withdrawal which cannot say who accepted it is
-- not evidence of anything, withdrawal was attributable and un-withdrawal was
-- not — and the more consequential of the two is the one that puts a
-- participant back into collection.
--
-- Withdrawal is now current when withdrawn_at is set and no later reinstatement
-- has superseded it, which also makes repeated cycles legible instead of
-- destructive.
alter table subject_state add column reinstated_at timestamptz;
alter table subject_state add column reinstated_by text;

alter table subject_state
  add constraint subject_state_reinstatement_is_attributable
  check ((reinstated_at is null) = (reinstated_by is null));
