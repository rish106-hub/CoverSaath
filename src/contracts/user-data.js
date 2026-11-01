// App user data contract (spec docs/exec-plans/active/user-data-store-spec.md, ADR 0015, migrations 025-029).
//
// Validators for everything the app stores for a person: device permissions, places (registered address, saved place, current
// location), Settings preferences, onboarding progress, per-tool scenarios and the sign-in access request. Rules for every
// validator here:
//   * the body is a plain JSON object of at most 8 KB once serialised (PAYLOAD_TOO_LARGE, 413);
//   * unknown keys are rejected (INVALID_REQUEST, 400), enums are closed, numbers are finite and bounded, text is NFC,
//     trimmed, length-capped and free of control characters, DEL, C1, line/paragraph separators and bidi overrides;
//   * a validator returns a fresh, normalised object; it never returns the caller's object.
// Consent and permission wording is not final and needs legal review. No personal data lives in this file.
//
// Scenario input fields (small bounded JSON, every field optional so a half-filled form can be saved; amounts are whole rupees):
//   tax             regime(old|new) ageBand(under60|60to80|above80) annualIncome 0..1e9 deduction80c 0..1.5e6 deduction80d 0..1e6
//                   hraExemption 0..1e8 homeLoanInterest 0..1e7 premiumsPaid 0..1e7 shareWithFamily(bool)
//   premium_rise    currentPremium 0..1e7 sumInsured 0..1e9 riseRatePct 0..100 years 1..40 ageNow 0..120 shareWithFamily(bool)
//   hospital_bill   billAmount 0..1e8 sumInsured 0..1e9 roomRentCap 0..1e6 roomRentActual 0..1e6 coPayPct 0..100 deductible 0..1e8
//                   nonPayableItems 0..1e8 daysAdmitted 0..365 networkHospital(bool)
//   inflation       who(memberId or "household") caseKind(hospitalisation|maternity|cardiac|cancer|orthopaedic|dialysis)
//                   medicalInflationPct 0..50 years 1..40 currentCost 0..1e9 coverToday 0..1e9
//   compare_weights kind(individual|family_floater|top_up|group) ageBand(0-17|18-30|31-45|46-60|61+) scenario(routine|planned_surgery|
//                   critical_illness|maternity|emergency) weights{price,coverage,network,claims,waitingPeriods,restoration: 0..100}
//   stress_levers   who(memberId or "household") scenario(major_surgery|critical_illness|accident|maternity|long_stay)
//                   levers{billMultiplierPct 50..500 roomUpgrade(bool) coPayPct 0..100 deductible 0..1e7 claimDelayDays 0..180
//                   sumInsuredPct 10..300}
//   review_state    items: up to 200 entries keyed by a short id ([A-Za-z0-9_.-]{1,64}), each {status(pending|accepted|edited|rejected),
//                   value?: text up to 200 characters}

export const MAX_USER_DATA_BYTES = 8 * 1024;

export const DEVICE_PERMISSIONS = Object.freeze(['location', 'notifications', 'contacts', 'calendar', 'microphone', 'camera']);
export const PERMISSION_STATES = Object.freeze(['granted', 'denied', 'dismissed', 'revoked']);
export const PERMISSION_SURFACES = Object.freeze(['onboarding', 'emergency', 'settings', 'family', 'other']);
export const PLACE_KINDS = Object.freeze(['registered_address', 'current_location', 'saved_place']);
export const PLACE_SLOTS = Object.freeze(['home', 'work', 'other']);
export const PLACE_SOURCES = Object.freeze(['user_typed', 'device_gps', 'document', 'digilocker']);
export const PLACE_PRECISIONS = Object.freeze(['exact', 'coarse']);
export const SCENARIO_TOOLS = Object.freeze(['tax', 'premium_rise', 'hospital_bill', 'inflation', 'compare_weights', 'stress_levers', 'review_state']);
export const LOCATION_TTL_MS = 24 * 60 * 60 * 1000;
export const INDIAN_STATES = Object.freeze([
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal',
]);

export const USER_DATA_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  REVISION_CONFLICT: 409,
  LOCATION_PERMISSION_REQUIRED: 403,
  USER_DATA_RATE_LIMITED: 429,
  HOUSEHOLD_WRITE_FORBIDDEN: 403,
  MEMBER_PROTECTED: 403,
  MEMBER_NOT_FOUND: 404,
  PLACE_NOT_FOUND: 404,
  USER_DATA_HOUSEHOLD_MISMATCH: 409,
});

// Control characters, DEL, C1, line/paragraph separators and bidi overrides/isolates are never valid in typed text.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const WORDING = /^[A-Za-z0-9_.-]{1,40}$/;

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => fail('INVALID_REQUEST', message, 400);

