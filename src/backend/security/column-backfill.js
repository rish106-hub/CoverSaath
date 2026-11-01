import { ENVELOPE_PREFIX } from './column-crypto.js';

// Seals rows written before column encryption (ADR 0013), or re-seals them under the current key after a rotation.
// Idempotent: a row whose columns are already sealed under the current key is not selected, so a second run changes 0 rows.
// Batched (one transaction per batch), keyset-paged by id, dry-run capable. Resolves counts only; it never returns, logs or
// throws a stored value. Run it as the table owner (the migrator role): three of the stores are append-only or immutable by
// trigger, and a batch disables exactly that trigger, updates, and enables it again inside the same transaction, so a crash
// or error restores it. Takes a short ShareRowExclusive lock per batch: run it in a quiet period.

export const ENCRYPTED_COLUMNS = Object.freeze([
  { table: 'adult_users', columns: ['display_name', 'contact_email', 'contact_phone'], triggers: [] },
  { table: 'households', columns: ['display_name'], triggers: [] },
  { table: 'household_members', columns: ['display_name'], triggers: [] },
  { table: 'source_pages', columns: ['extracted_text', 'blocks_json'], triggers: ['source_pages_blocks_immutable'] },
  { table: 'ocr_jobs', columns: ['result_json'], triggers: [] },
  { table: 'policy_clauses', columns: ['title', 'text'], triggers: ['policy_clauses_immutable'] },
  { table: 'policy_answers', columns: ['answer_json'], triggers: ['policy_answers_immutable'] },
  { table: 'evidence_facts', columns: ['value_json'], triggers: ['evidence_facts_provenance_immutable'] },
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
 * @param {boolean} [options.rotate] also re-seal values sealed under another key id
 * @param {number} [options.batchSize]
 * @returns {Promise<{dryRun: boolean, tables: Array<{table: string, rows: number, columns: number}>, rows: number, columns: number}>}
 */
export async function encryptExistingRows({ database, crypto, dryRun = false, rotate = false, batchSize = 200 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new RangeError('batchSize must be 1 to 5000.');
  const needs = value => value !== null && value !== undefined
    && (!crypto.isSealed(value) || (rotate && crypto.needsRotation(value)));
  const report = [];
  for (const { table, columns, triggers } of ENCRYPTED_COLUMNS) {
    const t = quote(table);
    const selectList = ['id', ...columns].map(quote).join(', ');
    // Selects candidates in SQL (not sealed under the current key) so a finished table is a cheap scan.
    const candidate = columns.map(column => {
      const c = quote(column);
      return rotate
        ? `(${c} IS NOT NULL AND (left(${c}, 5) <> '${ENVELOPE_PREFIX}' OR split_part(${c}, '.', 2) <> ?))`
        : `(${c} IS NOT NULL AND left(${c}, 5) <> '${ENVELOPE_PREFIX}')`;
    }).join(' OR ');
    const candidateParams = rotate ? columns.map(() => crypto.keyId) : [];
    let rows = 0;
    let sealedColumns = 0;
    let after = '';
    for (;;) {
      const done = await database.transaction(async () => {
        const batch = await database.many(
          `SELECT ${selectList} FROM public.${t} WHERE id > ? AND (${candidate}) ORDER BY id LIMIT ?${dryRun ? '' : ' FOR UPDATE'}`,
          [after, ...candidateParams, batchSize],
        );
        if (batch.length === 0) return { last: null };
        if (!dryRun) {
          for (const trigger of triggers) await database.run(`ALTER TABLE public.${t} DISABLE TRIGGER ${quote(trigger)}`);
          try {
            for (const row of batch) {
              const changes = columns.filter(column => needs(row[column]));
              if (changes.length === 0) continue;
              const values = changes.map(column => crypto.seal(table, column, row.id, crypto.open(table, column, row.id, row[column])));
              await database.run(`UPDATE public.${t} SET ${changes.map(column => `${quote(column)} = ?`).join(', ')} WHERE id = ?`, [...values, row.id]);
            }
          } finally {
            for (const trigger of triggers) await database.run(`ALTER TABLE public.${t} ENABLE TRIGGER ${quote(trigger)}`);
          }
        }
        let touched = 0;
        for (const row of batch) {
          const count = columns.filter(column => needs(row[column])).length;
          if (count > 0) { rows += 1; touched += count; }
        }
        sealedColumns += touched;
        return { last: batch.at(-1).id };
      });
      if (done.last === null) break;
      after = done.last;
    }
    report.push(Object.freeze({ table, rows, columns: sealedColumns }));
  }
  return Object.freeze({
    dryRun,
    tables: Object.freeze(report),
    rows: report.reduce((sum, item) => sum + item.rows, 0),
    columns: report.reduce((sum, item) => sum + item.columns, 0),
  });
}
