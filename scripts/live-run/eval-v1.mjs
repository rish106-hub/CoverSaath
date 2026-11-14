// Asks the 100 eval questions through chat v1 (the product path) on the live holding and scores:
//   answered   status evidence_found with at least one source
//   correct    expected answer's key tokens (numbers, or words) all appear in the reply
//   cited      a source points at the expected document kind (page when the source carries one)
//   unknown-ok expected-unknown questions answered 'unknown' (no invented answer)
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const here = '.local/live-run';
const repo = process.cwd();
const state = JSON.parse(await readFile(join(here, 'state.json'), 'utf8'));
const set = JSON.parse(await readFile(join(repo, 'scripts/fixtures/synthetic-policy-questions.json'), 'utf8'));
const BASE = 'http://127.0.0.1:8787';
const H = { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' };
const kindOf = { [state.docs.policy_schedule]: 'schedule', [state.docs.policy_wording]: 'terms' };

const norm = s => String(s).toLowerCase().replace(/rs\.?|inr|₹/g, ' ').replace(/(\d),(?=\d)/g, '$1').replace(/[^a-z0-9.% ]+/g, ' ');
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'is', 'are', 'to', 'in', 'for', 'on', 'per', 'with', 'be', 'by', 'at', 'from']);
const tokens = s => { const n = norm(s); const nums = n.match(/\d+(?:\.\d+)?%?/g); return nums?.length ? nums : n.split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)); };

const thread = await (await fetch(`${BASE}/api/v1/chat/threads`, { method: 'POST', headers: H, body: JSON.stringify({ household_id: state.householdId, holding_id: state.holdingId }) })).json();
const rows = [];
for (const q of set.questions) {
  const res = await fetch(`${BASE}/api/v1/chat/threads/${thread.thread.id}/turns`, { method: 'POST', headers: H, body: JSON.stringify({ message: q.question }) });
  const text = await res.text();
  const block = text.split('\n\n').find(b => /event: answer/.test(b));
  let a = {}; try { a = JSON.parse(/data: (.*)/s.exec(block ?? '')?.[1] ?? '{}'); } catch {}
  const reply = String(a.answer ?? a.text ?? '');
  const sources = Array.isArray(a.sources) ? a.sources : [];
  const expectsUnknown = q.expectedAnswer == null || q.expectsUnknown === true || q.category === 'expected-unknown';
  const answered = a.status === 'evidence_found' && sources.length > 0;
  const want = expectsUnknown ? [] : tokens(q.expectedAnswer);
  const got = norm(reply);
  const correct = !expectsUnknown && answered && want.length > 0 && want.every(t => got.includes(t));
  const cited = !expectsUnknown && answered && sources.some(s => kindOf[s.document_id] === q.expectedSource?.documentKind && (s.page == null || s.page === q.expectedSource?.page));
  rows.push({ id: q.id, category: q.category, expectsUnknown, status: a.status ?? `http_${res.status}`, answered, correct, cited, invented: expectsUnknown && answered, reply: reply.slice(0, 160) });
}
const by = (f, xs = rows) => `${xs.filter(f).length}/${xs.length}`;
const known = rows.filter(r => !r.expectsUnknown); const unk = rows.filter(r => r.expectsUnknown);
console.log(`known questions: ${known.length}  answered ${by(r => r.answered, known)}  correct ${by(r => r.correct, known)}  cited ${by(r => r.cited, known)}`);
console.log(`expected-unknown: ${unk.length}  said unknown ${by(r => !r.answered, unk)}  invented ${by(r => r.invented, unk)}`);
const cats = [...new Set(known.map(r => r.category))];
for (const c of cats) { const xs = known.filter(r => r.category === c); console.log(`  ${c.padEnd(20)} answered ${by(r => r.answered, xs).padEnd(6)} correct ${by(r => r.correct, xs).padEnd(6)} cited ${by(r => r.cited, xs)}`); }
console.log('wrong-but-answered:', known.filter(r => r.answered && !r.correct).map(r => r.id).join(' '));
console.log('invented:', rows.filter(r => r.invented).map(r => r.id).join(' '));
await writeFile(join(here, 'eval-v1-report.json'), JSON.stringify(rows, null, 1));
