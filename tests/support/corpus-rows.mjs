// Row generator for the privacy gate golden corpus (docs/architecture/privacy-gate-golden-corpus.md).
// SYNTHETIC DATA ONLY. Every number is drawn from a seeded PRNG (mulberry32) and is never a real identifier.
// NEVER DIAL OR WRITE TO A VALUE HERE: no fictional Indian mobile range is known (ADR 0017 Q3), so phones are
// generated 10-digit values. Aadhaar-shaped values are chosen so they FAIL the Verhoeff checksum, so none can be an
// issued Aadhaar number. Emails use only example.test and example.invalid.

export const CORPUS_SEED = 0x5EC22026;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const prng = seed => mulberry32(seed);

// Verhoeff checksum, used only to prove generated Aadhaar-shaped values are invalid.
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeffValid(digits) {
  let c = 0;
  [...String(digits)].reverse().forEach((character, index) => { c = D[c][P[index % 8][Number(character)]]; });
  return c === 0;
}

const rand = prng(CORPUS_SEED);
const digit = (low = 0, high = 9) => low + Math.floor(rand() * (high - low + 1));
const digits = (count, first = null) => Array.from({ length: count }, (_, index) => (index === 0 && first ? first() : digit())).join('');
const letters = count => Array.from({ length: count }, () => String.fromCharCode(65 + Math.floor(rand() * 26))).join('');

// Values with no structure that makes a leak ambiguous: every four-digit group differs, and no group repeats a digit run.
export function aadhaar() {
  for (;;) {
    const value = digits(12, () => digit(2, 9));
    if (!verhoeffValid(value) && new Set(value.match(/.{4}/g)).size === 3 && !/^(\d)\1+$/.test(value)) return value;
  }
}
export const vid = () => digits(16, () => digit(2, 9));
export const mobile = () => digits(10, () => digit(6, 9));
export const abha = () => digits(14, () => digit(1, 9));
export const pan = (kind = 'P') => `${letters(3)}${kind}${letters(1)}${digits(4)}${letters(1)}`;
const groups = (value, size = 4) => value.match(new RegExp(`.{1,${size}}`, 'g'));
const spaced = (value, sep = ' ') => groups(value).join(sep);
const DEVANAGARI = '०१२३४५६७८९';
const toDevanagari = value => [...value].map(character => (/\d/.test(character) ? DEVANAGARI[Number(character)] : character)).join('');
const toFullwidth = value => [...value].map(character => (/\d/.test(character) ? String.fromCharCode(0xFF10 + Number(character)) : character)).join('');
const toArabicIndic = value => [...value].map(character => (/\d/.test(character) ? String.fromCharCode(0x0660 + Number(character)) : character)).join('');
export const numerals = Object.freeze({ toDevanagari, toFullwidth, toArabicIndic });

// Luhn-valid 16-digit card, generated at runtime and never printed or stored.
function luhnCard() {
  for (;;) {
    const body = `4${digits(14)}`;
    let sum = 0;
    [...body].reverse().forEach((character, index) => { let n = Number(character); if (index % 2 === 0) { n *= 2; if (n > 9) n -= 9; } sum += n; });
    const check = (10 - (sum % 10)) % 10;
    return `${body}${check}`;
  }
}

export const NAMES = Object.freeze({
  meera: 'Meera Testcase', ravi: 'Ravi Synthetic', kavya: 'Kavya Placeholder', rahul: 'Rahul Fakename', asha: 'Asha Example',
  ananya: 'अनन्या नमूना', rahulHi: 'राहुल काल्पनिक',
});
const known = (...names) => names.map(value => ({ kind: 'NAME', value }));

// The part of an OCR-mangled token that starts at its first confusable letter. If the gate redacts only the clean
// digits, this residue is what survives, so a row lists it as a secret.
const residueOf = input => {
  const token = input.split(/\s+/).find(candidate => /\d/.test(candidate) && /[A-Za-z]/.test(candidate) && !/^(?:Aadhaar|UID|PAN|Phone|Mobile|call):?$/i.test(candidate));
  return token ? token.slice(token.search(/[A-Za-z]/)) : '';
};

const rows = [];
const counters = {};
function add(category, code, variant, input, options = {}) {
  counters[code] = (counters[code] ?? 0) + 1;
  rows.push({
    id: `${code}-${String(counters[code]).padStart(3, '0')}`,
    category, variant, input,
    knownIdentifiers: options.known ?? [],
    expect: options.expect ?? 'redact',
    mustNotContain: options.secrets ?? [],
    mustContain: options.keep ?? [],
    placeholderKinds: options.kinds ?? [],
    refuseCodes: options.refuse ?? [],
    critical: options.critical ?? false,
    status: options.gap ? 'known_gap' : 'enforced',
    gapRef: options.gap ?? null,
    note: options.note ?? '',
  });
}

