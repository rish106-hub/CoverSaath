// Allow-list of every slot a model input may carry (ADR 0017 D2), keyed by task. Data only: privacy-evidence-gate.js
// walks a draft against this table in sealModelInput and is the single place that can mint the result.
//
// Slot types: gated (a GatedText), gated? (GatedText or null), id / alias (string that must match `pattern`),
// int (integer in [min, max], `nullable` allows null), enum (member of `values`), static (a fixed label the gate
// leaves unchanged), structured (gate-sanitised upstream, minted only by sanitizeEvidenceForModel),
// array (`of`, [min, max]) and object (exactly `fields`).
//
// FOR LEGAL REVIEW: which slots may carry personal data after gating is a draft classification (see
// docs/architecture/dpdp-purpose-registry.md).
import { CLAUSE_KINDS } from '../../contracts/policy-evidence.js';
import { POLICY_PARAMETER_REGISTRY_VERSION, POLICY_PARAMETER_VALUE_TYPES, getPolicyParameterRegistry } from '../coverage-analysis/policy-parameter-registry.js';
import {
  EVIDENCE_INVESTIGATE_TASK, EVIDENCE_SWEEP_TASK, INVESTIGATION_CHECKLIST_KINDS, STRUCTURING_CHUNK_KINDS,
  MAX_CHUNK_BLOCK_INDEXES, STRUCTURING_EXTRACT_TASK, STRUCTURING_RECONCILE_TASK,
} from './structuring-contract.js';

const gated = Object.freeze({ type: 'gated' });
const gatedOrNull = Object.freeze({ type: 'gated?' });
const id = (pattern) => Object.freeze({ type: 'id', pattern });
const int = (min, max, { nullable = false } = {}) => Object.freeze({ type: 'int', min, max, nullable });
const enumOf = values => Object.freeze({ type: 'enum', values: Object.freeze([...values]) });
const array = (of, min, max) => Object.freeze({ type: 'array', of, min, max });
// `allowed` (optional): the sealed object must equal one of these entries exactly (JSON text, fields in table order).
const object = (fields, allowed = null) => Object.freeze({ type: 'object', fields: Object.freeze(fields), allowed });
// Registry keys and labels are code constants. A `static` slot takes a value only if it is a registry label (and `registryKey` only a
// registry key) of the registry version in force: membership, not a shape that text could satisfy or a gate check that cannot know
// the household's names. A new registry version means a new entry here.
const REGISTRY = getPolicyParameterRegistry(POLICY_PARAMETER_REGISTRY_VERSION).parameters;
// Only entries the registry allows a model to extract (modelExtraction.allowed) may be sent: a restricted entry such as a
// contract identifier or named members must be refused by the seal, exactly as registryCatalog() leaves it out.
const MODEL_REGISTRY = REGISTRY.filter(entry => entry.modelExtraction.allowed);
const registryKey = Object.freeze({ type: 'enum', values: Object.freeze(MODEL_REGISTRY.map(entry => entry.key)) });
// A registry entry is sent only as the registry spells it: key, label and value type together, never a mix of two entries.
const REGISTRY_ENTRIES = new Set(MODEL_REGISTRY.map(entry => JSON.stringify({ key: entry.key, label: entry.label, valueType: entry.valueType })));
const staticLabel = Object.freeze({ type: 'static', values: Object.freeze([...new Set(MODEL_REGISTRY.map(entry => entry.label))]) });

// Opaque aliases for database record ids (ADR 0017 Phase 3): a model never sees a raw clause or document id.
export const CLAUSE_ALIAS_PATTERN = /^clause_[0-9a-f]{24}$/;
export const DOCUMENT_ALIAS_PATTERN = /^doc_[0-9a-f]{24}$/;
const clauseAlias = id(CLAUSE_ALIAS_PATTERN);
const documentAlias = id(DOCUMENT_ALIAS_PATTERN);

const MAX_PAGE = 10_000;

const wireClause = object({
  clause_id: clauseAlias, document_id: documentAlias, page: int(1, MAX_PAGE, { nullable: true }),
  kind: enumOf(CLAUSE_KINDS), title: gatedOrNull, text: gated,
});
const question = array(object({ text: gated }), 1, 1);

// Coverage tasks: the gate builds the whole request (sanitizeEvidenceForModel). Everything free-text is a gated slot.
const coverageInput = object({
  context: object({
    caseId: id(/^case_[0-9a-f]{24}$/), subjectId: id(/^subject_[0-9a-f]{24}$/), purpose: gated,
    requestedFields: array(id(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/), 0, 40),
  }),
  sources: array(object({
    id: id(/^source_[0-9a-f]{24}$/), version: gated, page: int(1, 1_000_000, { nullable: true }), text: gated,
    status: enumOf(['known', 'unknown', 'conflict']),
  }), 1, 30),
  upstream: Object.freeze({ type: 'structured' }),
});

export const MODEL_INPUT_FIELDS = Object.freeze({
  profile_extraction: coverageInput,
  group_cover_extraction: coverageInput,
  personal_cover_extraction: coverageInput,
  evidence_synthesis: coverageInput,
  question_drafting: coverageInput,
  [STRUCTURING_EXTRACT_TASK]: object({
    payload: object({
      registry: array(object({ key: registryKey, label: staticLabel, valueType: enumOf(POLICY_PARAMETER_VALUE_TYPES) }, REGISTRY_ENTRIES), 0, 500),
      chunks: array(object({
        chunk_id: id(/^p[1-9]\d{0,4}-b\d{1,5}(?:-part\d{1,3})?$/), page: int(1, MAX_PAGE),
        block_indexes: array(int(0, 100_000), 1, MAX_CHUNK_BLOCK_INDEXES), kind: enumOf(STRUCTURING_CHUNK_KINDS), title: gatedOrNull, text: gated,
      }), 1, 500),
    }),
  }),
  [STRUCTURING_RECONCILE_TASK]: object({
    payload: object({
      groups: array(object({
        // Opaque per-request group aliases (g1, g2, ...): the stored group id embeds a model-written key and member words.
        // `target` is the registry key or the model-proposed key, gated like any other model-written text.
        group_id: id(/^g[1-9]\d{0,3}$/), target: gated, subject: gated,
        readings: array(object({ value: gated, quote: gated, page: int(1, MAX_PAGE) }), 1, 50),
      }), 1, 500),
    }),
  }),
  [EVIDENCE_INVESTIGATE_TASK]: object({
    payload: object({
      questions: question,
      checklist: array(enumOf(INVESTIGATION_CHECKLIST_KINDS), 1, 20),
      clauses: array(wireClause, 1, 500),
    }),
  }),
  [EVIDENCE_SWEEP_TASK]: object({
    payload: object({
      questions: question,
      findings: array(object({
        finding_id: id(/^f[1-9]\d{0,2}$/), subject: gated, quote: gated, clause_ids: array(clauseAlias, 1, 50),
      }), 1, 60),
      clauses: array(wireClause, 1, 500),
    }),
  }),
});
