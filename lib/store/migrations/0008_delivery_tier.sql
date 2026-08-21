-- Which contact in the escalation ladder a delivery went to.
--
-- The table already holds one row per attempt, which is the right shape for a
-- retry. A secondary contact is not a retry — it is the same escalation reaching
-- a different person because the first one did not respond — and an alarm is
-- neither. Without this column the sweeper cannot tell "we have already paged
-- the backup" from "we have tried twice", so it would either page the backup
-- repeatedly or never.
alter table escalation_delivery
  add column tier text not null default 'primary';

alter table escalation_delivery
  add constraint escalation_delivery_tier_known
  check (tier in ('primary', 'secondary', 'alarm'));

-- The sweeper's working set: what has been tried for an escalation, and at which
-- rung. Partial, because acknowledged escalations leave the ladder entirely.
create index escalation_delivery_ladder_idx
  on escalation_delivery (session_id, escalation_id, tier)
  where acknowledged_at is null;
