// Test helpers for columns sealed at rest (ADR 0013, addendum D2). Synthetic data only.
import { sharedColumnCrypto } from '../../src/backend/security/column-crypto.js';

/** Opens one stored value with the process-wide (development) key the tests run under. Legacy plaintext passes through. */
export const plain = (table, column, rowId, value) => sharedColumnCrypto().open(table, column, rowId, value);

/** Copy of `row` with the named columns opened, using row[idColumn] as the row id. */
export const openStored = (table, row, columns, idColumn = 'id') => sharedColumnCrypto().openRow(table, row, columns, idColumn);

import { ENCRYPTED_COLUMNS } from '../../src/backend/security/column-backfill.js';

/** Row with every registry column of `table` opened (the stored form is ciphertext). Rows of other tables pass through. */
export function openRegistryRow(table, row) {
  if (!row) return row;
  const crypto = sharedColumnCrypto();
  const copy = { ...row };
  for (const entry of ENCRYPTED_COLUMNS.filter(item => item.table === table)) {
    const rowId = entry.rowId ? entry.rowId(row) : String(row[(entry.key ?? ['id'])[0]]);
    for (const column of entry.columns) if (column in copy) copy[column] = crypto.open(table, column, rowId, row[column]);
  }
  return copy;
}

/** `SELECT * FROM table <where>` with the sealed columns opened. `db` is a database interface (one/many). */
export const plainRows = async (db, table, where = '', params = []) => (await db.many(`SELECT * FROM ${table} ${where}`, params)).map(row => openRegistryRow(table, row));
export const plainRow = async (db, table, where = '', params = []) => openRegistryRow(table, await db.one(`SELECT * FROM ${table} ${where}`, params)) ?? null;

/** The named columns of a row, for deepEqual assertions that listed only some columns. */
export const pick = (row, ...columns) => Object.fromEntries(columns.map(column => [column, row[column]]));