// ---------------------------------------------------------------------------
// AAD: Aadhaar and VID (40 rows, 4 known gaps)
// ---------------------------------------------------------------------------
{
  const row = (variant, make, options = {}) => { const value = aadhaar(); add('aadhaar', 'AAD', variant, make(value), { secrets: groups(value), ...options }); };
  row('label_aadhaar_colon', v => `Aadhaar: ${spaced(v)}`);
  row('label_aadhaar_no_dashed', v => `Aadhaar No. ${spaced(v, '-')}`);
  row('label_aadhaar_number_dotted', v => `Aadhaar number ${spaced(v, '.')}`);
  row('label_uid_compact', v => `UID ${v}`);
  row('label_adhaar_spelling', v => `Adhaar ${spaced(v)}`);
  row('label_aadhar_card', v => `Aadhar card: ${spaced(v)}`);
  row('label_uidai', v => `UIDAI: ${spaced(v)}`);
  row('label_devanagari_colon', v => `आधार: ${spaced(v)}`);
  row('label_devanagari_plain', v => `आधार ${spaced(v)}`);
  row('devanagari_digits', v => `आधार ${toDevanagari(spaced(v))}`);
  row('nbsp_separators', v => `Aadhaar ${spaced(v, ' ')}`);
  row('double_space_separators', v => `Aadhaar ${spaced(v, '  ')}`);
  row('single_tab_separator', v => `Aadhaar:\t${spaced(v)}`);
  row('zero_width_space_inside_groups', v => `Aadhaar ${groups(v).map(g => `${g.slice(0, 2)}​${g.slice(2)}`).join(' ')}`);
  row('zero_width_joiner_between_groups', v => `Aadhaar ${groups(v).join(' ‍')}`);
  row('line_break_between_groups', v => `Aadhaar ${groups(v).slice(0, 2).join(' ')}\n${groups(v)[2]}`);
  row('line_break_after_label', v => `Aadhaar number\n${spaced(v)}`);
  row('pipe_table_cell', v => `| Member | Aadhaar |\n| Self | ${spaced(v)} |`);
  row('sentence_context', v => `Please quote Aadhaar ${spaced(v)} at the counter.`);
  row('upper_case_label', v => `AADHAAR NO: ${spaced(v)}`);
  row('lower_case_label', v => `aadhaar no ${spaced(v)}`);
  row('unlabelled_spaced', v => `Reference ${spaced(v)} issued`);
  row('unlabelled_compact', v => `Reference ${v} issued`);
  row('json_number_form', v => `{"aadhaar": ${v}}`);
  row('json_string_form', v => `{"aadhaar": "${spaced(v)}"}`);
  row('virtual_id_label', v => `Virtual ID ${spaced(v)}`);
  row('label_with_dash_separator', v => `Aadhaar - ${spaced(v)}`);
  row('label_equals_separator', v => `UID = ${spaced(v)}`);
  row('mixed_separators', v => `Aadhaar ${groups(v)[0]}-${groups(v)[1]} ${groups(v)[2]}`);
  row('slash_separators', v => `Aadhaar ${spaced(v, '/')}`);
  row('midpoint_separators', v => `Aadhaar ${spaced(v, '·')}`);
  row('two_per_line_in_list', v => `Documents:\n- Aadhaar ${spaced(v)}\n- Sum insured 500000`);
  row('after_member_name_in_row', v => `1. Self | Aadhaar ${spaced(v)}`);
  { const v = vid(); add('aadhaar', 'AAD', 'vid_16_grouped_card_shaped_refused', `VID: ${spaced(v)}`, { expect: 'refuse', refuse: ['RESTRICTED_EVIDENCE'], note: 'A 4x4x4x4 grouping has a payment-card shape, so the gate refuses the whole text (fail closed).' }); }
  { const v = vid(); add('aadhaar', 'AAD', 'vid_16_compact', `Virtual ID ${v}`, { secrets: groups(v) }); }
  { const v = aadhaar(); add('aadhaar', 'AAD', 'masked_keep_last_four_is_a_leak', `Aadhaar XXXX XXXX ${v.slice(8)}`, { secrets: [], note: 'A masked Aadhaar printed by an insurer. FOR LEGAL REVIEW: whether a visible last four may be sent. The row only checks that a placeholder appears.', kinds: [] }); }
  // OCR noise inside a group: scheduled for gate v10 (WP8).
  for (const [variant, make] of [
    ['ocr_capital_o_for_zero', v => `Aadhaar ${groups(v)[0]} ${groups(v)[1]} ${groups(v)[2].replace('0', 'O')}`],
    ['ocr_capital_i_for_one', v => `Aadhaar ${groups(v)[0]} ${groups(v)[1].replace(/\d$/, 'I')} ${groups(v)[2]}`],
    ['ocr_o_in_second_group', v => `UID ${groups(v)[0]} ${groups(v)[1].replace(/\d/, 'O')} ${groups(v)[2]}`],
    ['ocr_z_for_two_label_devanagari', v => `आधार ${groups(v)[0].replace(/\d$/, 'Z')} ${groups(v)[1]} ${groups(v)[2]}`],
  ]) {
    const v = aadhaar();
    // Scheduled for gate v10 (WP8): confusable letters inside a digit group leak the other groups today.
    const input = make(v);
    add('aadhaar', 'AAD', variant, input, { secrets: [groups(v)[0].slice(0, 4), residueOf(input)], gap: 'GAP-AAD-OCR', note: 'OCR letter for a digit inside a group; scheduled for gate v10.' });
  }
}

// ---------------------------------------------------------------------------
// PAN (24 rows, 5 known gaps)
// ---------------------------------------------------------------------------
{
  const row = (variant, make, options = {}) => { const value = pan(options.kind ?? 'P'); add('pan', 'PAN', variant, make(value), { secrets: [value.slice(0, 5), value.slice(5, 9)], ...options }); };
  row('label_pan_colon', v => `PAN: ${v}`);
  row('label_pan_no', v => `PAN No. ${v}`);
  row('label_pan_card_no', v => `PAN Card No. ${v}`);
  row('bare_in_sentence', v => `The proposer ${v} filed returns.`);
  row('bare_line', v => v);
  row('lower_case', v => `PAN ${v.toLowerCase()}`);
  row('mixed_case_bare', v => `${v.slice(0, 5).toLowerCase()}${v.slice(5)}`);
  row('in_table_cell', v => `| Item | Value |\n| PAN | ${v} |`);
  row('after_label_dash', v => `PAN - ${v}`);
  row('company_kind_c', v => `PAN: ${v}`, { kind: 'C' });
  row('huf_kind_h', v => `PAN: ${v}`, { kind: 'H' });
  row('firm_kind_f', v => `Permanent Account Number ${v}`, { kind: 'F' });
  row('label_permanent_account_number', v => `Permanent Account Number: ${v}`);
  row('upper_label_upper_value', v => `PAN NUMBER ${v}`);
  row('with_trailing_period', v => `Quote PAN ${v}.`);
  row('in_brackets', v => `Tax ID (${v})`);
  row('after_colon_no_label', v => `Tax details: ${v}`);
  row('json_form', v => `{"pan": "${v}"}`);
  row('devanagari_context', v => `पैन ${v}`);
  for (const [variant, make] of [
    ['split_by_spaces_5_4_1', v => `PAN: ${v.slice(0, 5)} ${v.slice(5, 9)} ${v.slice(9)}`],
    ['split_by_spaces_bare', v => `${v.slice(0, 5)} ${v.slice(5, 9)} ${v.slice(9)}`],
    ['split_by_dashes', v => `PAN ${v.slice(0, 5)}-${v.slice(5, 9)}-${v.slice(9)}`],
  ]) { const v = pan(); add('pan', 'PAN', variant, make(v), { secrets: [v.slice(0, 5), v.slice(5, 9)], gap: 'GAP-PAN-SPLIT', note: 'PAN split by separators; scheduled for gate v10.' }); }
  for (const [variant, make] of [
    ['ocr_zero_for_o', v => `PAN: ${v.slice(0, 3)}P${v[4].replace(/[A-Z]/, '0')}${v.slice(5)}`],
    ['ocr_o_for_zero_in_digits', v => `PAN: ${v.slice(0, 5)}${v.slice(5, 9).replace('0', 'O')}${v[9]}`],
  ]) { const v = pan(); add('pan', 'PAN', variant, make(`${v.slice(0, 3)}P${v.slice(4)}`), { secrets: [v.slice(5, 9)], gap: 'GAP-PAN-OCR', note: 'OCR letter or digit swap; scheduled for gate v10.' }); }
}

