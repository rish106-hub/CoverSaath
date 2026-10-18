-- Complete the declared append-only and immutable semantics for facts and registry pins.
-- UPDATE was already blocked. DELETE must fail with the same stable messages.

CREATE TRIGGER evidence_facts_no_delete
BEFORE DELETE ON evidence_facts
BEGIN
  SELECT RAISE(ABORT, 'evidence facts are append only; add a superseding fact');
END;

CREATE TRIGGER coverage_parameter_registry_pins_no_delete
BEFORE DELETE ON coverage_parameter_registry_pins
BEGIN
  SELECT RAISE(ABORT, 'registry pins are immutable');
END;

