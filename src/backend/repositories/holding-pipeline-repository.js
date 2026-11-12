import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { FACT_TYPES } from '../../features/policy-facts/fact-types.js';
import { canonicalJson, valuesIn } from '../../features/policy-facts/normalisers.js';
import { equalityKey } from '../../features/policy-facts/fact-equality.js';
import { assertMachineRowAuthority, COLLATE_VERSION } from '../../features/insurance-rules/collate.js';
import { getPolicyFactKey, POLICY_FACT_REGISTRY_VERSION } from '../../contracts/policy-facts.js';

// Data access of the holdings pipeline (O-A4): reads holdings, own-PDF candidates and current memory rows, writes the collation
// (machine-tier household_memory_facts rows and memory_conflicts), and writes a user's conflict resolution. Tables: migrations
// 048-050 (owned by the facts-schema work). This file adds only the pipeline's own queries; it does not replace the holding, memory
// fact or conflict repositories of that work.
//
//   * Every query is scoped by household_id. Writes run in one transaction under the household advisory lock, with the document and
//     its document_processing consent re-checked inside it (as policy_facts does), and a counts-only audit event.
//   * Values are sealed (enc2, AAD household_memory_facts.value_enc.<row id>) as canonical JSON { value, alternatives }. The IDA
//     reference locator (cache key, version, quote) is sealed in reference_ref_enc. Opened values leave this file only towards the
//     owning household's own response (the route proves ownership first) and towards the deterministic collate; never into a prompt,
//     a log, an audit payload or a job payload.
//   * Append-only: a changed reading stamps superseded_at on the current row and inserts a new one (supersedes_id). An unchanged
//     reading writes nothing, so a re-run is a no-op.
//   * Erasure: every row written here cascades with its holding, document, policy fact and page (FKs of 049/050) and is deleted by the
//     household, consent and member erasure paths of the facts-schema work.

const MEMORY = 'household_memory_facts';
const MAX_ROWS = 2000;
const MAX_CONFLICTS = 500;

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
const notReady = () => coded('HOLDING_NOT_READY', 'The holding document is not available.', 409);

function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw coded('HOLDING_INPUT_INVALID', `${name} is invalid.`, 400);
  return value;
}

const holdingShape = row => (row ? Object.freeze({
  id: row.id, householdId: row.household_id, policyId: row.policy_id, documentId: row.document_id, policyProfileId: row.policy_profile_id,
  kind: row.kind, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
}) : null);