// ---------------------------------------------------------------------------
// ABH: ABHA address (12 enforced) and ABHA number (12 known gaps)
// ---------------------------------------------------------------------------
{
  const handles = ['meera.synthetic', 'ravi.testcase', 'kavya.placeholder', 'rahul.fakename', 'asha.example', 'arjun.fictional'];
  const address = (variant, make, index) => { const handle = handles[index % handles.length]; add('abha', 'ABH', variant, make(handle), { secrets: [handle] }); };
  address('address_label_abdm', h => `ABHA address: ${h}@abdm`, 0);
  address('address_label_sbx', h => `ABHA address: ${h}@sbx`, 1);
  address('address_bare_abdm', h => `Linked ${h}@abdm on file`, 2);
  address('address_bare_sbx', h => `Linked ${h}@sbx on file`, 3);
  address('address_health_id_label', h => `Health ID ${h}@abdm`, 4);
  address('address_upper_label', h => `ABHA ADDRESS ${h}@abdm`, 5);
  address('address_in_table', h => `| Field | Value |\n| ABHA address | ${h}@abdm |`, 0);
  address('address_with_period', h => `Use ${h}@sbx.`, 1);
  address('address_devanagari_label', h => `आभा पता ${h}@abdm`, 2);
  address('address_json', h => `{"abhaAddress": "${h}@abdm"}`, 3);
  address('address_after_dash', h => `ABHA - ${h}@abdm`, 4);
  address('address_two_in_line', h => `ABHA ${h}@abdm and ${handles[(handles.indexOf(h) + 1) % 6]}@sbx`, 5);
  const number = (variant, make) => { const v = abha(); add('abha', 'ABH', variant, make(v), { secrets: [v.slice(0, 4), v.slice(4, 8)], gap: 'GAP-ABHA-14', note: '14-digit ABHA number is not detected by gate v9; fixed in gate v10 (WP8).' }); };
  const abhaGroups = v => `${v.slice(0, 2)}-${v.slice(2, 6)}-${v.slice(6, 10)}-${v.slice(10)}`;
  number('number_label_abha_number_dashed', v => `ABHA Number: ${abhaGroups(v)}`);
  number('number_label_abha_dashed', v => `ABHA ${abhaGroups(v)}`);
  number('number_label_health_id_dashed', v => `Health ID ${abhaGroups(v)}`);
  number('number_label_devanagari_dashed', v => `आभा ${abhaGroups(v)}`);
  number('number_label_abha_id_compact', v => `ABHA ID ${v}`);
  number('number_label_abha_compact', v => `ABHA ${v}`);
  number('number_label_health_id_compact', v => `Health ID: ${v}`);
  number('number_label_devanagari_compact', v => `आभा नंबर ${v}`);
  number('number_bare_dashed', v => `Card ${abhaGroups(v)} issued`);
  number('number_bare_compact', v => `Card ${v} issued`);
  number('number_in_table', v => `| Field | Value |\n| ABHA number | ${abhaGroups(v)} |`);
  number('number_spaced_groups', v => `ABHA Number ${abhaGroups(v).replaceAll('-', ' ')}`);
}

// ---------------------------------------------------------------------------
// PHN: phones (36 rows, 3 known gaps)
// ---------------------------------------------------------------------------
{
  const row = (variant, make, options = {}) => { const value = mobile(); add('phone', 'PHN', variant, make(value), { secrets: [value.slice(0, 5), value.slice(5)], ...options }); };
  const half = v => `${v.slice(0, 5)} ${v.slice(5)}`;
  row('plus91_spaced', v => `Call +91 ${half(v)}`);
  row('plus91_dashed', v => `Call +91-${v}`);
  row('prefix_91_compact', v => `Call 91${v}`);
  row('prefix_zero_compact', v => `Call 0${v}`);
  row('plain_ten_digits', v => `Call ${v} today`);
  row('plain_spaced_5_5', v => `Call ${half(v)} today`);
  row('dashed_5_5', v => `Phone ${v.slice(0, 5)}-${v.slice(5)}`);
  row('dotted', v => `Phone ${v.slice(0, 5)}.${v.slice(5)}`);
  row('pairs', v => `Phone ${v.match(/../g).join(' ')}`);
  row('three_three_four', v => `Phone ${v.slice(0, 3)} ${v.slice(3, 6)} ${v.slice(6)}`);
  row('bracketed_plus91', v => `Phone (+91) ${half(v)}`);
  row('devanagari_digits', v => `फ़ोन ${toDevanagari(half(v))}`);
  row('label_mobile', v => `Mobile: ${v}`);
  row('label_mob_no', v => `Mob No. ${half(v)}`);
  row('label_cell', v => `Cell ${v}`);
  row('label_contact', v => `Contact number ${v}`);
  row('label_whatsapp', v => `WhatsApp: ${half(v)}`);
  row('label_telephone', v => `Telephone ${v}`);
  row('label_devanagari_mobile', v => `मोबाइल: ${half(v)}`);
  row('label_devanagari_phone', v => `फ़ोन ${v}`);
  row('label_devanagari_phone_alt', v => `फोन: ${half(v)}`);
  row('in_member_table', v => `| Member | Mobile |\n| Self | ${half(v)} |`);
  row('in_sentence', v => `The proposer can be reached on ${v} after 5 pm.`);
  row('two_lines', v => `Phone\n${half(v)}`);
  row('upper_label', v => `MOBILE NO: ${v}`);
  row('nbsp_group', v => `Phone ${v.slice(0, 5)} ${v.slice(5)}`);
  row('zero_width_inside', v => `Phone ${v.slice(0, 5)}​${v.slice(5)}`);
  row('json_number', v => `{"phone": ${v}}`);
  row('json_string', v => `{"mobile": "+91 ${half(v)}"}`);
  row('after_comma_in_sentence', v => `Reach the proposer, ${v}, after noon.`);
  row('arabic_indic_digits', v => `Phone ${toArabicIndic(v)}`);
  {
    const v = `0${digits(2, () => digit(1, 9))}${digits(8, () => digit(2, 9))}`;
    add('phone', 'PHN', 'std_landline_bracketed', `Office (0${v.slice(1, 3)}) ${v.slice(3, 7)} ${v.slice(7)}`, { secrets: [v.slice(3, 7)] });
  }
  {
    const v = `2${digits(7)}`;
    add('phone', 'PHN', 'std_landline_dashed', `Home 080-${v.slice(0, 4)}${v.slice(4)}`, { secrets: [v.slice(0, 4), v.slice(4)] });
  }
  for (const [variant, make] of [
    ['ocr_capital_i_for_one', v => `call ${v.slice(0, 5)}-${v.slice(5, 7)}I${v.slice(8)}`],
    ['ocr_lower_l_for_one', v => `Phone ${v.slice(0, 5)} ${v.slice(5, 6)}l${v.slice(7)}`],
    ['ocr_capital_i_start_of_second_group', v => `Mobile: ${v.slice(0, 5)} I${v.slice(6)}`],
  ]) { const v = mobile(); const input = make(v); add('phone', 'PHN', variant, input, { secrets: [v.slice(0, 5), residueOf(input)], gap: 'GAP-PHN-OCR', note: 'Confusable letter for a digit defeats the phone rule; scheduled for gate v10.' }); }
}