export function assertObject(value, field = 'The body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be a JSON object.`);
  return value;
}

/** Throws 413 PAYLOAD_TOO_LARGE past 8 KB of JSON, 400 for anything that is not an object. */
export function assertBodySize(body) {
  assertObject(body);
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_USER_DATA_BYTES) fail('PAYLOAD_TOO_LARGE', 'The request is larger than 8 KB.', 413);
  return body;
}

export function assertKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field} has an unknown field.`);
}

export function cleanText(value, field, { max, required = false } = {}) {
  if (value === undefined || value === null) { if (required) invalid(`${field} is required.`); return null; }
  if (typeof value !== 'string') invalid(`${field} must be text.`);
  const trimmed = value.normalize('NFC').trim();
  if (!trimmed) { if (required) invalid(`${field} is required.`); return null; }
  if (trimmed.length > max || UNSAFE_TEXT.test(trimmed)) invalid(`${field} is invalid.`);
  return trimmed;
}

const oneOf = (value, list, field) => { if (!list.includes(value)) invalid(`${field} is not an accepted value.`); return value; };
const bool = (value, field) => { if (typeof value !== 'boolean') invalid(`${field} must be true or false.`); return value; };
const int = (value, field, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${field} must be a whole number from ${min} to ${max}.`);
  return value;
};
const num = (value, field, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${field} must be a number from ${min} to ${max}.`);
  return value;
};

// Builds a validator for a flat object of optional, typed fields. Unknown keys are rejected.
function shape(name, fields) {
  const keys = Object.keys(fields);
  return input => {
    assertObject(input, name);
    assertKnownKeys(input, keys, name);
    const out = {};
    for (const key of keys) if (input[key] !== undefined) out[key] = fields[key](input[key], `${name}.${key}`);
    return out;
  };
}
const rupees = max => (value, field) => int(value, field, 0, max);
const choice = list => (value, field) => oneOf(value, list, field);
const flag = (value, field) => bool(value, field);
const subject = (value, field) => {
  if (value === 'household') return value;
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${field} is not valid.`);
  return value;
};

// ---- Permissions -----------------------------------------------------------------------------------------------------------

export function parsePermissionName(permission) {
  if (!DEVICE_PERMISSIONS.includes(permission)) invalid('permission is not an accepted value.');
  return permission;
}

export function parsePermissionBody(body) {
  assertBodySize(body);
  assertKnownKeys(body, ['state', 'surface', 'wordingVersion'], 'The body');
  const wording = body.wordingVersion === undefined || body.wordingVersion === null ? null : body.wordingVersion;
  if (wording !== null && (typeof wording !== 'string' || !WORDING.test(wording))) invalid('wordingVersion is invalid.');
  return {
    state: oneOf(body.state, PERMISSION_STATES, 'state'),
    surface: oneOf(body.surface, PERMISSION_SURFACES, 'surface'),
    wordingVersion: wording,
  };
}

// ---- Places ----------------------------------------------------------------------------------------------------------------

export function parsePlaceKind(kind) {
  if (!PLACE_KINDS.includes(kind)) invalid('kind is not an accepted value.');
  return kind;
}

const ADDRESS_KEYS = ['line1', 'line2', 'landmark', 'city', 'state', 'pincode', 'country'];
function parseAddress(input) {
  assertObject(input, 'address');
  assertKnownKeys(input, ADDRESS_KEYS, 'address');
  if (typeof input.pincode !== 'string' || !/^[1-9][0-9]{5}$/.test(input.pincode)) invalid('pincode must be 6 digits.');
  const country = input.country === undefined ? 'IN' : input.country;
  if (country !== 'IN') invalid('country must be IN.');
  const state = cleanText(input.state, 'state', { max: 60, required: true });
  if (!INDIAN_STATES.includes(state)) invalid('state is not an accepted value.');
  const out = {
    line1: cleanText(input.line1, 'line1', { max: 120, required: true }),
    city: cleanText(input.city, 'city', { max: 60, required: true }),
    state,
    pincode: input.pincode,
    country,
  };
  const line2 = cleanText(input.line2, 'line2', { max: 120 });
  const landmark = cleanText(input.landmark, 'landmark', { max: 80 });
  if (line2) out.line2 = line2;
  if (landmark) out.landmark = landmark;
  return out;
}

function parseLocation(input) {
  assertObject(input, 'location');
  assertKnownKeys(input, ['lat', 'lng', 'accuracyM'], 'location');
  return {
    lat: num(input.lat, 'lat', -90, 90),
    lng: num(input.lng, 'lng', -180, 180),
    accuracyM: input.accuracyM === undefined ? null : num(input.accuracyM, 'accuracyM', 0, 100000),
  };
}

