// Insurer contact picker for the "call your insurer" next step (arch R14, B14). Pure: no model, DB or network.
// Contacts come from public insurer PDFs (raw-docs links/insurer-contacts.csv, served by FSS), never from model text.
// A card references a contact by id; the guard resolves the id to its value (C10), so a model can never write a number.

export const CONTACT_KINDS = Object.freeze(['phone', 'email']);
export const CONTACT_PURPOSES = Object.freeze(['claims', 'service', 'grievance', 'other']);

// Indian toll-free only (1800 / 1860). Anything else is not shown as an insurer helpline.
const TOLL_FREE = /^18(?:00|60)[\s-]?\d{3}[\s-]?\d{4}$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function isValidContact(contact) {
  if (!contact || typeof contact !== 'object' || typeof contact.id !== 'string' || contact.id.length === 0) return false;
  if (contact.purpose != null && !CONTACT_PURPOSES.includes(contact.purpose)) return false;
  if (contact.kind === 'phone') return TOLL_FREE.test(String(contact.value ?? ''));
  if (contact.kind === 'email') return EMAIL.test(String(contact.value ?? ''));
  return false;
}

// For a holder: claims, then service; phones before e-mails. An untagged contact is hidden, never assumed to be a customer
// line: the raw-docs tag pass found a fax number and NRI / group-ops desks among bare numbers and role addresses.
// For the grievance path: only contacts tagged grievance. Ties go to the contact seen in more documents, then the lower id.
const RANKS = Object.freeze({
  holder: [
    (c) => c.kind === 'phone' && c.purpose === 'claims',
    (c) => c.kind === 'phone' && c.purpose === 'service',
    (c) => c.kind === 'email' && c.purpose === 'claims',
    (c) => c.kind === 'email' && c.purpose === 'service',
  ],
  grievance: [
    (c) => c.kind === 'phone' && c.purpose === 'grievance',
    (c) => c.kind === 'email' && c.purpose === 'grievance',
  ],
});

export function pickInsurerContact(contacts, { use = 'holder' } = {}) {
  const ranks = RANKS[use];
  if (!ranks || !Array.isArray(contacts)) return null;
  const valid = contacts.filter(isValidContact);
  for (const matches of ranks) {
    const hits = valid.filter(matches);
    if (hits.length > 0) {
      return hits.sort((a, b) => (Number(b.documents) || 0) - (Number(a.documents) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    }
  }
  return null;
}

// Text must never carry contact values: a phone-like run or an e-mail in card text means the model wrote one.
export function containsContactValue(text) {
  const t = String(text ?? '').normalize('NFKC');
  if (/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z0-9.-]+/i.test(t)) return true;
  if (/(?<!\d)18(?:00|60)[\s-]?\d{3}[\s-]?\d{4}(?!\d)/.test(t)) return true; // toll-free
  if (/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/.test(t)) return true; // Indian mobile
  return false;
}