// ---------------------------------------------------------------------------
// EML: email and UPI (12 rows)
// ---------------------------------------------------------------------------
{
  const emails = ['meera.synthetic@example.test', 'ravi.testcase@example.invalid', 'kavya.placeholder@example.test', 'rahul.fakename@example.invalid'];
  const row = (variant, make, index = 0) => { const e = emails[index % emails.length]; add('email', 'EML', variant, make(e), { secrets: [e.split('@')[0]] }); };
  row('plain', e => `Write to ${e}`, 0);
  row('labelled', e => `Email: ${e}`, 1);
  row('label_email_id', e => `E-mail ID ${e}`, 2);
  row('devanagari_label', e => `ईमेल ${e}`, 3);
  row('in_table', e => `| Field | Value |\n| Email | ${e} |`, 0);
  row('in_sentence', e => `Send the form to ${e}, then wait.`, 1);
  row('json', e => `{"email": "${e}"}`, 2);
  row('upper_case', e => `EMAIL: ${e.toUpperCase()}`, 3);
  row('obfuscated_at_dot', e => `Email ${e.split('@')[0]} (at) example (dot) test`, 0);
  row('obfuscated_brackets', e => `Email ${e.split('@')[0]} [at] example [dot] test`, 1);
  add('email', 'EML', 'upi_okaxis', 'Pay meera.synthetic@okaxis today', { secrets: ['meera.synthetic'] });
  add('email', 'EML', 'upi_labelled', 'UPI ID: ravi.testcase@okhdfcbank', { secrets: ['ravi.testcase'] });
}

// ---------------------------------------------------------------------------
// NML: Latin names, labelled (20 rows)
// ---------------------------------------------------------------------------
{
  const row = (variant, make, who, options = {}) => add('name_latin', 'NML', variant, make(who), { secrets: who.split(' '), ...options });
  row('insured_name_label', n => `Insured name: ${n}`, NAMES.ravi);
  row('proposer_label', n => `Proposer: ${n}`, NAMES.meera);
  row('nominee_label', n => `Nominee: ${n}`, NAMES.kavya);
  row('name_of_the_insured', n => `Name of the insured: ${n}`, NAMES.rahul);
  row('patient_name_label', n => `Patient name: ${n}`, NAMES.asha);
  row('policyholder_dash', n => `Policyholder name - ${n}`, NAMES.ravi);
  row('honorific_mr', n => `Treatment was given to Mr. ${n}.`, NAMES.rahul);
  row('honorific_mrs', n => `Attended by Mrs. ${n} today.`, NAMES.kavya);
  row('honorific_ms', n => `Ms ${n} signed the form.`, NAMES.meera);
  row('honorific_dr', n => `Dr. ${n} is the attending doctor.`, NAMES.asha);
  row('son_of', n => `Proposer S/O ${n}`, NAMES.ravi);
  row('wife_of', n => `Member W/O ${n}`, NAMES.rahul);
  row('daughter_of', n => `Member D/O ${n}`, NAMES.meera);
  row('upper_case_label_and_name', n => `INSURED NAME: ${n.toUpperCase()}`, NAMES.ravi);
  row('lower_case_label', n => `insured name: ${n}`, NAMES.kavya);
  row('name_label_bare', n => `Name: ${n}`, NAMES.asha);
  row('name_list_and', n => `Members: ${n}, ${NAMES.meera} and ${NAMES.rahul}`, NAMES.ravi, { secrets: ['Ravi', 'Synthetic', 'Meera', 'Testcase', 'Fakename'] });
  row('name_list_pipe_two', n => `Insured persons: ${n} | ${NAMES.kavya}`, NAMES.asha, { secrets: ['Asha', 'Example', 'Kavya', 'Placeholder'] });
  row('known_name_unlabelled', n => `The claim for ${n} was filed on time.`, NAMES.ravi, { known: known(NAMES.ravi) });
  row('known_name_reversed', n => `${n.split(' ').reverse().join(' ')} attended the clinic.`, NAMES.meera, { known: known(NAMES.meera) });
}

// ---------------------------------------------------------------------------
// NDV: Devanagari names (24 rows, 4 known gaps)
// ---------------------------------------------------------------------------
{
  const row = (variant, make, who, options = {}) => add('name_devanagari', 'NDV', variant, make(who), { secrets: who.split(' '), ...options });
  const A = NAMES.ananya;
  const R = NAMES.rahulHi;
  row('honorific_shri', n => `श्री ${n} ने फॉर्म भरा।`, R);
  row('honorific_shrimati', n => `श्रीमती ${n} बीमित हैं।`, A);
  row('honorific_sushri', n => `सुश्री ${n} को कवर मिला।`, A);
  row('honorific_kumari', n => `कुमारी ${n} का नाम दर्ज है।`, A);
  row('honorific_doctor', n => `डॉ. ${n} ने इलाज किया।`, R);
  row('label_naam', n => `नाम: ${n}`, A);
  row('label_naam_space', n => `नाम ${n}`, R);
  row('label_insured_name', n => `बीमित का नाम: ${n}`, A);
  row('label_proposer', n => `प्रस्तावक: ${n}`, R);
  row('label_nominee', n => `नामित: ${n}`, A);
  row('label_patient', n => `रोगी का नाम: ${n}`, R);
  row('honorific_in_table', n => `| नाम | संबंध |\n| श्री ${n} | स्वयं |`, R);
  row('known_unlabelled_a', n => `${n} को कवर मिला।`, A, { known: known(A) });
  row('known_unlabelled_r', n => `आज ${n} अस्पताल गए।`, R, { known: known(R) });
  row('known_mid_sentence', n => `दावा ${n} के नाम पर दर्ज है।`, A, { known: known(A) });
  row('known_reversed', n => `${n.split(' ').reverse().join(' ')} बीमित हैं।`, R, { known: known(R) });
  row('known_with_label', n => `सदस्य: ${n}`, A, { known: known(A) });
  row('known_with_honorific_and_two_names', n => `श्रीमती ${n} और श्री ${NAMES.rahulHi}`, A, { secrets: ['अनन्या', 'नमूना', 'राहुल', 'काल्पनिक'] });
  row('honorific_after_comma', n => `बीमित, श्रीमती ${n}, मुंबई`, A);
  row('label_member_naam', n => `सदस्य का नाम: ${n}`, R);
  for (const [variant, make, who] of [
    ['bare_unknown_in_sentence', n => `आज ${n} अस्पताल गईं।`, A],
    ['bare_unknown_start_of_line', n => `${n} ने दावा किया।`, A],
    ['bare_unknown_with_verb', n => `कल ${n} भर्ती हुए।`, R],
    ['bare_unknown_in_list', n => `उपस्थित: ${n} तथा परिवार`, R],
  ]) add('name_devanagari', 'NDV', variant, make(who), { secrets: who.split(' '), gap: 'GAP-NDV-BARE', note: 'An unlabelled Devanagari name the household never supplied cannot be told from prose; accepted design limit.' });
}

