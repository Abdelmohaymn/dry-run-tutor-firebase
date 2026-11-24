-- Firebase relay (feature 010). A turn now commits only on the final step of
-- the step protocol, so a retried final POST must not spend a second turn.
-- last_turn_key is the learner message's turn_key of the last committed turn;
-- last_turn_index is the `turns` value that commit produced. Both are
-- cap-enforcing bookkeeping, never message content.
ALTER TABLE device_day ADD COLUMN last_turn_key TEXT;
ALTER TABLE device_day ADD COLUMN last_turn_index INTEGER;
