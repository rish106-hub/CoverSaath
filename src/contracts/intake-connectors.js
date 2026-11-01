// Intake connector registry (run C, F1). Descriptors only: nothing here contacts a provider.
// Consent and notice wording is DRAFT and needs legal review (the noticeKey says so).

export const INTAKE_CHANNELS = Object.freeze(['upload', 'camera', 'email_forward', 'gmail', 'outlook', 'insurer_portal', 'hr_portal', 'digilocker', 'whatsapp', 'voice']);
export const CONNECTOR_KINDS = Object.freeze(['device', 'forward', 'inbox', 'portal', 'registry', 'messaging', 'voice']);
export const CONNECTOR_AVAILABILITY = Object.freeze(['available', 'stub', 'later']);

const entry = (id, kind, label, availability, scopesRequested, dataReturned) => Object.freeze({
  id,
  kind,
  label,
  availability,
  intakeChannel: id,
  consentPurpose: id === 'voice' ? 'voice_intake' : 'document_processing',
  scopesRequested: Object.freeze([...scopesRequested]),
  dataReturned: Object.freeze([...dataReturned]),
  noticeKey: `${id}-draft-legal-review`,
});

export const INTAKE_CONNECTORS = Object.freeze([
  entry('upload', 'device', 'Upload a file', 'available', ['document:collect'], ['document_bytes']),
  entry('camera', 'device', 'Take a photo', 'stub', ['document:collect'], ['document_bytes']),
  entry('email_forward', 'forward', 'Forward an email', 'stub', ['document:collect'], ['document_bytes']),
  entry('gmail', 'inbox', 'Gmail', 'later', ['inbox:search_insurance_mail'], ['document_candidates']),
  entry('outlook', 'inbox', 'Outlook', 'later', ['inbox:search_insurance_mail'], ['document_candidates']),
  entry('insurer_portal', 'portal', 'Insurer portal', 'later', ['portal:fetch_policy'], ['document_candidates']),
  entry('hr_portal', 'portal', 'Employer HR portal', 'later', ['portal:fetch_policy'], ['document_candidates']),
  entry('digilocker', 'registry', 'DigiLocker', 'later', ['registry:fetch_policy'], ['document_candidates']),
  entry('whatsapp', 'messaging', 'WhatsApp', 'later', ['messaging:receive_document'], ['document_bytes']),
  entry('voice', 'voice', 'Speak to us', 'stub', ['voice:record'], ['voice_prefill']),
]);

export function validateIntakeConnector(value) {
  const errors = [];
  if (value === null || typeof value !== 'object') return { valid: false, errors: ['connector must be an object'] };
  if (!INTAKE_CHANNELS.includes(value.id)) errors.push('id is not a known channel');
  if (!CONNECTOR_KINDS.includes(value.kind)) errors.push('kind is not known');
  if (typeof value.label !== 'string' || !value.label) errors.push('label is required');
  if (!CONNECTOR_AVAILABILITY.includes(value.availability)) errors.push('availability is not known');
  if (value.intakeChannel !== value.id) errors.push('intakeChannel must equal id');
  if (!['document_processing', 'voice_intake'].includes(value.consentPurpose)) errors.push('consentPurpose is not known');
  if (!Array.isArray(value.scopesRequested)) errors.push('scopesRequested must be an array');
  if (!Array.isArray(value.dataReturned)) errors.push('dataReturned must be an array');
  if (typeof value.noticeKey !== 'string' || !/-draft-legal-review$/.test(value.noticeKey)) errors.push('noticeKey must end with -draft-legal-review');
  return { valid: errors.length === 0, errors };
}