// ---------------------------------------------------------------------------
// NTR: known-name variants (24 rows, 14 known gaps)
// ---------------------------------------------------------------------------
{
  const k = known(NAMES.rahul, NAMES.meera, NAMES.ravi, NAMES.kavya);
  const row = (variant, input, secrets, options = {}) => add('name_variant', 'NTR', variant, input, { known: k, secrets, ...options });
  row('exact_case_lower', 'rahul fakename filed the claim.', ['rahul', 'fakename']);
  row('exact_case_upper', 'MEERA TESTCASE filed the claim.', ['MEERA', 'TESTCASE']);
  row('reversed_order', 'Fakename Rahul filed the claim.', ['Fakename', 'Rahul']);
  row('reversed_with_comma', 'Testcase, Meera was admitted.', ['Testcase', 'Meera']);
  row('extra_spaces', 'Ravi    Synthetic was admitted.', ['Ravi', 'Synthetic']);
  row('extra_dot_between', 'Kavya. Placeholder was admitted.', ['Kavya', 'Placeholder']);
  row('first_name_only', 'Rahul was admitted on Monday.', ['Rahul']);
  row('surname_only', 'Mr Synthetic was admitted on Monday.', ['Synthetic']);
  row('in_possessive', "Meera Testcase's claim was approved.", ['Meera', 'Testcase']);
  row('after_label_known', 'Member: ravi synthetic', ['ravi', 'synthetic']);
  for (const [variant, input, secrets] of [
    ['spelling_variant_surname', 'Rahul Fakenam filed the claim.', ['Fakenam']],
    ['spelling_variant_first_name', 'Mira Testcase filed the claim.', ['Mira']],
    ['spelling_variant_double_letter', 'Ravvi Synthetic filed the claim.', ['Ravvi']],
    ['spelling_variant_vowel', 'Kavia Placeholder filed the claim.', ['Kavia']],
  ]) row(variant, input, secrets, { gap: 'GAP-NTR-SPELL', note: 'Spelling variant of a known name is not matched; no fuzzy matching in the gate.' });
  for (const [variant, input, secrets] of [
    ['initial_and_surname', 'R. Fakename filed the claim.', ['Fakename']],
    ['initial_and_surname_no_dot', 'M Testcase filed the claim.', ['Testcase']],
    ['initial_and_surname_reversed', 'Synthetic R. was admitted.', ['Synthetic']],
    ['initials_with_surname_upper', 'K. PLACEHOLDER was admitted.', ['PLACEHOLDER']],
  ]) row(variant, input, secrets, { gap: 'GAP-NTR-INITIAL', note: 'Initial plus surname is not matched against known names.' });
  for (const [variant, input, secrets] of [
    ['latin_name_in_devanagari_rahul', 'राहुल फेकनेम ने दावा किया।', ['राहुल']],
    ['latin_name_in_devanagari_meera', 'मीरा टेस्टकेस भर्ती हुईं।', ['मीरा']],
    ['latin_name_in_devanagari_ravi', 'रवि सिंथेटिक भर्ती हुए।', ['रवि']],
    ['latin_name_in_devanagari_kavya', 'काव्या प्लेसहोल्डर भर्ती हुईं।', ['काव्या']],
  ]) row(variant, input, secrets, { gap: 'GAP-NTR-SCRIPT', note: 'A known Latin name printed in Devanagari is not matched.' });
  for (const [variant, input, secrets] of [
    ['hinglish_mix_latin_first', 'Rahul ji ka दावा approve hua.', ['Rahul']],
    ['hinglish_mix_devanagari_surname', 'Meera टेस्टकेस ka claim.', ['टेस्टकेस']],
  ]) row(variant, input, secrets, { gap: 'GAP-NTR-MIX', note: 'Mixed-script rendering of a known name.' });
}

// ---------------------------------------------------------------------------
// MBR: member tables (30 rows incl. tab tables, 3 known gaps)
// ---------------------------------------------------------------------------
{
  const dob = (d, m, y) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  const row = (variant, input, secrets, options = {}) => add('member_table', 'MBR', variant, input, { secrets, ...options });
  const members = [
    { name: NAMES.ravi, rel: 'Self', dob: dob(14, 5, 1978), age: 47 },
    { name: NAMES.meera, rel: 'Spouse', dob: dob(2, 9, 1981), age: 44 },
    { name: NAMES.kavya, rel: 'Daughter', dob: dob(23, 1, 2010), age: 15 },
  ];
  const names = members.flatMap(member => member.name.split(' '));
  row('pipe_table_identity_and_dob', `| Name | Relationship | DOB |\n${members.map(m => `| ${m.name} | ${m.rel} | ${m.dob} |`).join('\n')}`, names);
  row('pipe_table_with_health_column', `| Insured person | Relationship | Medical condition |\n| ${members[0].name} | Self | Synthetic hypertension stage one |`, ['Ravi', 'Synthetic hypertension']);
  row('pipe_table_with_icd_column', `| Member | ICD code | Remarks |\n| ${members[1].name} | E11.9 | Review in 6 months |`, ['Meera', 'Testcase', 'E11.9']);
  row('header_split_over_two_rows', `| Insured | Relationship |\n| Person | to Proposer |\n| ${members[0].name} | Self |`, ['Ravi', 'Synthetic']);
  row('header_carried_over_page_break', `| Name | Relationship | DOB |\n| ${members[0].name} | Self | ${members[0].dob} |\n\n--- page 2 ---\n| ${members[1].name} | Spouse | ${members[1].dob} |`, names.slice(0, 4));
  row('numbered_rows', `1. ${members[0].name} Self 47 M\n2. ${members[1].name} Spouse 44 F`, names.slice(0, 4));
  row('numbered_rows_with_dob', `1. ${members[0].name} Self ${members[0].dob}\n2. ${members[1].name} Spouse ${members[1].dob}`, names.slice(0, 4));
  row('space_aligned_with_relationship', `${members[0].name}   Self      ${members[0].dob}\n${members[1].name}   Spouse    ${members[1].dob}`, names.slice(0, 4));
  row('space_aligned_with_dates_only', `${members[2].name}     ${members[2].dob}     F`, ['Kavya', 'Placeholder']);
  row('hindi_headers', `| नाम | संबंध | जन्म तिथि |\n| ${members[0].name} | स्वयं | ${members[0].dob} |`, ['Ravi', 'Synthetic']);
  row('hindi_headers_devanagari_name', `| नाम | संबंध |\n| ${NAMES.ananya} | पत्नी |`, ['अनन्या', 'नमूना']);
  row('mixed_dob_formats', `| Name | DOB |\n| ${members[0].name} | 14 May 1978 |\n| ${members[1].name} | 2-Sep-1981 |`, names.slice(0, 4));
  row('dob_iso_format', `| Name | Date of birth |\n| ${members[0].name} | 1978-05-14 |`, ['Ravi', 'Synthetic', '1978']);
  row('child_row', `| Name | Relationship | DOB |\n| ${members[2].name} | Daughter | ${members[2].dob} |`, ['Kavya', 'Placeholder']);
  row('member_id_column', `| Member | Member ID | Relationship |\n| ${members[0].name} | MB${digits(8)} | Self |`, ['Ravi', 'Synthetic']);
  row('relationship_first_column', `| Relationship | Name |\n| Self | ${members[0].name} |`, ['Ravi', 'Synthetic']);
  row('three_members_numbered_pipe', `| No | Name | Relationship |\n${members.map((m, i) => `| ${i + 1} | ${m.name} | ${m.rel} |`).join('\n')}`, names);
  row('mother_and_father_rows', `| Name | Relationship |\n| ${NAMES.asha} | Mother |\n| ${NAMES.rahul} | Father |`, ['Asha', 'Example', 'Rahul', 'Fakename']);
  row('name_and_age_sex_columns', `| Name | Age | Sex |\n| ${members[0].name} | 47 | M |`, ['Ravi', 'Synthetic']);
  row('premium_table_with_member_names', `| Member | Premium |\n| ${members[0].name} | 12000 |\n| ${members[1].name} | 9000 |`, names.slice(0, 4), { keep: ['12000', '9000'] });
  row('names_in_brackets_relationship', `${members[0].name} (Self), ${members[1].name} (Spouse)`, names.slice(0, 4));
  row('member_row_with_age_sex_and_dob', `| Name | Relationship | Age | DOB |\n| ${members[1].name} | Spouse | 44 | ${members[1].dob} |`, ['Meera', 'Testcase']);
  row('names_dash_relationship', `${members[0].name} - Self; ${members[1].name} - Spouse`, names.slice(0, 4));
  row('dob_token_then_name', `${members[0].dob} ${members[0].name} Self`, ['Ravi', 'Synthetic', '1978']);
  row('table_after_policy_wording', `Waiting period of 24 months applies.\n| Name | Relationship |\n| ${members[0].name} | Self |`, ['Ravi', 'Synthetic'], { keep: ['Waiting period of 24 months'] });
  // Tab-separated tables are refused: collapsing tabs loses the cell boundaries a header needs.
  add('member_table', 'MBR', 'tab_table_two_rows', `Name\tRelationship\n${members[0].name}\tSelf`, { expect: 'refuse', refuse: ['RESTRICTED_EVIDENCE'] });
  add('member_table', 'MBR', 'tab_table_three_rows', `Name\tDOB\n${members[0].name}\t${members[0].dob}\n${members[1].name}\t${members[1].dob}`, { expect: 'refuse', refuse: ['RESTRICTED_EVIDENCE'] });
  for (const [variant, input, secrets] of [
    ['space_aligned_no_relationship_or_date', `${members[0].name}      47     M`, ['Ravi', 'Synthetic']],
    ['space_aligned_name_and_amount_columns', `${members[1].name}      4400     F`, ['Meera', 'Testcase']],
    ['space_aligned_name_then_code', `${members[2].name}     A1     F`, ['Kavya', 'Placeholder']],
  ]) add('member_table', 'MBR', variant, input, { secrets, gap: 'GAP-MBR-ALIGN', note: 'A space-aligned row with no relationship word or date gives the gate no signal.' });
}

