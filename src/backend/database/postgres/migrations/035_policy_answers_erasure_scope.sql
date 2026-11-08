-- P1-2 (docs/architecture/db-schema-review.md): the document-erasure trigger deleted citing policy_answers with no
-- household predicate, so every erased document parsed document_ids_json of every answer of every household.
-- Scope the delete to the erased document's household; policy_answers_case_idx (household_id, case_id, created_at) serves it.
-- A document id is unique and an answer only cites documents of its own household, so no citing answer is missed.
-- Behaviour-preserving for one tenant; no table change. Rollback: re-run the 012 function body.
CREATE OR REPLACE FUNCTION public.policy_evidence_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.policy_answers
  WHERE policy_answers.household_id = NEW.household_id
    AND EXISTS (SELECT 1 FROM json_array_elements_text(policy_answers.document_ids_json::json) AS cited(value) WHERE cited.value = NEW.id);
  DELETE FROM public.policy_clauses WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;
