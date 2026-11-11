// Seals rows written before column encryption (ADR 0013, ADR 0013 addendum D2), or re-seals them under the current key after a
// rotation. Idempotent: a row whose columns are already sealed under the current key is not selected, so a second run changes 0
// rows. Batched (one transaction per batch), keyset-paged by key, dry-run capable. Resolves counts only; it never returns, logs or
// throws a stored value. Run it as the table owner (the migrator role): several of the stores are append-only or immutable by
// trigger, and a batch disables exactly those triggers, updates, and enables them again inside the same transaction, so a crash
// or error restores them. Takes a short ShareRowExclusive lock per batch: run it in a quiet period.
//
// Entry fields: table; key (primary key column names, default ['id']); columns (sealed text columns); triggers (the exact
// triggers that block an UPDATE of this table); rowId (row -> the id used as additional authenticated data, default row[key[0]]);
// noUnseal (true for a table whose CHECK requires a sealed value, so --unseal skips it); select (extra columns the rowId function reads); since ('D2' for the columns added by migration 030); unwritten (true when no application code writes the column yet, so the at-rest test cannot expect a value there).

import { ERASED_NAME } from '../../contracts/data-lifecycle.js';
import { compositeRowId, documentIdOfUploadResponse, documentIdempotencyIndex, idempotencyRowId } from './sealed-records.js';

// An idempotency record of a document upload also carries a keyed index of its document id (ADR 0013 addendum D2). It is derived
// from the plain response in the same statement that seals it, and recomputed on --rotate (the index depends on the current key).
const DOCUMENT_INDEX = Object.freeze({
  column: 'document_index',
  applies: row => typeof row.scope === 'string' && row.scope.startsWith('document-upload:') && row.response_json != null,
  // SQL for the rows to look at: those without an index, and on --rotate every one (the index depends on the current key).
  candidate: rotate => `(scope LIKE 'document-upload:%' AND response_json IS NOT NULL${rotate ? '' : ' AND document_index IS NULL'})`,
  compute: (crypto, plainResponse) => {
    const documentId = documentIdOfUploadResponse(plainResponse);
    return documentId === null ? null : documentIdempotencyIndex(crypto, documentId);
  },
});