export class HoldingPipelineRepository {
  constructor(database, { clock = () => new Date(), audit = null, ...options } = {}) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.crypto = resolveColumnCrypto(options);
  }

  async getHolding({ householdId, holdingId }) {
    requireId(householdId, 'householdId'); requireId(holdingId, 'holdingId');
    return holdingShape(await this.database.one('SELECT * FROM policy_holdings WHERE id = ? AND household_id = ?', [holdingId, householdId]));
  }

  /** The household of a holding id, or null. Used only to check the caller's role in that household before any read. */
  async householdOfHolding(holdingId) {
    requireId(holdingId, 'holdingId');
    return (await this.database.one('SELECT household_id FROM policy_holdings WHERE id = ?', [holdingId]))?.household_id ?? null;
  }

  /** The active document behind a holding with its processing grant, or null. */
  async holdingDocument({ householdId, documentId }) {
    const row = await this.database.one(`SELECT id, source_version, consent_grant_id FROM document_uploads
      WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
    return row ? Object.freeze({ id: row.id, sourceVersion: row.source_version, consentGrantId: row.consent_grant_id }) : null;
  }

  /** The documents linked to a holding (migration 065): [{ documentId, kind, sourceVersion, consentGrantId }], active documents only. */
  async linkedDocuments({ householdId, holdingId }) {
    requireId(householdId, 'householdId'); requireId(holdingId, 'holdingId');
    const rows = await this.database.many(`SELECT link.document_id, link.kind, document.source_version, document.consent_grant_id FROM holding_documents link
      JOIN document_uploads document ON document.id = link.document_id AND document.household_id = link.household_id AND document.lifecycle_state = 'active'
      WHERE link.household_id = ? AND link.holding_id = ? ORDER BY link.created_at, link.id LIMIT 20`, [householdId, holdingId]);
    return rows.map(row => Object.freeze({ documentId: row.document_id, kind: row.kind, sourceVersion: row.source_version, consentGrantId: row.consent_grant_id }));
  }

  /**
   * Links another active document of the household (its T&C wording, an endorsement) to a holding. Idempotent: a repeat resolves
   * { linked: false }. Household ownership of both ends is re-checked inside the transaction; a foreign or missing id answers the
   * same 404. Resolves { linked }.
   */
  async linkDocument({ householdId, holdingId, documentId, kind }) {
    requireId(householdId, 'householdId'); requireId(holdingId, 'holdingId'); requireId(documentId, 'documentId');
    if (!['wording', 'endorsement', 'other'].includes(kind)) throw coded('HOLDING_INPUT_INVALID', 'kind is invalid.', 400);
    const at = this.clock().toISOString();
    return this.database.transaction(async () => {
      const db = this.database;
      const holding = await db.one('SELECT id, document_id FROM policy_holdings WHERE id = ? AND household_id = ?', [holdingId, householdId]);
      if (!holding) throw coded('HOLDING_NOT_FOUND', 'The holding was not found.', 404);
      const document = await db.one(`SELECT id, consent_grant_id FROM document_uploads WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
      if (!document) throw coded('DOCUMENT_NOT_FOUND', 'The document was not found.', 404);
      if (document.id === holding.document_id) throw coded('HOLDING_INPUT_INVALID', 'The holding already has this document.', 400);
      await this.#absorbStandaloneHolding({ householdId, holdingId, documentId });
      const inserted = await db.run(`INSERT INTO holding_documents (id, household_id, holding_id, document_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (holding_id, document_id) DO NOTHING`, [`hdoc-${randomUUID()}`, householdId, holdingId, documentId, kind, at]);
      return Object.freeze({ linked: inserted.changes === 1 });
    }, { locks: [householdLock(householdId)] });
  }

  // One policy, one holding. The linked document may already have a standalone holding of its own (created at OCR, or by a late holding.create
  // job). Inside the link transaction (household lock held): if the owner never acted on it, delete it (foreign keys cascade its memory facts,
  // conflicts, chunks and chat threads; its queued jobs go too) with a counts-only audit event. If the owner acted on it, refuse with a coded
  // conflict and change nothing. A document linked to another holding is not a holding of its own, so it is never touched.
  async #absorbStandaloneHolding({ householdId, holdingId, documentId }) {
    const db = this.database;
    const own = await db.one('SELECT id, status FROM policy_holdings WHERE household_id = ? AND document_id = ? FOR UPDATE', [householdId, documentId]);
    if (!own || own.id === holdingId) return;
    const acted = await db.one(`SELECT (
        ? NOT IN ('uploaded', 'insurer_pending')
        OR EXISTS (SELECT 1 FROM policy_profiles profile WHERE profile.household_id = ? AND profile.document_id = ?
          AND (profile.uin_state = 'reported' OR profile.insurer_state = 'reported' OR profile.policy_name_state = 'reported'))
        OR EXISTS (SELECT 1 FROM household_memory_facts fact WHERE fact.household_id = ? AND fact.holding_id = ? AND fact.source_tier = 'user_declaration')
        OR EXISTS (SELECT 1 FROM memory_conflicts conflict WHERE conflict.household_id = ? AND conflict.holding_id = ? AND conflict.resolution <> 'pending')
        OR EXISTS (SELECT 1 FROM holding_documents link WHERE link.household_id = ? AND link.holding_id = ?)
        OR EXISTS (SELECT 1 FROM premium_payments payment WHERE payment.household_id = ? AND payment.holding_id = ?)
        OR EXISTS (SELECT 1 FROM premium_dues due WHERE due.household_id = ? AND due.holding_id = ?)
        OR EXISTS (SELECT 1 FROM chat_threads thread WHERE thread.household_id = ? AND thread.holding_id = ?)
        OR EXISTS (SELECT 1 FROM member_declarations declaration WHERE declaration.household_id = ? AND declaration.holding_id = ?)
      ) AS acted`, [own.status, householdId, documentId, householdId, own.id, householdId, own.id, householdId, own.id, householdId, own.id,
      householdId, own.id, householdId, own.id, householdId, own.id]);
    if (acted.acted) throw coded('HOLDING_DOCUMENT_HAS_HOLDING', 'That document already has its own holding that you have worked on.', 409);
    await db.run(`DELETE FROM job_queue WHERE household_id = ? AND document_id = ? AND status = 'queued' AND kind LIKE 'holding.%'`, [householdId, documentId]);
    await db.run('DELETE FROM policy_holdings WHERE id = ? AND household_id = ?', [own.id, householdId]);
    await this.audit?.append({
      householdId, actorType: 'system', actorId: 'holding-pipeline-repository', action: 'holding.absorbed',
      resourceType: 'policy_holding', resourceId: own.id, payload: {},
    });
  }

  /**
   * Removes a link, the memory chunks that came from the unlinked document for this holding, and the own-PDF memory rows that cite it
   * (retired, so no fact read only from that document stays current; the caller re-collates to rebuild what the other documents give).
   * A user declaration or a resolved conflict is never touched. Resolves { unlinked }.
   */
  async unlinkDocument({ householdId, holdingId, documentId }) {
    requireId(householdId, 'householdId'); requireId(holdingId, 'holdingId'); requireId(documentId, 'documentId');
    return this.database.transaction(async () => {
      const db = this.database;
      const removed = await db.run('DELETE FROM holding_documents WHERE household_id = ? AND holding_id = ? AND document_id = ?', [householdId, holdingId, documentId]);
      if (removed.changes === 1) {
        await db.run('DELETE FROM memory_chunks WHERE household_id = ? AND holding_id = ? AND source_document_id = ?', [householdId, holdingId, documentId]);
        await db.run(`UPDATE ${MEMORY} SET superseded_at = ? WHERE household_id = ? AND holding_id = ? AND source_document_id = ? AND source_tier = 'own_pdf' AND superseded_at IS NULL`,
          [this.clock().toISOString(), householdId, holdingId, documentId]);
      }
      return Object.freeze({ unlinked: removed.changes === 1 });
    }, { locks: [householdLock(householdId)] });
  }

  /** Which of these documents may be read now (active, current version, clean, current processing grant): Set of document ids. Household scoped. */
  async readableDocuments({ householdId, documentIds }) {
    requireId(householdId, 'householdId');
    if (documentIds.length === 0) return new Set();
    const at = this.clock().toISOString();
    const rows = await this.database.many(`SELECT document.id FROM document_uploads document
      JOIN consent_grants consent ON consent.id = document.consent_grant_id
      WHERE document.id = ANY(CAST(? AS text[])) AND document.household_id = ? AND document.lifecycle_state = 'active'
        AND document.malware_status IN ('clean', 'not_scanned_fixture')
        AND consent.purpose = 'document_processing' AND consent.revoked_at IS NULL
        AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(CAST(? AS text)))`, [documentIds, householdId, at]);
    return new Set(rows.map(row => row.id));
  }

  /** The holdings of the household that a document is linked to (ids only). */
  async holdingsLinkingDocument({ householdId, documentId }) {
    requireId(householdId, 'householdId'); requireId(documentId, 'documentId');
    return (await this.database.many('SELECT holding_id FROM holding_documents WHERE household_id = ? AND document_id = ? ORDER BY created_at, id LIMIT 20', [householdId, documentId])).map(row => row.holding_id);
  }

  /**
   * Where each own-PDF fact was read: for the given current memory rows, { [row id]: { documentId, page, quote } } (quote and page from the
   * fact's primary evidence). Opened for the owning household's own answer only; never sent to a model.
   */
  async ownFactSources({ householdId, rows }) {
    const own = rows.filter(row => row.tier === 'own_pdf' && row.policyFactId);
    if (own.length === 0) return new Map();
    const quotes = await this.ownQuotes({ householdId, policyFactIds: own.map(row => row.policyFactId) });
    const pages = await this.database.many(`SELECT fact.id AS memory_id, fact.source_document_id, page.page_number FROM household_memory_facts fact
      LEFT JOIN source_pages page ON page.id = fact.source_page_id WHERE fact.household_id = ? AND fact.id = ANY(CAST(? AS text[]))`, [householdId, own.map(row => row.id)]);
    const byMemory = new Map(pages.map(row => [row.memory_id, row]));
    const out = new Map();
    for (const row of own) {
      const place = byMemory.get(row.id);
      out.set(row.id, Object.freeze({ documentId: place?.source_document_id ?? null, page: place?.page_number == null ? null : Number(place.page_number), quote: quotes.get(row.policyFactId) ?? null }));
    }
    return out;
  }

  /** Conditional status write: only from `from`. Returns true when it changed. */
  async setStatus({ householdId, holdingId, from, to }) {
    if (from === to) return false;
    const at = this.clock().toISOString();
    return (await this.database.run('UPDATE policy_holdings SET status = ?, updated_at = ? WHERE id = ? AND household_id = ? AND status = ?',
      [to, at, holdingId, householdId, from])).changes === 1;
  }

  async openConflictCount({ householdId, holdingId }) {
    return Number((await this.database.one(`SELECT count(*) AS n FROM memory_conflicts WHERE household_id = ? AND holding_id = ? AND resolution = 'pending'`,
      [householdId, holdingId])).n);
  }

  // The value object of a policy_facts row (sealed canonical JSON, or the plaintext coarse column for percent, enum and bool).
  #policyFactValue(row) {
    switch (row.value_type) {
      case 'percent': return row.value_percent_bp === null ? null : { bp: row.value_percent_bp };
      case 'enum': return row.value_enum === null ? null : { value: row.value_enum };
      case 'bool': return row.value_bool === null ? null : { value: row.value_bool };
      default: return row.value_enc ? JSON.parse(this.crypto.open('policy_facts', 'value_enc', row.id, row.value_enc)) : null;
    }
  }

  /**
   * Own-PDF candidates of a document version: current, unscoped policy_facts with a registry key, each with the source page of its
   * first evidence. A conflicting fact's alternatives are the values its quotes parse to (deterministic normaliser).
   */
  async ownCandidates({ householdId, documentId, sourceVersion }) {
    const facts = await this.database.many(`SELECT * FROM policy_facts
      WHERE household_id = ? AND document_id = ? AND source_version = ? AND superseded_by_fact_id IS NULL AND scope_key = '' AND state <> 'unknown'
      ORDER BY fact_type, ordinal, id LIMIT ?`, [householdId, documentId, sourceVersion, MAX_ROWS]);
    if (facts.length === 0) return [];
    const evidence = await this.database.many(`SELECT evidence.*, page.id AS page_id FROM fact_evidence evidence
      LEFT JOIN source_pages page ON page.document_upload_id = evidence.document_id AND page.page_number = evidence.page AND page.source_version = evidence.source_version
      WHERE evidence.household_id = ? AND evidence.fact_id = ANY(CAST(? AS text[])) ORDER BY evidence.created_at, evidence.id`,
    [householdId, facts.map(row => row.id)]);
    const byFact = new Map();
    for (const item of evidence) {
      if (!byFact.has(item.fact_id)) byFact.set(item.fact_id, []);
      byFact.get(item.fact_id).push(item);
    }
    const out = [];
    for (const row of facts) {
      if (!getPolicyFactKey(row.fact_type)) continue;
      const items = byFact.get(row.id) ?? [];
      const first = items.find(item => item.role === 'primary') ?? items[0];
      if (!first?.page_id) continue;
      let alternatives = [];
      if (row.state === 'conflicting') {
        const kind = FACT_TYPES[row.fact_type]?.parse;
        const seen = new Map();
        for (const item of items.slice(0, 4)) {
          for (const value of kind ? valuesIn(kind, this.crypto.open('fact_evidence', 'quote_enc', item.id, item.quote_enc)) : []) {
            const key = equalityKey(row.value_type, value);
            if (key && !seen.has(key)) seen.set(key, value);
          }
        }
        alternatives = [...seen.values()].slice(0, 4);
      }
      out.push(Object.freeze({
        factKey: row.fact_type, factId: row.id, documentId, origin: row.origin, state: row.state,
        value: row.state === 'extracted_unverified' ? this.#policyFactValue(row) : null, alternatives,
        pageId: first.page_id, blockIndex: first.block_index ?? null,
      }));
    }
    return out;
  }

  /**
   * The insurer and product name the owner confirmed for each holding: Map holding id -> { insurerName, productName } (each null unless that
   * field is in state 'reported'; never an extracted candidate, never the UIN). Opened for the owning household's own response only.
   */
  async confirmedNames({ householdId, holdings }) {
    requireId(householdId, 'householdId');
    const ids = holdings.map(item => item.policyProfileId).filter(Boolean);
    const out = new Map();
    if (ids.length === 0) return out;
    const rows = await this.database.many(`SELECT id, insurer_state, insurer_name_enc, policy_name_state, policy_name_enc FROM policy_profiles
      WHERE household_id = ? AND id = ANY(CAST(? AS text[]))`, [householdId, ids]);
    const byProfile = new Map(rows.map(row => [row.id, row]));
    for (const holding of holdings) {
      const row = byProfile.get(holding.policyProfileId);
      if (!row) continue;
      out.set(holding.id, Object.freeze({
        insurerName: row.insurer_state === 'reported' && row.insurer_name_enc ? this.crypto.open('policy_profiles', 'insurer_name_enc', row.id, row.insurer_name_enc) : null,
        productName: row.policy_name_state === 'reported' && row.policy_name_enc ? this.crypto.open('policy_profiles', 'policy_name_enc', row.id, row.policy_name_enc) : null,
      }));
    }
    return out;
  }

  /** The kind of the document each source page belongs to: Map page id -> document_kind (household scoped). */
  async pageDocumentKinds({ householdId, pageIds }) {
    const ids = [...new Set(pageIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.database.many(`SELECT page.id, document.document_kind FROM source_pages page
      JOIN document_uploads document ON document.id = page.document_upload_id
      WHERE document.household_id = ? AND page.id = ANY(CAST(? AS text[]))`, [householdId, ids]);
    return new Map(rows.map(row => [row.id, row.document_kind]));
  }

  /** Current memory rows of a holding, opened (server side only). */
  async currentMemory({ householdId, holdingId, factKeys = null }) {
    const rows = await this.database.many(`SELECT * FROM ${MEMORY} WHERE household_id = ? AND holding_id = ? AND superseded_at IS NULL
      AND (CAST(? AS text[]) IS NULL OR fact_key = ANY(CAST(? AS text[])))
      ORDER BY fact_key, source_tier, id LIMIT ?`, [householdId, holdingId, factKeys, factKeys, MAX_ROWS]);
    return rows.map(row => {
      const sealed = row.value_enc ? JSON.parse(this.crypto.open(MEMORY, 'value_enc', row.id, row.value_enc)) : { value: null, alternatives: [] };
      return Object.freeze({
        id: row.id, factKey: row.fact_key, scopeKey: row.scope_key, factClass: row.fact_class, tier: row.source_tier, status: row.status,
        value: sealed.value ?? null, alternatives: sealed.alternatives ?? [], sealedPayload: row.value_enc ? canonicalJson(sealed) : null,
        reference: row.reference_ref_enc ? JSON.parse(this.crypto.open(MEMORY, 'reference_ref_enc', row.id, row.reference_ref_enc)) : null,
        policyFactId: row.policy_fact_id, consentGrantId: row.consent_grant_id, captureMethod: row.capture_method,
        resolvesFactIds: row.resolves_fact_ids ?? [], sourcePageId: row.source_page_id, blockIndex: row.block_index, createdAt: row.created_at,
      });
    });
  }

  /**
   * The printed quote behind each own-PDF policy fact (its primary evidence, else its first), opened for the owning household's own
   * response only (complete.md: both quotes are shown for a product term). Never logged, never sent to a model.
   */
  async ownQuotes({ householdId, policyFactIds }) {
    const ids = [...new Set(policyFactIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.database.many(`SELECT id, fact_id, quote_enc, role FROM fact_evidence
      WHERE household_id = ? AND fact_id = ANY(CAST(? AS text[])) ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, created_at, id`, [householdId, ids]);
    const quotes = new Map();
    for (const row of rows) if (!quotes.has(row.fact_id)) quotes.set(row.fact_id, this.crypto.open('fact_evidence', 'quote_enc', row.id, row.quote_enc));
    return quotes;
  }

  async listConflicts({ householdId, holdingId, pendingOnly = false }) {
    return (await this.database.many(`SELECT * FROM memory_conflicts WHERE household_id = ? AND holding_id = ?${pendingOnly ? " AND resolution = 'pending'" : ''}
      ORDER BY created_at, id LIMIT ?`, [householdId, holdingId, MAX_CONFLICTS])).map(row => Object.freeze({
      id: row.id, factKey: row.fact_key, candidateFactIds: Object.freeze([...row.candidate_fact_ids]), reason: row.reason, resolution: row.resolution,
      resolvingFactId: row.resolving_fact_id, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at, createdAt: row.created_at,
    }));
  }

  // Inside a transaction: the document is active, at its source version, clean, and its document_processing grant is current.
  async #requireReadableDocument({ householdId, documentId, sourceVersion, at }) {
    const row = await this.database.one(`SELECT document.id FROM document_uploads document
      JOIN consent_grants consent ON consent.id = document.consent_grant_id
      WHERE document.id = ? AND document.household_id = ? AND document.lifecycle_state = 'active' AND document.source_version = ?
        AND document.malware_status IN ('clean', 'not_scanned_fixture')
        AND consent.purpose = 'document_processing' AND consent.revoked_at IS NULL
        AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(CAST(? AS text)))`, [documentId, householdId, sourceVersion, at]);
    if (!row) throw notReady();
  }

  async #insertMemory(row) {
    const columns = Object.keys(row);
    await this.database.run(`INSERT INTO ${MEMORY} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => row[column]));
  }

  async #supersede(householdId, rowId, at) {
    await this.database.run(`UPDATE ${MEMORY} SET superseded_at = ? WHERE id = ? AND household_id = ? AND superseded_at IS NULL`, [at, rowId, householdId]);
  }

  /**
   * Writes one collation of a holding. `slots` are collateSlot() results; `ownByFactId` maps policy fact id -> own candidate (page);
   * `consentGrantId` is the document's processing grant. Unchanged readings are kept; changed ones supersede. Returns counts.
   */
  async writeCollation({ holding, sourceVersion, consentGrantId, slots, ownByFactId, linkedDocuments = [] }) {
    const householdId = holding.householdId;
    return this.database.transaction(async () => {
      const at = this.clock().toISOString();
      await this.#requireReadableDocument({ householdId, documentId: holding.documentId, sourceVersion, at });
      // Linked documents that contributed a candidate: each is re-checked inside the transaction (consent, version, state). A document that
      // stopped being readable since the read fails this attempt (retryable); the next attempt reads without it.
      const linkedBy = new Map(linkedDocuments.map(item => [item.documentId, item]));
      for (const item of linkedBy.values()) {
        try { await this.#requireReadableDocument({ householdId, documentId: item.documentId, sourceVersion: item.sourceVersion, at }); }
        catch { throw coded('HOLDING_COLLATE_RETRY', 'A linked document changed while collating.', 409); }
      }
      const linkedLive = await this.database.many('SELECT document_id FROM holding_documents WHERE household_id = ? AND holding_id = ?', [householdId, holding.id]);
      const stillLinked = new Set(linkedLive.map(row => row.document_id));
      for (const item of linkedBy.values()) if (!stillLinked.has(item.documentId)) throw coded('HOLDING_COLLATE_RETRY', 'A linked document was unlinked while collating.', 409);
      const live = await this.database.one('SELECT status FROM policy_holdings WHERE id = ? AND household_id = ?', [holding.id, householdId]);
      if (!live) throw notReady();
      const current = await this.currentMemory({ householdId, holdingId: holding.id });
      const currentBy = new Map(current.filter(row => row.scopeKey === '').map(row => [`${row.factKey}|${row.tier}`, row]));
      const conflicts = await this.listConflicts({ householdId, holdingId: holding.id });
      const counts = { written: 0, kept: 0, retired: 0, conflictsOpened: 0, conflictsClosed: 0 };
      const slotKeys = new Set();

      for (const slot of slots) {
        slotKeys.add(slot.factKey);
        const ids = {};
        for (const intent of [slot.own, slot.ida]) {
          const tier = intent?.tier;
          if (!intent) continue;
          assertMachineRowAuthority(intent);
          const payload = canonicalJson({ alternatives: intent.alternatives ?? [], value: intent.value ?? null });
          const reference = intent.tier === 'ida_wording'
            ? { cacheKey: intent.reference.cacheKey ?? null, quote: intent.reference.quote ?? null, refId: intent.reference.refId, version: intent.reference.version ?? null }
            : null;
          const existing = currentBy.get(`${slot.factKey}|${tier}`);
          const same = existing && existing.status === intent.status && existing.sealedPayload === payload
            && (existing.policyFactId ?? null) === (intent.policyFactId ?? null)
            && (tier !== 'ida_wording' || canonicalJson(existing.reference ?? {}) === canonicalJson(reference));
          if (same) { ids[tier] = existing.id; counts.kept += 1; continue; }
          if (existing) { await this.#supersede(householdId, existing.id, at); counts.retired += 1; }
          const id = `hmf-${randomUUID()}`;
          const page = tier === 'own_pdf' ? ownByFactId.get(intent.policyFactId) : null;
          if (tier === 'own_pdf' && !page) throw coded('HOLDING_COLLATE_INPUT_INVALID', 'An own-PDF row needs its page.', 500);
          await this.#insertMemory({
            id, household_id: householdId, holding_id: holding.id, policy_id: holding.policyId, subject_member_id: null, member_scope: 'policy',
            fact_key: slot.factKey, scope_key: '', key_schema: POLICY_FACT_REGISTRY_VERSION, fact_class: slot.factClass, source_tier: tier, status: intent.status,
            value_enc: this.crypto.seal(MEMORY, 'value_enc', id, payload), consent_grant_id: (page && linkedBy.get(page.documentId)?.consentGrantId) || consentGrantId,
            source_document_id: (page && linkedBy.has(page.documentId)) ? page.documentId : holding.documentId,
            source_page_id: page?.pageId ?? null, block_index: page?.blockIndex ?? null, policy_fact_id: intent.policyFactId ?? null,
            reference_ref_enc: reference ? this.crypto.seal(MEMORY, 'reference_ref_enc', id, canonicalJson(reference)) : null,
            derivation_version: COLLATE_VERSION, supersedes_id: existing?.id ?? null, created_at: at,
          });
          ids[tier] = id;
          counts.written += 1;
        }
        // Machine tiers that no longer have a value are retired (the resolver then answers unknown for them).
        for (const tier of ['own_pdf', 'ida_wording']) {
          const existing = currentBy.get(`${slot.factKey}|${tier}`);
          if (existing && !ids[tier]) { await this.#supersede(householdId, existing.id, at); counts.retired += 1; }
        }
        await this.#reconcileConflict({ householdId, holding, slot, ids, declaration: currentBy.get(`${slot.factKey}|user_declaration`), conflicts, counts, at });
      }
      // Keys with current machine rows that this collation no longer produces at all are retired, and their open conflicts closed.
      for (const row of current) {
        if (row.tier === 'user_declaration' || row.scopeKey !== '' || slotKeys.has(row.factKey)) continue;
        await this.#supersede(householdId, row.id, at); counts.retired += 1;
      }
      for (const conflict of conflicts) {
        if (conflict.resolution === 'pending' && !slotKeys.has(conflict.factKey)) await this.#closeByRule(householdId, conflict.id, at, counts);
      }
      if (counts.written + counts.retired + counts.conflictsOpened + counts.conflictsClosed > 0) {
        await this.audit?.append({ householdId, actorType: 'system', actorId: 'holding-collate', action: 'memory.built', resourceType: 'policy_holding', resourceId: holding.id,
          payload: { written: counts.written, retired: counts.retired, conflictsOpened: counts.conflictsOpened, conflictsClosed: counts.conflictsClosed } });
      }
      const open = await this.openConflictCount({ householdId, holdingId: holding.id });
      return Object.freeze({ ...counts, openConflicts: open });
    }, { locks: [householdLock(householdId)] });
  }

  async #closeByRule(householdId, conflictId, at, counts) {
    const { changes } = await this.database.run(`UPDATE memory_conflicts SET resolution = 'dismissed', resolved_by = 'rule', resolved_at = ?
      WHERE id = ? AND household_id = ? AND resolution = 'pending'`, [at, conflictId, householdId]);
    counts.conflictsClosed += changes;
  }

  // One slot's conflict: the same candidates already recorded (open or resolved) -> nothing; otherwise the stale open one is closed by
  // rule and a new pending one is opened. No conflict wanted -> an open one is closed by rule (the tiers now agree).
  async #reconcileConflict({ householdId, holding, slot, ids, declaration, conflicts, counts, at }) {
    const mine = conflicts.filter(conflict => conflict.factKey === slot.factKey);
    const pending = mine.find(conflict => conflict.resolution === 'pending');
    if (!slot.conflict) {
      if (pending) await this.#closeByRule(householdId, pending.id, at, counts);
      return;
    }
    const candidates = slot.conflict.reason === 'own_vs_declaration'
      ? [ids.own_pdf, declaration?.id].filter(Boolean)
      : [ids.own_pdf, ids.ida_wording].filter(Boolean);
    if (candidates.length < 2) return;
    const signature = JSON.stringify([...candidates].sort());
    if (mine.some(conflict => JSON.stringify([...conflict.candidateFactIds].sort()) === signature)) return;
    if (pending) await this.#closeByRule(householdId, pending.id, at, counts);
    await this.database.run(`INSERT INTO memory_conflicts (id, household_id, holding_id, fact_key, candidate_fact_ids, reason, created_at)
      VALUES (?, ?, ?, ?, CAST(? AS text[]), ?, ?)`, [`mcf-${randomUUID()}`, householdId, holding.id, slot.factKey, candidates, slot.conflict.reason, at]);
    counts.conflictsOpened += 1;
  }

  /**
   * A household adult's choice on a conflict (ADR 0032: the user may resolve any conflict; FOR LEGAL REVIEW). Writes a NEW
   * user_declaration row (capture_method conflict_resolution, status user_confirmed) holding the chosen machine value; the machine
   * rows stay. Repeating the same choice returns the same result; a different choice on a closed conflict is refused.
   */
  async resolveConflict({ holding, conflictId, chosenFactId, alternativeIndex = null, adultId }) {
    const householdId = holding.householdId;
    return this.database.transaction(async () => {
      const at = this.clock().toISOString();
      const conflict = await this.database.one('SELECT * FROM memory_conflicts WHERE id = ? AND household_id = ? AND holding_id = ? FOR UPDATE',
        [conflictId, householdId, holding.id]);
      if (!conflict) throw coded('MEMORY_CONFLICT_NOT_FOUND', 'The conflict was not found.', 404);
      if (!conflict.candidate_fact_ids.includes(chosenFactId)) throw coded('MEMORY_CONFLICT_CHOICE_INVALID', 'The choice is not one of the conflict candidates.', 400);
      const current = await this.currentMemory({ householdId, holdingId: holding.id });
      const chosen = current.find(row => row.id === chosenFactId);
      if (conflict.resolution !== 'pending') {
        const resolving = conflict.resolving_fact_id ? current.find(row => row.id === conflict.resolving_fact_id) ?? null : null;
        const repeat = resolving && resolving.resolvesFactIds.includes(chosenFactId) && chosen
          && equalityKey(getPolicyFactKey(conflict.fact_key).type, resolving.value) === equalityKey(getPolicyFactKey(conflict.fact_key).type, this.#chosenValue(chosen, alternativeIndex));
        if (repeat) return Object.freeze({ conflictId, resolvingFactId: resolving.id, replay: true });
        throw coded('MEMORY_CONFLICT_ALREADY_RESOLVED', 'The conflict is already closed.', 409);
      }
      if (!chosen || chosen.tier === 'user_declaration' && chosen.captureMethod === 'conflict_resolution') {
        throw coded('MEMORY_CONFLICT_STALE', 'The conflict no longer matches the current facts.', 409);
      }
      const value = this.#chosenValue(chosen, alternativeIndex);
      const entry = getPolicyFactKey(conflict.fact_key);
      if (!entry || equalityKey(entry.type, value) === null) throw coded('MEMORY_CONFLICT_CHOICE_INVALID', 'The chosen value cannot be used.', 400);
      const previous = current.find(row => row.factKey === conflict.fact_key && row.scopeKey === '' && row.tier === 'user_declaration');
      if (previous) await this.#supersede(householdId, previous.id, at);
      const id = `hmf-${randomUUID()}`;
      await this.#insertMemory({
        id, household_id: householdId, holding_id: holding.id, policy_id: holding.policyId, subject_member_id: null, member_scope: 'policy',
        fact_key: conflict.fact_key, scope_key: '', key_schema: POLICY_FACT_REGISTRY_VERSION, fact_class: entry.factClass, source_tier: 'user_declaration',
        status: 'user_confirmed', value_enc: this.crypto.seal(MEMORY, 'value_enc', id, canonicalJson({ alternatives: [], value })),
        // The resolution rests on the same grant as the reading it chose: withdrawing that grant erases the resolution too.
        consent_grant_id: chosen.consentGrantId, source_document_id: holding.documentId, declared_by_adult_id: adultId,
        capture_method: 'conflict_resolution', resolves_fact_ids: [...conflict.candidate_fact_ids], derivation_version: COLLATE_VERSION,
        supersedes_id: previous?.id ?? null, created_at: at,
      });
      await this.database.run(`UPDATE memory_conflicts SET resolution = 'user_chose', resolving_fact_id = ?, resolved_by = 'user', resolved_by_adult_id = ?, resolved_at = ?
        WHERE id = ? AND household_id = ? AND resolution = 'pending'`, [id, adultId, at, conflictId, householdId]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'memory.conflict_resolved', resourceType: 'memory_conflict', resourceId: conflictId,
        payload: { candidates: conflict.candidate_fact_ids.length } });
      return Object.freeze({ conflictId, resolvingFactId: id, replay: false });
    }, { locks: [householdLock(householdId)] });
  }

  #chosenValue(row, alternativeIndex) {
    if (row.status !== 'conflicting') return row.value;
    const alternatives = row.alternatives ?? [];
    if (alternatives.length === 1 && (alternativeIndex === null || alternativeIndex === 0)) return alternatives[0];
    if (Number.isInteger(alternativeIndex) && alternativeIndex >= 0 && alternativeIndex < alternatives.length) return alternatives[alternativeIndex];
    throw coded('MEMORY_CONFLICT_CHOICE_INVALID', 'Choose one of the values of this reading.', 400);
  }
}