// ---------------------------------------------------------------------------
// DOA: date of birth and address (20 rows)
// ---------------------------------------------------------------------------
{
  const row = (variant, input, secrets, options = {}) => add('dob_address', 'DOA', variant, input, { secrets, ...options });
  row('dob_label', 'DOB: 14/05/1978', ['14/05/1978', '1978']);
  row('dob_label_dotted', 'D.O.B. 02.09.1981', ['02.09.1981', '1981']);
  row('dob_label_long', 'Date of birth: 23 January 2010', ['2010', 'January']);
  row('dob_label_devanagari', 'जन्म तिथि: 14/05/1978', ['14/05/1978', '1978']);
  row('dob_month_name_first', 'Born on May 14, 1978', ['1978', 'May 14']);
  row('dob_dashed', 'DOB 14-05-1978', ['14-05-1978', '1978']);
  row('dob_known_unlabelled', 'The member was born on 14 May 1978 in the city.', ['1978'], { known: [{ kind: 'DOB', value: '1978-05-14' }] });
  row('dob_known_numeric', 'Date 14/05/1978 appears on the card.', ['1978'], { known: [{ kind: 'DOB', value: '1978-05-14' }] });
  row('address_label_with_pin', 'Address: Flat 12, Synthetic Nagar, Testville 560001', ['Flat 12', 'Synthetic Nagar', '560001']);
  row('address_label_residential', 'Residential address: House 4, Fake Colony, Exampleton 400099', ['House 4', 'Fake Colony', '400099']);
  row('address_label_permanent', 'Permanent address - Plot 7, Block C, Placeholder Vihar, 110099', ['Plot 7', 'Placeholder Vihar', '110099']);
  row('address_label_hindi', 'पता: मकान 12, नमूना नगर, परीक्षणपुर 560001', ['नमूना नगर', '560001']);
  row('address_multi_line_tail', 'Address: Flat 9\nSynthetic Apartments, Fake Road\nTestville Karnataka 560002', ['Flat 9', 'Synthetic Apartments', '560002']);
  row('address_unlabelled_pin_tail', 'The house is at Door 5, Sample Street, Testville 560003 near the park.', ['Door 5', '560003']);
  row('address_c_o_form', 'C/O Ravi Synthetic, Plot 3, Exampleton 400001', ['Plot 3', '400001', 'Synthetic']);
  row('address_with_landmark', 'Address: Flat 3, near Fake Temple, Testville 560004', ['Flat 3', '560004']);
  row('address_village_form', 'Address: Village Placeholderpur, Post Fake, District Example 560005', ['Placeholderpur', '560005']);
  row('address_then_phone_masked', 'Address: Flat 1, Fake Lane, Testville 560006\nMobile: XXXXX 43210', ['Flat 1', '560006']);
  row('address_sector_form', 'Address: Sector 9, Synthetic City 560007', ['Sector 9', '560007']);
  row('address_current_label', 'Current address: Flat 8, Sample Heights, Exampleton 400008', ['Flat 8', '400008']);
}

