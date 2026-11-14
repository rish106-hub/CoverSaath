import { resolveColumnCrypto } from '../security/column-crypto.js';
import { ERASED_NAME } from '../../contracts/data-lifecycle.js';

// Read-only lookups for the rendered memory document (services/memory-document.js). Nothing here writes, so no new table, no new erasure
// path and no migration: the document is rendered on demand from rows that already have their own erasure paths (ADR 0032, ADR 0013).
// Every query is scoped to the household id the service proved. Sealed columns are opened here for the owning household's own response.

const clean = value => String(value).replace(/[\r\n[\]]+/g, ' ').trim();

export class MemoryDocumentRepository {
  constructor(database, options = {}) {
    if (!database) throw new TypeError('A database is required.');
    this.database = database;
    this.crypto = resolveColumnCrypto(options);
  }

  /** The policy of a holding: { policyNumberMasked, policyVersion, policyKind } (opened), or null. */
  async policyOf({ householdId, policyId }) {
    if (!policyId) return null;
    const row = await this.database.one('SELECT * FROM policies WHERE id = ? AND household_id = ?', [policyId, householdId]);
    if (!row) return null;
    const opened = this.crypto.openRow('policies', row, ['policy_number_masked', 'policy_version']);
    return Object.freeze({ policyNumberMasked: opened.policy_number_masked ?? null, policyVersion: opened.policy_version ?? null, policyKind: row.policy_kind });
  }

  /** Map page id -> { pageNumber, documentKind } for pages of the household's documents. */
  async pages({ householdId, pageIds }) {
    const ids = [...new Set(pageIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.database.many(`SELECT page.id, page.page_number, document.document_kind FROM source_pages page
      JOIN document_uploads document ON document.id = page.document_upload_id
      WHERE document.household_id = ? AND page.id = ANY(CAST(? AS text[]))`, [householdId, ids]);
    return new Map(rows.map(row => [row.id, Object.freeze({ pageNumber: Number(row.page_number), documentKind: row.document_kind })]));
  }

  /** Map memory fact id -> { clauseId, clauseLabel } for facts that cite a policy clause (household scoped). */
  async clausesOf({ householdId, factIds }) {
    const ids = [...new Set(factIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.database.many(`SELECT fact.id AS fact_id, clause.id AS clause_id, clause.title FROM household_memory_facts fact
      JOIN policy_clauses clause ON clause.id = fact.policy_clause_id AND clause.household_id = fact.household_id
      WHERE fact.household_id = ? AND fact.id = ANY(CAST(? AS text[]))`, [householdId, ids]);
    return new Map(rows.map(row => [row.fact_id, Object.freeze({ clauseId: row.clause_id, clauseLabel: clean(row.title || row.clause_id) })]));
  }

  /**
   * People covered by the holding's policy (policy_members), else every member of the household. Opened. Erased members are left out.
   * [{ id, name, relationship, kind, state, sourcePageId }]
   */
  async members({ householdId, policyId }) {
    const covered = policyId ? await this.database.many(`SELECT member.*, link.membership_state, link.source_page_id FROM policy_members link
      JOIN household_members member ON member.id = link.household_member_id
      JOIN policies policy ON policy.id = link.policy_id
      WHERE policy.household_id = ? AND member.household_id = ? AND link.policy_id = ? ORDER BY member.created_at, member.id LIMIT 50`, [householdId, householdId, policyId]) : [];
    const rows = covered.length > 0 ? covered : await this.database.many(
      'SELECT member.*, NULL AS membership_state, NULL AS source_page_id FROM household_members member WHERE member.household_id = ? ORDER BY member.created_at, member.id LIMIT 50', [householdId]);
    return rows.map(row => {
      const opened = this.crypto.openRow('household_members', row, ['display_name', 'relationship_label']);
      return Object.freeze({ id: row.id, name: opened.display_name, relationship: opened.relationship_label ?? null, kind: row.member_kind, state: row.membership_state, sourcePageId: row.source_page_id ?? null });
    }).filter(member => member.name !== ERASED_NAME);
  }
}
