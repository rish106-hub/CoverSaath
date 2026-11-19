import { POLICY_FACT_KEYS, getPolicyFactKey } from '../../contracts/policy-facts.js';
import { factSourceLabel } from '../../features/insurance-rules/fact-source-label.js';
import { checkProseLine } from '../../features/chat-answer-guard/index.js';
import { gateTextForHousehold, sealModelInput } from '../../features/ai-analysis/privacy-evidence-gate.js';
import { POLICY_DOC_PROSE_LINE_MAX, POLICY_DOC_PROSE_MAX_LINES, POLICY_DOC_PROSE_TASK } from '../../features/ai-analysis/gateway-contract.js';
import { holdingsEnabled } from './holdings-flag.js';
import { memoryEnabled } from './memory-service.js';

// The owner's private "memory.md" (target flow step 12-13, ADR 0032), RENDERED ON DEMAND from rows that already exist and are already
// sealed: the holding, its resolved facts and quotes, the declarations, premium payments and dues, open conflicts. Nothing is written:
//   * no plaintext file and no new table, so nothing sits at rest unsealed (invariant 8), and
//   * no new erasure path: erasing a holding, a document, a grant or the household already erases every row this reads (invariant 3).
//     After a revocation the rows are gone or the document grant is no longer current, and this answers CONSENT_REQUIRED or 404.
// Deterministic code only. No model call, no provider, no log of any value. The caller (the route, or the chat path later) must still pass
// the text through the privacy gate before any model sees it: this is the OWNER's own view and holds names, amounts and declarations.
//
// Citations: every fact line ends with `[document kind, p.N, clause X]` (clause and page only when stored) or `[unknown]`. A line that rests
// on the owner's own statement ends `[owner statement]`. Policy number: only the last 4 characters are shown.
//
// ADR 0039: for a holding with insurer-tier rows (ADR 0036) an own-PDF slot that is unknown may be filled by the insurer's wording. Those facts sit
// in their own block, "Insurer terms your document doesn't state", each marked by tier and status, with the insurer's page and quote. Order of
// authority per slot is collate's (reviewed insurer > own PDF > unchecked insurer > unknown): this file only presents what resolveSlot decided.
// An optional prose pass (POLICY_DOC_PROSE_ENABLED, off) may reword fact sentences; see renderWithProse. Nothing is stored either way.
//
// Wording shown to the reader (the header notice, the section names, "check with the insurer") is a draft FOR LEGAL REVIEW.

const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const notFound = () => coded('HOLDING_NOT_FOUND', 'The holding was not found.', 404);
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const QUOTE_MAX = 160;
const OPEN_QUESTIONS_MAX = 15;

// FOR LEGAL REVIEW: the heading of the insurer block.
export const INSURER_BLOCK_HEADING = "Insurer terms your document doesn't state";
export const MEMORY_DOCUMENT_SECTIONS = Object.freeze([
  'Policy', 'People covered', 'Cover and limits', 'Waiting periods', 'Exclusions', INSURER_BLOCK_HEADING, 'Declared conditions', 'Premiums and dues', 'Conflicts to resolve', 'Open questions',
]);
// Only fact sentences of these sections may go to the prose pass (ADR 0039 D5): never names, the UIN, declarations, premiums or conflicts.
const PROSE_SECTIONS = Object.freeze(['Cover and limits', 'Waiting periods', 'Exclusions', INSURER_BLOCK_HEADING]);
export const PROSE_NOTICE = 'Wording simplified by a model; values, quotes and pages are set by code. (Draft wording, FOR LEGAL REVIEW.)';
const PROSE_TIMEOUT_MS = 20_000;
const PROSE_CHUNK_CHARS = 1_500;

// Registry groups -> section. Anything not listed (dates, bonus, network, claims, renewal, members, seller) is cover and limits.
const SECTION_OF_GROUP = Object.freeze({ waiting: 'Waiting periods', exclusions: 'Exclusions', declarations: 'Declared conditions', premium: 'Premiums and dues', payment: 'Premiums and dues' });
const sectionOf = group => SECTION_OF_GROUP[group] ?? 'Cover and limits';

