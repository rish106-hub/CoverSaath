-- job_queue hardening. payload_json was only length-capped (034); the repository writes a flat JSON object of identifier values,
-- but the database accepted any text under 1 KiB. Require a JSON object, like the other JSON text columns (IS JSON OBJECT).
-- Added NOT VALID then validated in the same file: VALIDATE takes only SHARE UPDATE EXCLUSIVE, so writes are not blocked, and
-- every existing row is either the '{}' default or written by JobQueueRepository.enqueue (a JSON object), so it passes.
-- Rollback: ALTER TABLE public.job_queue DROP CONSTRAINT job_queue_payload_json_object_check.
ALTER TABLE public.job_queue ADD CONSTRAINT job_queue_payload_json_object_check CHECK (payload_json IS JSON OBJECT) NOT VALID;
ALTER TABLE public.job_queue VALIDATE CONSTRAINT job_queue_payload_json_object_check;
