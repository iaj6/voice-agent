-- Acknowledgement is a lookup by token hash, and there was no index on it.
--
-- Every click scanned the whole table, twice on the already-acknowledged path.
-- Unique as well as indexed: two deliveries sharing a token would mean one
-- click acknowledging the wrong escalation, which the column's own design —
-- store the hash, never the token — exists to make impossible.
create unique index escalation_delivery_ack_token_idx
  on escalation_delivery (ack_token_hash)
  where ack_token_hash is not null;