const oneLine = text => String(text).replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim();
const quoteOf = text => { const line = oneLine(text); return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1)}…` : line; };

/** Last 4 characters only; everything before them becomes X. Null or too short: unknown. */
export function maskPolicyNumber(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 4) return null;
  return `${'X'.repeat(Math.min(compact.length - 4, 12))}${compact.slice(-4)}`;
}

// Indian digit grouping for rupees.
function rupees(minor) {
  const whole = Math.trunc(minor / 100);
  const paise = Math.abs(minor % 100);
  const digits = String(Math.abs(whole));
  const grouped = digits.length > 3 ? `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}` : digits;
  return `INR ${whole < 0 ? '-' : ''}${grouped}${paise ? `.${String(paise).padStart(2, '0')}` : ''}`;
}

/** A stored fact value in words. Null when the value does not fit its type. */
export function formatFactValue(type, value) {
  if (!value || typeof value !== 'object') return null;
  switch (type) {
    case 'money': return Number.isSafeInteger(value.amountMinor) ? rupees(value.amountMinor) : null;
    case 'date': return typeof value.iso === 'string' ? value.iso : null;
    case 'date_range': return value.startIso && value.endIso ? `${value.startIso} to ${value.endIso}` : null;
    case 'duration': return Number.isInteger(value.days) ? `${value.days} days` : null;
    case 'percent': return Number.isInteger(value.bp) ? `${value.bp / 100}%` : null;
    case 'number': return Number.isInteger(value.n) ? String(value.n) : null;
    case 'enum': return typeof value.value === 'string' ? value.value.replace(/_/g, ' ') : null;
    case 'bool': return typeof value.value === 'boolean' ? (value.value ? 'yes' : 'no') : null;
    case 'text': return typeof value.text === 'string' ? oneLine(value.text).slice(0, 300) : null;
    default: return null;
  }
}

const citation = ({ documentKind, pageNumber, clauseLabel }) => {
  if (!documentKind && !pageNumber) return '[unknown]';
  return `[${[documentKind ?? 'document', pageNumber ? `p.${pageNumber}` : null, clauseLabel ? `clause ${clauseLabel}` : null].filter(Boolean).join(', ')}]`;
};

// A fact line, kept in two parts so the prose pass can reword the sentence and code can re-append the tail unchanged.
const factLine = (sentence, tail) => ({ text: `- ${sentence}${tail}`, sentence, tail });
const lineText = line => (typeof line === 'string' ? line : line.text);

export function createMemoryDocumentService({ holdingRepository, holdings, repository, declarations, premiums, households, gateway = null, providerConsent = null, loadKnownIdentifiers = null, env = process.env, clock = () => new Date(), proseTimeoutMs = null, onEvent = null }) {
  // POLICY_DOC_PROSE_TIMEOUT_MS (50 to 60000) bounds the whole prose pass; a bad value keeps the default.
  const timeoutMs = Number.isInteger(proseTimeoutMs) ? proseTimeoutMs : (Number.isInteger(Number(env.POLICY_DOC_PROSE_TIMEOUT_MS)) && Number(env.POLICY_DOC_PROSE_TIMEOUT_MS) >= 50 && Number(env.POLICY_DOC_PROSE_TIMEOUT_MS) <= 60_000 ? Number(env.POLICY_DOC_PROSE_TIMEOUT_MS) : PROSE_TIMEOUT_MS);
  for (const [name, dependency] of Object.entries({ holdingRepository, holdings, repository, declarations, premiums, households })) if (!dependency) throw new TypeError(`${name} is required.`);

  const enabled = () => holdingsEnabled(env) && memoryEnabled(env);
  const requireEnabled = () => {
    if (!holdingsEnabled(env)) throw coded('HOLDINGS_DISABLED', 'Holdings are disabled.', 503);
    if (!memoryEnabled(env)) throw coded('MEMORY_DISABLED', 'Memory is disabled.', 503);
  };

  // Owner of the holding's household, holding exists, and the holding's document may still be read (its document_processing grant is current).
  // A foreign household, a missing holding and a non-owner are the same 404. A withdrawn grant is the coded CONSENT_REQUIRED (403).
  async function requireOwnedHolding({ householdId, holdingId, adultId }) {
    if (typeof holdingId !== 'string' || !ID.test(holdingId) || typeof adultId !== 'string') throw notFound();
    const actual = await holdingRepository.householdOfHolding(holdingId);
    if (!actual || (householdId && householdId !== actual)) throw notFound();
    const roles = await households.listActiveRoles(actual, adultId);
    if (!roles.some(item => item.role === 'owner')) throw notFound();
    const holding = await holdingRepository.getHolding({ householdId: actual, holdingId });
    if (!holding) throw notFound();
    const readable = await holdingRepository.readableDocuments({ householdId: actual, documentIds: [holding.documentId] });
    if (!readable.has(holding.documentId)) throw coded('CONSENT_REQUIRED', 'Active consent is required before this information can be shown.', 403);
    return holding;
  }

  // The prose pass needs its own flag (exactly "true"), a gateway with a ready route, the chat consent resolver and the household identifier loader.
  const proseEnabled = () => env.POLICY_DOC_PROSE_ENABLED === 'true' && Boolean(gateway?.enabled) && Boolean(providerConsent) && typeof loadKnownIdentifiers === 'function';

  async function build({ householdId = null, holdingId, adultId }) {
    requireEnabled();
    const holding = await requireOwnedHolding({ householdId, holdingId, adultId });
    const hid = holding.householdId;

    const [factsView, conflictsView, names, policy, members] = await Promise.all([
      holdings.facts({ holding }),
      holdings.conflicts({ holding }),
      holdingRepository.confirmedNames({ householdId: hid, holdings: [holding] }),
      repository.policyOf({ householdId: hid, policyId: holding.policyId }),
      repository.members({ householdId: hid, policyId: holding.policyId }),
    ]);
    const uin = holding.policyProfileId ? await holdingRepository.confirmedUin({ householdId: hid, policyProfileId: holding.policyProfileId }) : null;
    const declared = (await declarations.list({ householdId: hid, adultId })).declarations.filter(item => item.holdingId === holding.id || item.holdingId === null);
    const payments = await premiums.listPayments({ householdId: hid, adultId, holdingId: holding.id });
    const dues = await premiums.listDues({ householdId: hid, adultId, holdingId: holding.id });

    // Pages and clauses behind every source row that appears below.
    const sourcesOf = fact => fact.sources ?? [];
    const allSources = [...factsView.facts.flatMap(sourcesOf), ...conflictsView.conflicts.flatMap(conflict => conflict.candidates)];
    const pages = await repository.pages({ householdId: hid, pageIds: [...allSources.map(source => source.page?.pageId), ...members.map(member => member.sourcePageId)] });
    const clauses = await repository.clausesOf({ householdId: hid, factIds: allSources.map(source => source.id) });

    const cite = source => {
      if (!source) return '[unknown]';
      const clause = clauses.get(source.id);
      if (source.tier === 'user_declaration') return '[owner statement]';
      if (source.page?.pageId) {
        const page = pages.get(source.page.pageId);
        return citation({ documentKind: source.page.documentKind ?? page?.documentKind, pageNumber: page?.pageNumber, clauseLabel: clause?.clauseLabel });
      }
      if (source.reference?.pageNumber) return citation({ documentKind: 'insurer_wording', pageNumber: source.reference.pageNumber, clauseLabel: clause?.clauseLabel });
      return '[unknown]';
    };
    const citeFact = fact => {
      // The cited source is the one that decided the value (its tier), else the first one with a page.
      const decided = fact.sources.find(source => source.tier === fact.sourceTier && source.id && (fact.sourceIds ?? []).includes(source.id)) ?? fact.sources.find(source => source.page || source.reference) ?? fact.sources[0] ?? null;
      return { text: cite(decided), quote: decided?.quote ? quoteOf(decided.quote) : null };
    };

    const sections = new Map(MEMORY_DOCUMENT_SECTIONS.map(name => [name, []]));
    const unknownLabels = [];
    for (const fact of factsView.facts) {
      const entry = getPolicyFactKey(fact.factKey);
      // ADR 0039 D2: a fact only the insurer states (no own-PDF source) goes to its own block, never into a topic section as well.
      const insurerOnly = fact.sourceTier === 'ida_wording' && fact.status !== 'conflicting' && !fact.sources.some(source => source.tier === 'own_pdf');
      const section = sections.get(insurerOnly ? INSURER_BLOCK_HEADING : sectionOf(entry?.group));
      const label = entry?.label ?? fact.factKey;
      if (fact.status === 'conflicting') { section.push(`- ${label} Not settled: two readings disagree, see Conflicts to resolve. [unknown]`); continue; }
      const text = fact.status === 'unknown' ? null : formatFactValue(fact.valueType, fact.value);
      if (text === null) { unknownLabels.push(label); section.push(`- ${label} Unknown. [unknown]`); continue; }
      const cited = citeFact(fact);
      // ADR 0036 D6 and 0039 D3: an unchecked insurer reading with no quote is not shown (chat does not cite it either); it is an open question.
      if (insurerOnly && fact.status === 'extracted_unverified' && !cited.quote) { unknownLabels.push(label); continue; }
      // FOR LEGAL REVIEW (ADR 0036): an unchecked insurer reading is labelled by tier and status together.
      const status = fact.status === 'extracted_unverified' ? (fact.sourceTier === 'ida_wording' ? ` (${factSourceLabel(fact)})` : ' (read from your document, not verified)') : fact.status === 'reviewed_reference' ? ' (insurer wording)' : fact.status === 'user_confirmed' ? ' (you stated this)' : '';
      const insurerNote = fact.checkWithInsurer ? ' Check with the insurer.' : '';
      section.push(factLine(`${label} ${text}`, `${status}${insurerNote}${cited.quote ? ` Quote: "${cited.quote}"` : ''} ${cited.text}`));
    }
    for (const key of factsView.unknownKeys) {
      const entry = getPolicyFactKey(key);
      if (entry && entry.factClass !== 'household_declaration') unknownLabels.push(entry.label);
    }

    // Declarations (sealed labels, opened for the owner's own view).
    const memberName = new Map(members.map(member => [member.id, member.name]));
    for (const item of declared) {
      const who = memberName.get(item.memberId) ?? 'a household member';
      const kind = String(item.kind).replace(/_/g, ' ');
      sections.get('Declared conditions').push(`- ${who}: ${oneLine(item.label)} (${kind}${item.declaredOn ? `, declared on ${item.declaredOn}` : ''}${item.declaredToInsurer === true ? ', declared to the insurer' : item.declaredToInsurer === false ? ', not declared to the insurer' : ''}) [owner statement]`);
    }

    for (const payment of payments) sections.get('Premiums and dues').push(`- Premium paid ${payment.paidOn}: ${rupees(payment.amountPaise)} by ${String(payment.channel).replace(/_/g, ' ')} [owner statement]`);
    for (const due of dues) sections.get('Premiums and dues').push(`- Premium due ${due.dueOn}: ${rupees(due.amountPaise)}, ${due.state} [owner statement]`);

    const conflictLines = [];
    for (const conflict of conflictsView.conflicts.filter(item => item.resolution === 'pending')) {
      const entry = getPolicyFactKey(conflict.factKey);
      const sides = conflict.candidates.filter(candidate => candidate.current !== false).map(candidate => {
        const alternatives = candidate.status === 'conflicting' ? (candidate.alternatives ?? []) : [candidate.value];
        const shown = alternatives.map(value => formatFactValue(entry?.type, value)).filter(Boolean).join(' or ') || 'no value';
        return `${shown} ${cite(candidate)}`;
      });
      conflictLines.push(`- ${entry?.label ?? conflict.factKey} Readings: ${sides.join('; ') || 'none'}${conflict.checkWithInsurer ? ' Check with the insurer.' : ''} [unknown]`);
    }
    sections.set('Conflicts to resolve', conflictLines);

    const questions = [...new Set(unknownLabels)].slice(0, OPEN_QUESTIONS_MAX).map(label => `- ${label} [unknown]`);
    sections.set('Open questions', questions);

    // People covered.
    const peopleLines = members.map(member => {
      const page = member.sourcePageId ? pages.get(member.sourcePageId) : null;
      return `- ${oneLine(member.name)}${member.relationship ? ` (${oneLine(member.relationship)})` : ''}, ${member.kind} ${page ? citation({ documentKind: page.documentKind, pageNumber: page.pageNumber }) : '[unknown]'}`;
    });
    sections.set('People covered', peopleLines);

    // Policy.
    const insurerName = names.get(holding.id)?.insurerName ?? null;
    const productName = names.get(holding.id)?.productName ?? null;
    const masked = maskPolicyNumber(policy?.policyNumberMasked);
    sections.set('Policy', [
      `- Insurer: ${insurerName ? oneLine(insurerName) : 'unknown'} ${insurerName ? '[owner statement]' : '[unknown]'}`,
      `- Product: ${productName ? oneLine(productName) : 'unknown'} ${productName ? '[owner statement]' : '[unknown]'}`,
      `- UIN: ${uin ?? 'unknown'} ${uin ? '[owner statement]' : '[unknown]'}`,
      `- Version: ${policy?.policyVersion ? oneLine(policy.policyVersion) : 'unknown'} ${policy?.policyVersion ? '[policy record]' : '[unknown]'}`,
      `- Policy number: ${masked ?? 'unknown'} ${masked ? '[policy record]' : '[unknown]'}`,
    ]);

    const header = [
      '# Memory',
      '',
      // FOR LEGAL REVIEW: reader-facing notice.
      '> Built from your own documents and answers, shown only to you. Values read from your documents are not verified. The insurer\'s wording governs; check with the insurer before relying on any line. (Draft wording, FOR LEGAL REVIEW.)',
      '',
      `Generated ${clock().toISOString().slice(0, 10)}. Policy number shown by its last 4 characters only.`,
    ];
    return { holding, header, sections };
  }

  // Joins the parts into markdown. `rewrites` maps a fact line (by identity) to its reworded sentence; the tail (label, quote, citation) is code's.
  function serialize({ header, sections }, { rewrites = null, notice = null } = {}) {
    const out = [...header];
    if (notice) out.push('', notice);
    for (const name of MEMORY_DOCUMENT_SECTIONS) {
      out.push('', `## ${name}`, '');
      const lines = sections.get(name);
      out.push(...(lines.length > 0 ? lines.map(line => (rewrites?.has(line) ? `- ${rewrites.get(line)}${line.tail}` : lineText(line))) : ['- None recorded. [unknown]']));
    }
    return `${out.join('\n')}\n`;
  }

  async function render(args) { return serialize(await build(args)); }

  // The fact sentences the prose pass may see (ADR 0039 D5): fact lines of the fact sections that state a value, short enough for the task.
  function proseCandidates(parts) {
    const found = [];
    for (const name of PROSE_SECTIONS) {
      for (const line of parts.sections.get(name)) {
        if (typeof line !== 'string' && line.sentence.length <= POLICY_DOC_PROSE_LINE_MAX - 20) found.push(line);
      }
    }
    return found.map((line, index) => ({ id: `l${index + 1}`, line }));
  }

  const chunksOf = items => {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const item of items) {
      if (current.length > 0 && (size + item.line.sentence.length > PROSE_CHUNK_CHARS || current.length >= POLICY_DOC_PROSE_MAX_LINES)) { chunks.push(current); current = []; size = 0; }
      current.push(item);
      size += item.line.sentence.length + 40;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  };

  // One model call for one chunk. Returns Map line -> reworded sentence, or a failure code string. Never throws a coded error the caller must treat as final.
  async function rewriteChunk({ householdId, adultId, chunk, signal, grant }) {
    let known;
    const loader = () => (known ??= loadKnownIdentifiers(householdId));
    const sent = [];
    const rehydrate = new Map();
    for (const item of chunk) {
      try {
        const gated = await gateTextForHousehold(item.line.sentence, { householdId, loadKnownIdentifiers: loader });
        sent.push({ item, wire: { line_id: item.id, text: gated.gated } });
        rehydrate.set(item.id, gated.rehydrate);
      } catch (error) {
        // A sentence the gate refuses is not sent; its line stays as the deterministic render has it.
        if (['RESTRICTED_EVIDENCE', 'EVIDENCE_SOURCE_LIMIT', 'PRIVACY_GATE_MALFORMED'].includes(error?.code)) continue;
        throw error;
      }
    }
    if (sent.length === 0) return new Map();
    if (typeof gateway.callRouted !== 'function') return 'no_routed_gateway';
    const authorize = async provider => {
      const grantId = await providerConsent.resolve({ householdId, adultId, kind: 'chat', provider });
      if (!grantId) return null;
      await providerConsent.require({ householdId, adultId, grantId, kind: 'chat', provider });
      return { grantId, provider };
    };
    const input = sealModelInput(POLICY_DOC_PROSE_TASK, { payload: { lines: sent.map(entry => entry.wire) } });
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(coded('PROSE_TIMEOUT', 'The prose pass timed out.', 504)), { once: true }));
    const result = await Promise.race([gateway.callRouted({ task: POLICY_DOC_PROSE_TASK, input, householdId, signal, authorize }), aborted]);
    if (!result || result.metadata?.calls === 0 || result.output?.status !== 'extracted_unverified') return result?.metadata?.unavailableReason ?? 'model_unknown';
    grant.value = result.authorization ?? null;
    const byId = new Map(result.output.lines.map(line => [line.line_id, line.text]));
    if (byId.size !== sent.length) return 'line_count';
    const rewrites = new Map();
    for (const { item } of sent) {
      if (!byId.has(item.id)) return 'line_missing';
      const text = rehydrate.get(item.id)(byId.get(item.id));
      const failed = checkProseLine({ source: item.line.sentence, text });
      if (failed.length > 0) return `guard:${failed.join('+')}`;
      rewrites.set(item.line, text.replace(/\s+/g, ' ').trim());
    }
    return rewrites;
  }

  /**
   * policy.md with an optional prose pass (ADR 0039). Resolves { text, source: 'prose' | 'deterministic', reason? }. The deterministic render is built first; the
   * model only rewords fact sentences, every line is checked against its own source sentence, and any failure (flag off, no consent, budget, timeout, bad or
   * unguarded output, consent withdrawn while the call ran) serves the deterministic text. Nothing is stored. A withdrawn document grant is not a fallback:
   * it answers the same 403 CONSENT_REQUIRED as render().
   */
  async function renderWithProse({ householdId = null, holdingId, adultId }) {
    const parts = await build({ householdId, holdingId, adultId });
    const deterministic = () => serialize(parts);
    const fallback = reason => {
      try { onEvent?.({ event: 'policy_doc_prose_fallback', reason: String(reason).replace(/[^A-Za-z0-9_:+-]/g, '_').slice(0, 80) }); } catch { /* logging never breaks a render */ }
      return { text: deterministic(), source: 'deterministic', reason };
    };
    if (!proseEnabled()) return { text: deterministic(), source: 'deterministic', reason: 'disabled' };
    const actualHousehold = parts.holding.householdId;
    const candidates = proseCandidates(parts);
    if (candidates.length === 0) return fallback('nothing_to_reword');
    const chunks = chunksOf(candidates);
    if (chunks.length > 4) return fallback('too_long');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const grant = { value: null };
    const rewrites = new Map();
    try {
      for (const chunk of chunks) {
        const done = await rewriteChunk({ householdId: actualHousehold, adultId, chunk, signal: controller.signal, grant });
        if (!(done instanceof Map)) return fallback(done);
        for (const [line, text] of done) rewrites.set(line, text);
      }
      // The commit step (here: serving). The provider grant must still be current and exact; withdrawn mid-pass means the plain version.
      if (!grant.value?.grantId) return fallback('consent_required');
      await providerConsent.require({ householdId: actualHousehold, adultId, grantId: grant.value.grantId, kind: 'chat', provider: grant.value.provider });
    } catch (error) {
      return fallback(typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(error.code) ? error.code : 'prose_failed');
    } finally { clearTimeout(timer); }
    // The document grant: if it was withdrawn while the call ran, the owner gets the same coded 403 as render() (never a stale text).
    await requireOwnedHolding({ householdId: actualHousehold, holdingId, adultId });
    return { text: serialize(parts, { rewrites, notice: PROSE_NOTICE }), source: 'prose' };
  }

  return Object.freeze({ enabled, proseEnabled, render, renderWithProse });
}
