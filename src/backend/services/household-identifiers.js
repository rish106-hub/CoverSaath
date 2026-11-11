// The privacy gate's per-household redaction list (ADR 0030): the names, dates of birth, emails and phone numbers of one household's
// people, opened here, server-side, from their sealed columns. It is handed to the gate's loader and nowhere else: no prompt builder, log
// or response ever receives it. Bounded; a household over the bound fails closed (no model call is built without the list).

const MAX = 200;
const MAX_CHARS = 200;
const unavailable = () => Object.assign(new Error('Household identifiers could not be loaded.'), { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE', statusCode: 503 });

export function createHouseholdIdentifierLoader({ database, columnCrypto }) {
  return async function loadKnownIdentifiers(householdId) {
    try {
      if (typeof householdId !== 'string' || householdId === '') throw unavailable();
      const members = await database.many('SELECT id, display_name, date_of_birth FROM household_members WHERE household_id = ? ORDER BY created_at, id LIMIT ?', [householdId, MAX + 1]);
      const adults = await database.many(`SELECT adult.id, adult.display_name, adult.contact_email, adult.contact_phone FROM adult_users adult
        WHERE adult.id IN (SELECT adult_user_id FROM household_members WHERE household_id = ? AND adult_user_id IS NOT NULL
          UNION SELECT adult_user_id FROM household_roles WHERE household_id = ?) ORDER BY adult.created_at, adult.id LIMIT ?`, [householdId, householdId, MAX + 1]);
      if (members.length > MAX || adults.length > MAX) throw unavailable();
      const seen = new Set();
      const out = [];
      const add = (kind, value) => {
        if (typeof value !== 'string') return;
        const trimmed = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, MAX_CHARS).trim();
        if (trimmed === '') return;
        const key = `${kind}\u0000${trimmed.normalize('NFKC').toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ kind, value: trimmed });
      };
      for (const member of members) {
        add('NAME', columnCrypto.open('household_members', 'display_name', member.id, member.display_name));
        add('DOB', columnCrypto.open('household_members', 'date_of_birth', member.id, member.date_of_birth));
      }
      for (const adult of adults) {
        add('NAME', columnCrypto.open('adult_users', 'display_name', adult.id, adult.display_name));
        add('EMAIL', columnCrypto.open('adult_users', 'contact_email', adult.id, adult.contact_email));
        add('PHONE', columnCrypto.open('adult_users', 'contact_phone', adult.id, adult.contact_phone));
      }
      if (out.length > MAX) throw unavailable();
      return out;
    } catch (error) {
      throw error?.code === 'KNOWN_IDENTIFIERS_UNAVAILABLE' ? error : unavailable();
    }
  };
}
