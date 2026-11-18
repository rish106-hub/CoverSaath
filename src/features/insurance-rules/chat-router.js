// Chat router helpers (ADR 0038). Pure code: when the router runs, how its output is checked, and the fixed answers for the sources that
// need no model. The model only proposes { canonical_question, sources }; it never states a fact and code decides what to call.
// Wording is DRAFT and FOR LEGAL REVIEW.

import { ROUTER_QUESTION_MAX, ROUTER_SOURCES } from '../ai-analysis/gateway-contract.js';

/** Fixed sentence for text that is not a health-insurance question (or tries to instruct the chat). */
export const SCOPE_SENTENCE = 'I can answer questions about your health insurance policy: what it covers, limits, waiting periods, claims and what is in your documents. I cannot help with anything else here.';

const NON_ASCII_LETTER = /[^\u0000-\u007f]/;
// Hinglish (Hindi in Latin letters) is plain ASCII, so a topic word like "room rent" can match while the sentence is not understood.
// Only words that are not English, so an English question never pays for a router call.
const HINGLISH_WORD = /\b(kitn[aei]|kya|kab|kaise|kaun|kahan|kyun|mera|meri|mere|hai|hain|nahi|chahiye|bimari|dena|milega|milegi|hoga|hogi)\b/i;
const PLACEHOLDER = /\{\{[^}]{0,40}\}\}|<[A-Z_]+_\d+>/g;

/** The router runs only when the free keyword path is unsure: no topic matched, the text is not plain ASCII (Hindi script, accents), or it reads as Hinglish. */
export function needsRouter({ message, factKeys, hasProcedure = false }) {
  if (hasProcedure) return false;
  const text = String(message ?? '').trim();
  if (text === '') return false;
  return factKeys.length === 0 || NON_ASCII_LETTER.test(text) || HINGLISH_WORD.test(text);
}

/**
 * Checks a validated model route and returns { canonical, sources } or null (use the keyword path unchanged).
 * canonical is plain printable text without placeholders; sources is a unique subset of ROUTER_SOURCES, at most three.
 */
export function readRoute(output) {
  if (!output || output.status !== 'extracted_unverified' || !Array.isArray(output.sources)) return null;
  const sources = [...new Set(output.sources)].filter(source => ROUTER_SOURCES.includes(source)).slice(0, 3);
  if (sources.length === 0) return null;
  const canonical = String(output.canonical_question ?? '').normalize('NFKC').replace(PLACEHOLDER, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ROUTER_QUESTION_MAX);
  return Object.freeze({ canonical, sources });
}

const HISTORY_ITEMS = 3;
const HISTORY_CHARS = 140;
/** "What did I ask earlier?": the person's own earlier questions of this thread, from the stored turns. No model. */
export function historyAnswer(turns) {
  const asked = turns.filter(turn => turn.role === 'user').slice(-HISTORY_ITEMS);
  if (asked.length === 0) return 'From this conversation: you have not asked anything earlier in this thread.';
  const lines = asked.map((turn, at) => `${at + 1}. ${String(turn.text).replace(/\s+/g, ' ').trim().slice(0, HISTORY_CHARS)}`);
  return `From this conversation: you asked earlier\n${lines.join('\n')}`;
}
