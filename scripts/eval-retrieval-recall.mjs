#!/usr/bin/env node
/**
 * Retrieval recall of the question pipeline (retrieval only, no provider call, no cost).
 *   node scripts/eval-retrieval-recall.mjs [--budget <bytes>]
 * Inputs (owner-verified, gitignored): .local/eval/retrieval-golden.json
 *   { "pages": [{ "page": 1, "blocks": [{ "tag": "paragraph", "text": "..." }] }],
 *     "questions": [{ "id": "q1", "question": "...", "expected": [{ "page": 61, "quote": "verbatim text" }] }] }
 * Use a small --budget to force the FTS path; at the default budget a small policy is read whole and recall is trivially 1.
 * Prints counts and page numbers only. Recall of a human-verified set is a measurement; the synthetic fixture in
 * tests/policy-evidence-recall.test.mjs is not.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { buildClauses, evaluateRecall } from '../src/features/policy-evidence/index.js';
import { parameterAt, parameterIds, seedParameterWorld } from '../tests/support/parameter-fixtures.mjs';

const budgetIndex = process.argv.indexOf('--budget');
const budgetBytes = budgetIndex > -1 ? Number(process.argv[budgetIndex + 1]) : undefined;
const golden = JSON.parse(await readFile(resolve('.local/eval/retrieval-golden.json'), 'utf8'));
const database = openDatabase({ path: ':memory:' });
try {
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const { householdId, caseId, documentId } = parameterIds;
  const stored = { pages: golden.pages.map(page => ({ page: page.page, status: 'stored', blocks: page.blocks })) };
  const { clauses } = buildClauses(stored, { documentId, sourceVersion: 'eval-v1' });
  services.clauses.saveClauses({ householdId, caseId, documentId, clauses });
  const search = ({ query, kinds, limit }) => services.clauses.searchClauses({ householdId, caseId, documentIds: [documentId], query, kinds, limit });
  const report = evaluateRecall({ clauses: services.clauses.listClauses({ householdId, caseId, documentIds: [documentId] }), search, golden: golden.questions, budgetBytes });
  console.log(JSON.stringify(report, null, 2));
} finally { database.close(); }