// ---------------------------------------------------------------------------
// OCR: noise across identifier kinds (30 rows, 4 known gaps)
// ---------------------------------------------------------------------------
{
  const aad = () => aadhaar();
  const row = (variant, make, secretsOf, options = {}) => { const v = aad(); add('ocr_noise', 'OCR', variant, make(v), { secrets: secretsOf(v), ...options }); };
  const secrets = v => groups(v).slice(0, 2);
  row('fullwidth_digits', v => `Aadhaar ${toFullwidth(spaced(v))}`, secrets);
  row('combining_mark_after_digit', v => `Aadhaar ${groups(v).map(g => `${g[0]}́${g.slice(1)}`).join(' ')}`, secrets);
  row('zero_width_non_joiner', v => `Aadhaar ${groups(v).join(' ‌')}`, secrets);
  row('zero_width_joiner', v => `UID ${groups(v).map(g => `${g.slice(0, 2)}‍${g.slice(2)}`).join(' ')}`, secrets);
  row('soft_hyphen_inside_group', v => `Aadhaar ${groups(v).map(g => `${g.slice(0, 2)}­${g.slice(2)}`).join(' ')}`, secrets);
  row('rtl_mark_between_groups', v => `Aadhaar ${groups(v).join(' ‏')}`, secrets);
  row('ltr_mark_between_groups', v => `Aadhaar ${groups(v).join(' ‎')}`, secrets);
  row('word_joiner_inside', v => `Aadhaar ${groups(v).map(g => `${g.slice(0, 2)}⁠${g.slice(2)}`).join(' ')}`, secrets);
  row('bom_inside', v => `Aadhaar ${groups(v).map(g => `${g.slice(0, 2)}﻿${g.slice(2)}`).join(' ')}`, secrets);
  row('hyphenation_across_line', v => `Aadhaar ${groups(v)[0]} ${groups(v)[1]}-\n${groups(v)[2]}`, secrets);
  row('figure_space_separators', v => `Aadhaar ${spaced(v, ' ')}`, secrets);
  row('narrow_nbsp_separators', v => `Aadhaar ${spaced(v, ' ')}`, secrets);
  row('unicode_hyphen_separators', v => `Aadhaar ${spaced(v, '‐')}`, secrets);
  row('en_dash_separators', v => `Aadhaar ${spaced(v, '–')}`, secrets);
  row('arabic_indic_digits', v => `Aadhaar ${toArabicIndic(spaced(v))}`, secrets);
  row('fullwidth_label_digits_compact', v => `UID ${toFullwidth(v)}`, secrets);
  row('mixed_ascii_and_devanagari_digits', v => `आधार ${groups(v)[0]} ${toDevanagari(groups(v)[1])} ${groups(v)[2]}`, secrets);
  row('leading_garbage_chars', v => `~~ Aadhaar ${spaced(v)}`, secrets);
  row('ligature_fi_in_label', v => `Aadhaar ${spaced(v)} (ﬁle copy)`, secrets);
  { const m = mobile(); add('ocr_noise', 'OCR', 'phone_fullwidth', `Phone ${toFullwidth(`${m.slice(0, 5)} ${m.slice(5)}`)}`, { secrets: [m.slice(0, 5), m.slice(5)] }); }
  { const m = mobile(); add('ocr_noise', 'OCR', 'phone_zero_width_inside', `Phone ${m.slice(0, 3)}​${m.slice(3, 6)}​${m.slice(6)}`, { secrets: [m.slice(0, 5), m.slice(5)] }); }
  { const m = mobile(); add('ocr_noise', 'OCR', 'phone_soft_hyphen', `Phone ${m.slice(0, 5)}­${m.slice(5)}`, { secrets: [m.slice(0, 5), m.slice(5)] }); }
  { const m = mobile(); add('ocr_noise', 'OCR', 'phone_hyphenation_across_line', `Phone ${m.slice(0, 5)}-\n${m.slice(5)}`, { secrets: [m.slice(0, 5), m.slice(5)] }); }
  { const p = pan(); add('ocr_noise', 'OCR', 'pan_zero_width', `PAN ${p.slice(0, 5)}​${p.slice(5)}`, { secrets: [p.slice(0, 5), p.slice(5, 9)] }); }
  { const p = pan(); add('ocr_noise', 'OCR', 'pan_fullwidth_digits', `PAN ${p.slice(0, 5)}${toFullwidth(p.slice(5, 9))}${p[9]}`, { secrets: [p.slice(0, 5), p.slice(5, 9)] }); }
  // Duplicated characters make a number that is not a phone: it must not be redacted as one, and must stay readable.
  add('ocr_noise', 'OCR', 'duplicated_digits_redacted_fail_closed', 'Phone 98765 543210 appears twice', { secrets: ['98765', '543210'], note: 'A run with a duplicated digit is not a valid phone, but the gate redacts it anyway (fail closed).' });
  for (const [variant, make] of [
    ['confusable_mix_aadhaar_o_i_s', v => `Aadhaar ${groups(v)[0]} ${groups(v)[1].replace(/\d/, 'S')} ${groups(v)[2].replace(/\d$/, 'I')}`],
    ['confusable_mix_uid_b_for_eight', v => `UID ${groups(v)[0].replace(/\d$/, 'B')} ${groups(v)[1]} ${groups(v)[2]}`],
    ['confusable_mix_label_devanagari', v => `आधार ${groups(v)[0]} ${groups(v)[1]} ${groups(v)[2].replace(/\d$/, 'l')}`],
    ['confusable_mix_compact', v => `UID ${v.slice(0, 5)}O${v.slice(6)}`],
  ]) { const v = aad(); const input = make(v); add('ocr_noise', 'OCR', variant, input, { secrets: [residueOf(input), groups(v)[0].slice(0, 3)], gap: 'GAP-OCR-CONF', note: 'Several confusable letters in one number; scheduled for gate v10.' }); }
}