export const roundCoordinate = value => Math.round(value * 100) / 100;

/**
 * Body of PUT /places/{kind}. Shapes:
 *   registered_address / saved_place: { address, label?, source?, slot (saved_place only) }
 *   current_location:                 { location, precision?: "coarse"|"exact", surface?: "emergency" }
 * "exact" is accepted only together with surface "emergency"; otherwise the position is rounded to 2 decimals (about 1 km)
 * and the accuracy is raised to at least 1000 m. Returns { kind, slot, label, source, precision, payload }.
 */
export function parsePlaceBody(kind, body) {
  parsePlaceKind(kind);
  assertBodySize(body);
  if (kind === 'current_location') {
    assertKnownKeys(body, ['location', 'precision', 'surface', 'source'], 'The body');
    const location = parseLocation(body.location);
    const wanted = body.precision === undefined ? 'coarse' : oneOf(body.precision, PLACE_PRECISIONS, 'precision');
    if (body.surface !== undefined) oneOf(body.surface, ['emergency', 'onboarding', 'settings', 'other'], 'surface');
    if (wanted === 'exact' && body.surface !== 'emergency') invalid('Exact location is only accepted from the Emergency flow.');
    const source = body.source === undefined ? 'device_gps' : oneOf(body.source, ['device_gps', 'user_typed'], 'source');
    const payload = wanted === 'exact'
      ? { lat: location.lat, lng: location.lng, accuracyM: location.accuracyM }
      : { lat: roundCoordinate(location.lat), lng: roundCoordinate(location.lng), accuracyM: Math.max(location.accuracyM ?? 0, 1000) };
    return { kind, slot: null, label: null, source, precision: wanted, payload };
  }
  assertKnownKeys(body, kind === 'saved_place' ? ['address', 'label', 'source', 'slot'] : ['address', 'label', 'source'], 'The body');
  const slot = kind === 'saved_place' ? oneOf(body.slot, PLACE_SLOTS, 'slot') : null;
  const allowed = kind === 'saved_place' ? ['user_typed', 'device_gps'] : ['user_typed', 'document', 'digilocker'];
  return {
    kind,
    slot,
    label: cleanText(body.label, 'label', { max: 60 }),
    source: body.source === undefined ? 'user_typed' : oneOf(body.source, allowed, 'source'),
    precision: 'exact',
    payload: parseAddress(body.address),
  };
}

// ---- Preferences and onboarding --------------------------------------------------------------------------------------------

const SOURCES = ['documents', 'email', 'whatsapp', 'digilocker', 'manual'];
const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];
const VOICE = ['en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN'];
const uniqueList = (list, field) => (value, name) => {
  if (!Array.isArray(value) || value.length > list.length) invalid(`${name} must be a short list.`);
  const seen = new Set();
  for (const item of value) { oneOf(item, list, name); seen.add(item); }
  if (seen.size !== value.length) invalid(`${name} has a repeated value.`);
  return [...value];
};
const parsePrefsObject = shape('prefs', {
  sources: uniqueList(SOURCES),
  notifications: shape('prefs.notifications', { channels: uniqueList(CHANNELS), renewalReminders: flag, claimUpdates: flag }),
  sharing: shape('prefs.sharing', { defaultScope: choice(['private', 'household', 'advisor']), allowFamilyView: flag }),
  voiceLanguage: choice(VOICE),
  reducedMotion: flag,
  theme: choice(['light', 'dark', 'system']),
});

export function parsePreferencesBody(body) {
  assertBodySize(body);
  assertKnownKeys(body, ['prefs'], 'The body');
  return { prefs: parsePrefsObject(body.prefs) };
}

const parseOnboardingState = shape('state', {
  step: (value, field) => int(value, field, 0, 50),
  way: choice(['upload', 'connect', 'talk', 'skip']),
  people: shape('state.people', { self: flag, partner: flag, children: flag, parents: flag }),
  wallet: choice(['none', 'apple', 'google', 'later']),
});

export function parseOnboardingBody(body) {
  assertBodySize(body);
  assertKnownKeys(body, ['state', 'completed'], 'The body');
  const completed = body.completed === undefined ? false : bool(body.completed, 'completed');
  return { state: parseOnboardingState(body.state), completed };
}

// ---- Scenarios -------------------------------------------------------------------------------------------------------------