export const ENCRYPTED_COLUMNS = Object.freeze([
  { table: 'adult_users', columns: ['display_name', 'contact_email', 'contact_phone'], triggers: [] },
  { table: 'households', columns: ['display_name'], triggers: [] },
  { table: 'household_members', columns: ['display_name'], triggers: [] },
  { table: 'source_pages', columns: ['extracted_text', 'blocks_json'], triggers: ['source_pages_blocks_immutable'] },
  { table: 'ocr_jobs', columns: ['result_json'], triggers: [] },
  { table: 'policy_clauses', columns: ['title', 'text'], triggers: ['policy_clauses_immutable'] },
  { table: 'policy_answers', columns: ['answer_json'], triggers: ['policy_answers_immutable'] },
  { table: 'evidence_facts', columns: ['value_json'], triggers: ['evidence_facts_provenance_immutable'] },
  // D2: the remaining user-derived columns.
  { since: 'D2', table: 'household_members', columns: ['relationship_label', 'date_of_birth'], triggers: [] },
  { since: 'D2', table: 'source_pages', columns: ['provenance_json'], triggers: [] },
  { since: 'D2', table: 'ocr_jobs', columns: ['error_message'], triggers: [] },
  { since: 'D2', table: 'policy_answers', columns: ['question'], triggers: ['policy_answers_immutable'] },
  { since: 'D2', table: 'document_uploads', columns: ['original_filename'], triggers: [] },
  { since: 'D2', table: 'policies', columns: ['policy_number_masked', 'starts_on', 'ends_on'], triggers: [] },
  { since: 'D2', table: 'policies', columns: ['policy_version'], triggers: [], unwritten: true },
  { since: 'D2', table: 'policy_members', key: ['policy_id', 'household_member_id'], rowId: row => compositeRowId(row.policy_id, row.household_member_id), columns: ['member_reference_masked'], triggers: [], unwritten: true },
  { since: 'D2', table: 'coverage_parameter_observations', columns: ['value_json'], triggers: ['coverage_parameter_observations_no_update'] },
  {
    since: 'D2', table: 'coverage_parameter_resolutions', key: ['parameter_record_id'], columns: ['resolved_value_json'],
    triggers: ['coverage_parameter_resolutions_authority_update', 'coverage_parameter_resolutions_model_no_downgrade'],
  },
  { since: 'D2', table: 'proposed_parameters', columns: ['label', 'value_json'], triggers: ['proposed_parameters_no_update'] },
  { since: 'D2', table: 'workflow_runs', columns: ['input_json'], triggers: [] },
  { since: 'D2', table: 'workflow_tasks', columns: ['input_json', 'output_json', 'last_error_message'], triggers: [] },
  { since: 'D2', table: 'workflow_events', columns: ['event_payload_json'], triggers: [] },
  { since: 'D2', table: 'idempotency_keys', key: ['scope', 'idempotency_key'], rowId: row => idempotencyRowId(row.scope, row.idempotency_key), columns: ['response_json'], derive: DOCUMENT_INDEX, triggers: [] },
  { since: 'D2', table: 'integration_outbox', columns: ['payload_json', 'last_error'], triggers: [] },
  { since: 'D2', table: 'integration_webhook_events', columns: ['payload_json', 'processing_error'], triggers: [], unwritten: true },
  { since: 'D2', table: 'coverage_graph_snapshots', columns: ['graph_json'], triggers: [], unwritten: true },
  { since: 'D2', table: 'coverage_graph_nodes', columns: ['label', 'entity_ref'], triggers: [], unwritten: true },
  { since: 'D2', table: 'reviewer_findings', columns: ['message', 'resolution_note'], triggers: [], unwritten: true },
  { since: 'D2', table: 'consent_revocations', columns: ['reason'], triggers: [] },
  { since: 'D2', table: 'catalogue_reviews', columns: ['fact_json'], triggers: ['catalogue_reviews_immutable'] },
  // Policy facts slice 1 (migration 043): sealed from the first write, so only a rotation ever touches them. The update guard is the
  // one trigger a re-seal has to step past (it demands a version bump); noUnseal because the column CHECK refuses plaintext.
  { since: 'S1', table: 'policy_profiles', columns: ['insurer_name_enc', 'policy_name_enc'], triggers: ['policy_profiles_update_guard'], noUnseal: true },
  // Policy facts slice 2 (migration 044): sealed from the first write, so only a rotation touches them. The immutable triggers are the
  // ones a re-seal has to step past; noUnseal because the column CHECKs refuse plaintext.
  { since: 'S2', table: 'policy_facts', columns: ['value_enc', 'raw_text_enc'], triggers: ['policy_facts_immutable'], noUnseal: true },
  { since: 'S2', table: 'fact_evidence', columns: ['quote_enc'], triggers: ['fact_evidence_immutable'], noUnseal: true },
  // Capture slice 1 (migration 047): sealed from the first write, so only a rotation touches them. noUnseal because the column CHECKs refuse plaintext.
  { since: 'P1', table: 'household_members', columns: ['mobile_ciphertext', 'email_ciphertext'], triggers: [], noUnseal: true },
  { since: 'P1', table: 'person_records', columns: ['payload_ciphertext'], triggers: [], noUnseal: true },
  { since: 'D2', table: 'service_cases', columns: ['stated_estimate_ciphertext'], fixedSize: { stated_estimate_ciphertext: 64 }, triggers: [], legacy: { column: 'stated_estimate_minor', to: 'stated_estimate_ciphertext' } },
]);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const quote = identifier => {
  if (!IDENTIFIER.test(identifier)) throw new Error('Unsafe identifier.');
  return `"${identifier}"`;
};

/**
 * @param {object} options
 * @param {object} options.database  async database interface (createDatabase)
 * @param {object} options.crypto    column crypto (createColumnCrypto)
 * @param {boolean} [options.dryRun] count only, change nothing
 * @param {boolean} [options.rotate] also re-seal values sealed under another key id (and recompute the document index)
 * @param {boolean} [options.unseal] the reverse direction, for a code rollback: write sealed values back as plaintext
 * @param {boolean} [options.includeE1] with unseal: also unseal the columns sealed before migration 030 (default: D2 columns only)
 * @param {number} [options.batchSize]
 * @returns {Promise<{dryRun: boolean, tables: Array<{table: string, rows: number, columns: number, unreadable: number}>, rows: number, columns: number, unreadable: number, validated: number}>}
 *   `unreadable` counts rows with a value that could not be decrypted (wrong key, damaged): they are left as they are and reported.
 */