// ---------------------------------------------------------------------------
// RST: restricted evidence (12 rows, all refuse)
// ---------------------------------------------------------------------------
{
  const refuse = (variant, input) => add('restricted', 'RST', variant, input, { expect: 'refuse', refuse: ['RESTRICTED_EVIDENCE'] });
  refuse('private_key_block', '-----BEGIN PRIVATE KEY-----\nsyntheticsyntheticsynthetic');
  refuse('api_key_assignment', 'api_key=synthetic0123456789abcdef');
  refuse('bearer_token', 'Authorization: Bearer syntheticsyntheticsynthetic0123');
  refuse('otp_phrase', 'Your OTP is 482916');
  refuse('upi_pin_phrase', 'my UPI PIN is 4829');
  refuse('cvv_phrase', 'CVV 482');
  refuse('aws_access_key_shape', 'key AKIA0123456789ABCDEF');
  refuse('google_api_key_shape', `key AIza${'A1b2C3d4E5'.repeat(3)}12345`);
  refuse('password_phrase', 'The password is synthetic1234');
  refuse('card_number_labelled', `Card number ${spaced(luhnCard())}`);
  refuse('card_number_with_cvv_label', `Visa ${spaced(luhnCard())} CVV 123`);
  refuse('jwt_shape', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljc2lnbmF0dXJl');
}

// ---------------------------------------------------------------------------
// PRS: wording that must survive (40 rows)
// ---------------------------------------------------------------------------
{
  const keep = (variant, input, options = {}) => add('preserve', 'PRS', variant, input, { expect: 'preserve', keep: [input], critical: options.critical ?? false, ...options });
  keep('sum_insured', 'Sum insured: 500000', { critical: true });
  keep('sum_insured_rupees', 'Sum insured is Rs. 5,00,000 per policy year.', { critical: true });
  keep('waiting_period_months', 'A waiting period of 24 months applies to cataract.', { critical: true });
  keep('waiting_period_days', 'Initial waiting period: 30 days from the policy start date.', { critical: true });
  keep('room_rent_percent', 'Room rent is limited to 1% of the sum insured per day.', { critical: true });
  keep('co_pay_percent', 'Co-pay of 20% applies to every claim.', { critical: true });
  keep('product_uin', 'UIN: SYNTHHLIP25001V012526', { critical: true });
  keep('toll_free', 'Toll free 1800 123 4567 for customer care.', { critical: true });
  keep('in_patient', 'In-patient hospitalisation for more than 24 hours is covered.', { critical: true });
  keep('plan_name', 'Plan name: Gold', { critical: true });
  keep('ped_waiting', 'Pre-existing disease waiting period is 36 months.', { critical: true });
  keep('exclusion_codes', 'Excl01 Excl02 Excl03 Excl04 are listed under permanent exclusions.');
  keep('exclusion_code_range', 'Exclusions Excl01 to Excl18 are listed in Section 4.');
  keep('icd_chapter_in_exclusion', 'Diseases of the eye and adnexa (ICD chapter VII) are covered after the waiting period.');
  keep('age_band_table', '61 62 63 64 65');
  keep('age_band_row', 'Entry age band: 61 to 65 years loading 25%.');
  keep('policy_period', 'Policy period: 01/04/2026 to 31/03/2027');
  keep('policy_period_words', 'Policy period from 1 April 2026 to 31 March 2027.');
  keep('hindi_waiting_period', 'प्रतीक्षा अवधि 24 माह है।');
  keep('hindi_sum_insured', 'बीमा राशि 500000 रुपये है।');
  keep('hindi_exclusion', 'पहले से मौजूद बीमारियों पर 36 माह की प्रतीक्षा अवधि लागू है।');
  keep('deductible', 'A deductible of Rs. 25,000 applies per claim.');
  keep('sub_limit_cataract', 'Cataract surgery is capped at Rs. 40,000 per eye.');
  keep('cashless_network', 'Cashless treatment is available at network hospitals.');
  keep('claim_intimation', 'Intimate the insurer within 48 hours of emergency admission.');
  keep('free_look', 'Free look period of 15 days from receipt of the policy.');
  keep('grace_period', 'A grace period of 30 days is allowed for premium payment.');
  keep('renewal_bonus', 'No claim bonus of 10% of the sum insured per claim-free year.');
  keep('portability', 'Portability must be requested 45 days before renewal.');
  keep('moratorium', 'After 60 continuous months no claim is contestable except for fraud.');
  keep('day_care', 'Day care procedures listed in Annexure II are covered.');
  keep('ambulance', 'Road ambulance cover up to Rs. 2,000 per hospitalisation.');
  keep('restoration', 'Restoration of 100% of the sum insured applies once per year.');
  keep('premium_line', 'Total premium payable: Rs. 14,250 including GST.');
  keep('gst_line', 'GST at 18% is charged on the base premium.');
  keep('zone_copay', 'Zone B co-pay of 10% applies outside the zone of residence.');
  keep('table_benefit_row', '| Benefit | Limit |\n| Room rent | 1% of SI |\n| ICU | 2% of SI |');
  keep('table_waiting_row', '| Waiting period | Months |\n| Cataract | 24 |\n| Hernia | 24 |');
  keep('section_heading', 'Section 4: Permanent exclusions and waiting periods');
  keep('grievance_timeline', 'Grievances are resolved within 14 days of receipt.');
  // v9 kept these; an over-eager split-PAN rule in a first v10 draft redacted them (review P2-3).
  keep('table_number_and_letter', 'Table 1500 A shows limits', { critical: true });
  keep('total_year_and_letter', 'Total 2024 B', { critical: true });
  keep('annex_year_and_letter', 'Annex 2026 B');
  keep('upper_case_heading_number_letter', 'TOTAL 1500 B');
}

// Misses the corpus found in gate v9 beyond the gaps designed in advance. Each is a tracked known_gap (a todo test):
// the count may only fall. `null` promotes a row the gate already handles. FOR LEGAL REVIEW where a class is health data.
const TRACKED = Object.freeze({
  'aadhaar/line_break_between_groups': ['GAP-AAD-BREAK', 'Last Aadhaar group after a line break survives the labelled rule; scheduled for gate v10.'],
  'pan/bare_in_sentence': ['GAP-PAN-LABEL', 'A PAN after a name-like label word is cut by the name rule and its tail survives.'],
  'name_devanagari/label_naam_space': ['GAP-NDV-LABEL', 'Devanagari label without a colon is not recognised.'],
  'name_devanagari/label_proposer': ['GAP-NDV-LABEL', 'Devanagari proposer label is not recognised.'],
  'name_devanagari/label_nominee': ['GAP-NDV-LABEL', 'Devanagari nominee label is not recognised.'],
  'name_variant/first_name_only': ['GAP-NTR-PARTIAL', 'A first name alone is not redacted unless the full known name appears in the text.'],
  'member_table/pipe_table_with_icd_column': ['GAP-MBR-HEADER', 'A Member/ICD/Remarks table leaves the member name; the table rules need more header signal.'],
  'member_table/hindi_headers': ['GAP-MBR-HEADER', 'Hindi name header is not read as an identity column; the DOB cell is redacted but the name is not.'],
  'member_table/hindi_headers_devanagari_name': ['GAP-MBR-HEADER', 'Hindi headers with a Devanagari name leave the name.'],
  'member_table/relationship_first_column': ['GAP-MBR-HEADER', 'A Name column that follows Relationship is not read as identity.'],
  'member_table/name_and_age_sex_columns': ['GAP-MBR-HEADER', 'Name/Age/Sex headers: the header cells are redacted and the member name is not.'],
  'member_table/premium_table_with_member_names': ['GAP-MBR-HEADER', 'Member/Premium table: the Premium header is redacted and the member names are not.'],
  'ocr_noise/combining_mark_after_digit': ['GAP-OCR-MARK', 'A combining mark after a digit breaks the Aadhaar rule; scheduled for gate v10.'],
  'ocr_noise/phone_hyphenation_across_line': ['GAP-OCR-HYPHEN', 'A phone hyphenated across a line break keeps its tail; scheduled for gate v10.'],
  'abha/number_in_table': null,
  'aadhaar/line_break_between_groups': null,
  'aadhaar/ocr_capital_o_for_zero': null,
  'aadhaar/ocr_capital_i_for_one': null,
  'aadhaar/ocr_o_in_second_group': null,
  'aadhaar/ocr_z_for_two_label_devanagari': null,
  'pan/split_by_spaces_5_4_1': null,
  'pan/split_by_spaces_bare': null,
  'pan/split_by_dashes': null,
  'abha/number_label_abha_number_dashed': null,
  'abha/number_label_abha_dashed': null,
  'abha/number_label_health_id_dashed': null,
  'abha/number_label_devanagari_dashed': null,
  'abha/number_label_abha_id_compact': null,
  'abha/number_label_abha_compact': null,
  'abha/number_label_health_id_compact': null,
  'abha/number_label_devanagari_compact': null,
  'abha/number_bare_dashed': null,
  'abha/number_bare_compact': null,
  'abha/number_spaced_groups': null,
  'phone/ocr_capital_i_for_one': null,
  'phone/ocr_lower_l_for_one': null,
  'phone/ocr_capital_i_start_of_second_group': null,
  'ocr_noise/combining_mark_after_digit': null,
  'ocr_noise/phone_hyphenation_across_line': null,
  'ocr_noise/confusable_mix_aadhaar_o_i_s': null,
  'ocr_noise/confusable_mix_uid_b_for_eight': null,
  'ocr_noise/confusable_mix_label_devanagari': null,
  'ocr_noise/confusable_mix_compact': null,
  'pan/ocr_o_for_zero_in_digits': null,
});

export const CORPUS_ROWS = Object.freeze(rows.map(entry => {
  const tracked = TRACKED[`${entry.category}/${entry.variant}`];
  if (tracked === undefined) return Object.freeze(entry);
  if (tracked === null) return Object.freeze({ ...entry, status: 'enforced', gapRef: null, note: '' });
  return Object.freeze({ ...entry, status: 'known_gap', gapRef: tracked[0], note: tracked[1] });
}));
export const ROW_COUNTS = Object.freeze(Object.fromEntries(Object.entries(counters)));