const SCENARIO_VALIDATORS = Object.freeze({
  tax: shape('inputs', {
    regime: choice(['old', 'new']), ageBand: choice(['under60', '60to80', 'above80']), annualIncome: rupees(1e9),
    deduction80c: rupees(1.5e6), deduction80d: rupees(1e6), hraExemption: rupees(1e8), homeLoanInterest: rupees(1e7),
    premiumsPaid: rupees(1e7), shareWithFamily: flag,
  }),
  premium_rise: shape('inputs', {
    currentPremium: rupees(1e7), sumInsured: rupees(1e9), riseRatePct: (v, f) => num(v, f, 0, 100),
    years: (v, f) => int(v, f, 1, 40), ageNow: (v, f) => int(v, f, 0, 120), shareWithFamily: flag,
  }),
  hospital_bill: shape('inputs', {
    billAmount: rupees(1e8), sumInsured: rupees(1e9), roomRentCap: rupees(1e6), roomRentActual: rupees(1e6),
    coPayPct: (v, f) => num(v, f, 0, 100), deductible: rupees(1e8), nonPayableItems: rupees(1e8),
    daysAdmitted: (v, f) => int(v, f, 0, 365), networkHospital: flag,
  }),
  inflation: shape('inputs', {
    who: subject, caseKind: choice(['hospitalisation', 'maternity', 'cardiac', 'cancer', 'orthopaedic', 'dialysis']),
    medicalInflationPct: (v, f) => num(v, f, 0, 50), years: (v, f) => int(v, f, 1, 40), currentCost: rupees(1e9), coverToday: rupees(1e9),
  }),
  compare_weights: shape('inputs', {
    kind: choice(['individual', 'family_floater', 'top_up', 'group']),
    ageBand: choice(['0-17', '18-30', '31-45', '46-60', '61+']),
    scenario: choice(['routine', 'planned_surgery', 'critical_illness', 'maternity', 'emergency']),
    weights: shape('inputs.weights', Object.fromEntries(['price', 'coverage', 'network', 'claims', 'waitingPeriods', 'restoration'].map(key => [key, (v, f) => int(v, f, 0, 100)]))),
  }),
  stress_levers: shape('inputs', {
    who: subject, scenario: choice(['major_surgery', 'critical_illness', 'accident', 'maternity', 'long_stay']),
    levers: shape('inputs.levers', {
      billMultiplierPct: (v, f) => int(v, f, 50, 500), roomUpgrade: flag, coPayPct: (v, f) => int(v, f, 0, 100),
      deductible: rupees(1e7), claimDelayDays: (v, f) => int(v, f, 0, 180), sumInsuredPct: (v, f) => int(v, f, 10, 300),
    }),
  }),
  review_state: input => {
    assertObject(input, 'inputs');
    assertKnownKeys(input, ['items'], 'inputs');
    const items = assertObject(input.items ?? {}, 'items');
    const entries = Object.entries(items);
    if (entries.length > 200) invalid('items holds too many entries.');
    const out = Object.create(null);
    for (const [key, entry] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !KEY.test(key)) invalid('An item key is not valid.');
      assertObject(entry, 'An item');
      assertKnownKeys(entry, ['status', 'value'], 'An item');
      out[key] = { status: oneOf(entry.status, ['pending', 'accepted', 'edited', 'rejected'], 'status') };
      const value = cleanText(entry.value, 'value', { max: 200 });
      if (value !== null) out[key].value = value;
    }
    return { items: { ...out } };
  },
});

export function parseScenarioTool(tool) {
  if (!SCENARIO_TOOLS.includes(tool)) invalid('tool is not an accepted value.');
  return tool;
}

export function parseScenarioBody(tool, body) {
  parseScenarioTool(tool);
  assertBodySize(body);
  assertKnownKeys(body, ['inputs'], 'The body');
  return { inputs: SCENARIO_VALIDATORS[tool](body.inputs) };
}

// ---- Access (beta sign-up that is safe to repeat) --------------------------------------------------------------------------

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

/** Body of POST /api/v1/access: { displayName, contactEmail, contactPhone?, householdName? }. */
export function parseAccessBody(body) {
  assertBodySize(body);
  assertKnownKeys(body, ['displayName', 'contactEmail', 'contactPhone', 'householdName'], 'The body');
  const email = cleanText(body.contactEmail, 'contactEmail', { max: 254, required: true }).toLowerCase();
  if (!EMAIL.test(email)) invalid('contactEmail is not valid.');
  let phone = null;
  if (body.contactPhone !== undefined && body.contactPhone !== null && body.contactPhone !== '') {
    phone = cleanText(body.contactPhone, 'contactPhone', { max: 20 }).replace(/[\s()-]/g, '');
    if (!/^\+?[0-9]{7,15}$/.test(phone)) invalid('contactPhone is not valid.');
  }
  return {
    displayName: cleanText(body.displayName, 'displayName', { max: 80, required: true }),
    contactEmail: email,
    contactPhone: phone,
    householdName: cleanText(body.householdName, 'householdName', { max: 80 }),
  };
}
