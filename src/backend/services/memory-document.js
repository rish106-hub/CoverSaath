import { POLICY_FACT_KEYS, getPolicyFactKey } from '../../contracts/policy-facts.js';
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
// Wording shown to the reader (the header notice, the section names, "check with the insurer") is a draft FOR LEGAL REVIEW.

const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const notFound = () => coded('HOLDING_NOT_FOUND', 'The holding was not found.', 404);
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const QUOTE_MAX = 160;
const OPEN_QUESTIONS_MAX = 15;

export const MEMORY_DOCUMENT_SECTIONS = Object.freeze([
  'Policy', 'People covered', 'Cover and limits', 'Waiting periods', 'Exclusions', 'Declared conditions', 'Premiums and dues', 'Conflicts to resolve', 'Open questions',
]);

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

export function createMemoryDocumentService({ holdingRepository, holdings, repository, declarations, premiums, households, env = process.env, clock = () => new Date() }) {
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

  async function render({ householdId = null, holdingId, adultId }) {
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
      const section = sections.get(sectionOf(entry?.group));
      const label = entry?.label ?? fact.factKey;
      if (fact.status === 'conflicting') { section.push(`- ${label} Not settled: two readings disagree, see Conflicts to resolve. [unknown]`); continue; }
      const text = fact.status === 'unknown' ? null : formatFactValue(fact.valueType, fact.value);
      if (text === null) { unknownLabels.push(label); section.push(`- ${label} Unknown. [unknown]`); continue; }
      const cited = citeFact(fact);
      const status = fact.status === 'extracted_unverified' ? ' (read from your document, not verified)' : fact.status === 'reviewed_reference' ? ' (insurer wording)' : fact.status === 'user_confirmed' ? ' (you stated this)' : '';
      const insurerNote = fact.checkWithInsurer ? ' Check with the insurer.' : '';
      section.push(`- ${label} ${text}${status}${insurerNote}${cited.quote ? ` Quote: "${cited.quote}"` : ''} ${cited.text}`);
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

    const out = [
      '# Memory',
      '',
      // FOR LEGAL REVIEW: reader-facing notice.
      '> Built from your own documents and answers, shown only to you. Values read from your documents are not verified. The insurer\'s wording governs; check with the insurer before relying on any line. (Draft wording, FOR LEGAL REVIEW.)',
      '',
      `Generated ${clock().toISOString().slice(0, 10)}. Policy number shown by its last 4 characters only.`,
    ];
    for (const name of MEMORY_DOCUMENT_SECTIONS) {
      out.push('', `## ${name}`, '');
      const lines = sections.get(name);
      out.push(...(lines.length > 0 ? lines : ['- None recorded. [unknown]']));
    }
    return `${out.join('\n')}\n`;
  }

  return Object.freeze({ enabled, render });
}
