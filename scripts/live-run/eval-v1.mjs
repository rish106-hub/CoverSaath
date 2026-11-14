// Asks the 100 eval questions through chat v1 (the product path) on a live holding and scores:
//   answered    status evidence_found with at least one source
//   correct     the expected answer's key tokens (numbers, or words) all appear in the reply
//   cited       a source points at the expected document kind (and page when the source carries one)
//   unknown-ok  expected-unknown questions (matchRule.type 'unknown') answered 'unknown'
// Called by journey.mjs with --eval, in the same process, so the session token never touches disk.
// Prints scores and question ids only (no reply text).

const norm = s => String(s).toLowerCase().replace(/rs\.?|inr|₹/g, ' ').replace(/(\d),(?=\d)/g, '$1').replace(/[^a-z0-9.% ]+/g, ' ');
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'is', 'are', 'to', 'in', 'for', 'on', 'per', 'with', 'be', 'by', 'at', 'from']);
const tokens = s => { const n = norm(s); const nums = n.match(/\d+(?:\.\d+)?%?/g); return nums?.length ? nums : n.split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)); };
// 36 months printed in the policy is shown as 1095 days by the product.
const unitEquivalent = (expected, reply) => /\b36\b/.test(norm(expected)) && /1095 days/.test(reply);

export async function runEvalV1({ base, token, householdId, holdingId, documentKinds, questions }) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const kinds = new Map(Object.entries(documentKinds));
  const created = await fetch(`${base}/api/v1/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ household_id: householdId, holding_id: holdingId }) });
  const threadId = (await created.json()).thread.id;
  const rows = [];
  for (const q of questions) {
    const res = await fetch(`${base}/api/v1/chat/threads/${threadId}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: q.question }) });
    const block = (await res.text()).split('\n\n').find(b => /event: answer/.test(b));
    let a = {}; try { a = JSON.parse(/data: (.*)/s.exec(block ?? '')?.[1] ?? '{}'); } catch { a = {}; }
    const reply = norm(a.answer ?? a.text ?? '');
    const sources = Array.isArray(a.sources) ? a.sources : [];
    const expectsUnknown = q.matchRule?.type === 'unknown';
    const answered = a.status === 'evidence_found' && sources.length > 0;
    const want = expectsUnknown ? [] : tokens(q.expectedAnswer);
    const correct = !expectsUnknown && answered && want.length > 0 && (want.every(t => reply.includes(t)) || unitEquivalent(q.expectedAnswer, reply));
    const cited = !expectsUnknown && answered && sources.some(s => kinds.get(String(s.document_id)) === q.expectedSource?.documentKind && (s.page == null || s.page === q.expectedSource?.page));
    rows.push({ id: q.id, category: q.category, expectsUnknown, answered, correct, cited, pageDump: /synthetic fixture/.test(reply) });
  }
  const count = (f, xs) => `${xs.filter(f).length}/${xs.length}`;
  const known = rows.filter(r => !r.expectsUnknown);
  const unknown = rows.filter(r => r.expectsUnknown);
  console.log(`known ${known.length}: answered ${count(r => r.answered, known)}  correct ${count(r => r.correct, known)}  cited ${count(r => r.cited, known)}  whole-page answers ${count(r => r.pageDump, known)}`);
  console.log(`expected-unknown ${unknown.length}: said unknown ${count(r => !r.answered, unknown)}  answered anyway ${count(r => r.answered, unknown)}`);
  for (const category of new Set(known.map(r => r.category))) {
    const xs = known.filter(r => r.category === category);
    console.log(`  ${category.padEnd(20)} correct ${count(r => r.correct, xs).padEnd(6)} cited ${count(r => r.cited, xs)}`);
  }
  console.log('answered but wrong:', known.filter(r => r.answered && !r.correct).map(r => r.id).join(' '));
  console.log('invented (expected unknown):', unknown.filter(r => r.answered).map(r => r.id).join(' '));
  return rows;
}