export async function encryptExistingRows({ database, crypto, dryRun = false, rotate = false, unseal = false, includeE1 = false, batchSize = 200 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new RangeError('batchSize must be 1 to 5000.');
  if (unseal && rotate) throw new RangeError('unseal and rotate cannot be combined.');
  if (includeE1 && !unseal) throw new RangeError('includeE1 only applies to unseal.');
  // Sealing reads the plaintext it is about to seal. With DATA_ENCRYPTION_LEGACY_PLAINTEXT=false the crypto refuses that, so every
  // legacy row would look like a damaged one: stop at once with the real reason instead.
  if (!unseal && crypto.allowLegacyPlaintext === false) {
    throw Object.assign(new Error('DATA_ENCRYPTION_LEGACY_PLAINTEXT=false refuses the plaintext this run has to read. Unset it for the backfill or rotation, then set it to false once the backfill has finished.'), { code: 'BACKFILL_LEGACY_PLAINTEXT_REFUSED' });
  }
  const report = [];
  for (const entry of ENCRYPTED_COLUMNS) {
    if (unseal && (entry.noUnseal || (!includeE1 && entry.since !== 'D2'))) continue;
    report.push(await sealTable({ database, crypto, entry, dryRun, rotate, unseal, batchSize }));
  }
  // Checks added NOT VALID by migration 030 are validated here, in their own statements (no long exclusive lock).
  const validated = dryRun || unseal ? 0 : await validateSealedChecks(database);
  return Object.freeze({
    dryRun,
    tables: Object.freeze(report.map(item => Object.freeze(item))),
    rows: report.reduce((sum, item) => sum + item.rows, 0),
    columns: report.reduce((sum, item) => sum + item.columns, 0),
    unreadable: report.reduce((sum, item) => sum + item.unreadable, 0),
    validated,
  });
}

async function validateSealedChecks(database) {
  const pending = await database.many(`SELECT con.conname AS name, rel.relname AS table_name FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public' AND con.contype = 'c' AND NOT con.convalidated AND con.conname ~ 'sealed' ORDER BY rel.relname, con.conname`);
  for (const { table_name: table, name } of pending) await database.run(`ALTER TABLE public.${quote(table)} VALIDATE CONSTRAINT ${quote(name)}`);
  return pending.length;
}

async function sealTable({ database, crypto, entry, dryRun, rotate, unseal, batchSize }) {
  const { table, columns, triggers } = entry;
  const key = entry.key ?? ['id'];
  const rowIdOf = entry.rowId ?? (row => String(row[key[0]]));
  const t = quote(table);
  const keyList = key.map(quote).join(', ');
  const derive = unseal ? null : entry.derive ?? null;
  const selectColumns = [...new Set([...key, ...columns, ...(derive ? [derive.column] : []), ...(entry.legacy ? [entry.legacy.column] : [])])];
  const selectList = selectColumns.map(quote).join(', ');
  // The erased-name marker is a plaintext tombstone that readers match literally: sealing it would hide it from that match.
  const needs = value => value !== null && value !== undefined && value !== ERASED_NAME
    && (unseal ? crypto.isSealed(value) : (!crypto.isSealed(value) || (rotate && crypto.needsRotation(value))));
  // Selects candidates in SQL so a finished table is a cheap scan.
  const candidate = columns.map(column => {
    const c = quote(column);
    if (unseal) return `(${c} ~ '^enc[12][.]')`;
    return rotate
      // enc1 (unpadded) and other-key values are re-sealed by --rotate; any enc1 or enc2 value counts as sealed otherwise.
      ? `(${c} IS NOT NULL AND ${c} <> '${ERASED_NAME}' AND (${c} !~ '^enc2[.]' OR split_part(${c}, '.', 2) <> ?))`
      : `(${c} IS NOT NULL AND ${c} <> '${ERASED_NAME}' AND ${c} !~ '^enc[12][.]')`;
  });
  // A legacy plain column (the stated estimate's bigint) moves into its sealed text column.
  if (entry.legacy && !unseal) candidate.push(`(${quote(entry.legacy.column)} IS NOT NULL)`);
  if (entry.legacy && unseal) candidate.push(`(${quote(entry.legacy.to)} ~ '^enc[12][.]')`);
  if (derive) candidate.push(derive.candidate(rotate));
  const candidateParams = rotate && !unseal ? columns.map(() => crypto.keyId) : [];
  const keyset = key.length === 1 ? `${keyList} > ?` : `(${keyList}) > (${key.map(() => '?').join(', ')})`;
  let rows = 0;
  let sealedColumns = 0;
  let unreadable = 0;
  let after = null;
  for (;;) {
    const done = await database.transaction(async () => {
      const batch = await database.many(
        `SELECT ${selectList} FROM public.${t} WHERE ${after ? `${keyset} AND ` : ''}(${candidate.join(' OR ')}) ORDER BY ${keyList} LIMIT ?${dryRun ? '' : ' FOR UPDATE'}`,
        [...(after ?? []), ...candidateParams, batchSize],
      );
      if (batch.length === 0) return { last: null };
      // Sealing and any derived column (the document index) are planned together and written in one UPDATE, in this transaction.
      const plans = batch.map(row => planRow({ crypto, entry, row, rowIdOf, needs, unseal, derive }));
      if (!dryRun) {
        for (const trigger of triggers) await database.run(`ALTER TABLE public.${t} DISABLE TRIGGER ${quote(trigger)}`);
        // No finally: after a failed statement the transaction is aborted and any further statement would replace the real
        // error with "current transaction is aborted". The rollback restores the trigger (DDL is transactional), and the
        // original error is what the caller sees.
        for (const [index, plan] of plans.entries()) {
          if (plan.assignments.length === 0) continue;
          const row = batch[index];
          await database.run(
            `UPDATE public.${t} SET ${plan.assignments.map(({ column }) => `${quote(column)} = ?`).join(', ')} WHERE ${key.map(column => `${quote(column)} = ?`).join(' AND ')}`,
            [...plan.assignments.map(({ value }) => value), ...key.map(column => row[column])],
          );
        }
        for (const trigger of triggers) await database.run(`ALTER TABLE public.${t} ENABLE TRIGGER ${quote(trigger)}`);
      }
      for (const plan of plans) {
        if (plan.assignments.length > 0) { rows += 1; sealedColumns += plan.assignments.filter(item => !item.cleared).length; }
        if (plan.unreadable) unreadable += 1;
      }
      return { last: key.map(column => batch.at(-1)[column]) };
    });
    if (done.last === null) break;
    after = done.last;
  }
  return { table, rows, columns: sealedColumns, unreadable };
}

function planRow({ crypto, entry, row, rowIdOf, needs, unseal, derive }) {
  const { table, columns } = entry;
  const rowId = rowIdOf(row);
  const assignments = [];
  let unreadable = false;
  // A value that cannot be decrypted is left untouched and counted; it never stops the rest of the table.
  const tryOpen = (column, stored) => {
    try { return { plain: crypto.open(table, column, rowId, stored) }; } catch { unreadable = true; return null; }
  };
  const plains = new Map();
  for (const column of columns) {
    if (entry.legacy && unseal) break; // the sealed legacy column is restored below, not written back as text
    if (row[column] === null || row[column] === undefined) continue;
    const opened = tryOpen(column, row[column]);
    if (opened === null) continue;
    plains.set(column, opened.plain);
    if (!needs(row[column])) continue;
    assignments.push({ column, value: unseal ? opened.plain : crypto.seal(table, column, rowId, opened.plain, entry.fixedSize?.[column] ? { fixedSize: entry.fixedSize[column] } : undefined) });
  }
  const legacy = entry.legacy;
  if (legacy && !unseal && row[legacy.column] !== null && row[legacy.column] !== undefined) {
    // The legacy bigint moves into the sealed column and is cleared in the same statement (never both).
    assignments.push({ column: legacy.to, value: crypto.seal(table, legacy.to, rowId, String(row[legacy.column]), { fixedSize: 64 }) });
    assignments.push({ column: legacy.column, value: null, cleared: true });
  }
  if (legacy && unseal && typeof row[legacy.to] === 'string' && crypto.isSealed(row[legacy.to])) {
    const opened = tryOpen(legacy.to, row[legacy.to]);
    if (opened !== null) {
      assignments.push({ column: legacy.column, value: Number(opened.plain) });
      assignments.push({ column: legacy.to, value: null, cleared: true });
    }
  }
  if (derive && derive.applies(row)) {
    const plainResponse = plains.get('response_json');
    if (plainResponse !== undefined) {
      const value = derive.compute(crypto, plainResponse);
      if (value !== null && value !== row[derive.column]) assignments.push({ column: derive.column, value });
    }
  }
  return { assignments, unreadable };
}
