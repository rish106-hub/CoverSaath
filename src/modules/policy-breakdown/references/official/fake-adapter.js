import {
  OfficialSourceContractError,
  defineOfficialSource,
  validateOfficialSourceUrl,
  validateRegistryBoundFetchRequest,
  validateSourceAttempt,
} from './contracts.js';

const MAX_REDIRECTS = 3;
const encoder = new TextEncoder();
const bytesOf = value => value instanceof Uint8Array ? value : encoder.encode(String(value ?? ''));

function failure(request, code, outcome = 'unavailable', httpStatus = null) {
  const attempt = validateSourceAttempt({
    registryEntryId: request.registryEntryId,
    attemptedAt: request.requestedAt,
    url: request.url,
    outcome,
    code,
    httpStatus,
  });
  return Object.freeze({ ok: false, requestId: request.requestId, error: Object.freeze({ code }), attempts: Object.freeze([attempt]) });
}

/**
 * A deterministic zero-network acquisition adapter. Fixtures are keyed by the exact pre-resolved URL.
 * Fixture shape: { body, mimeType, finalUrl?, redirects?, status?, freshUntil?, unavailableCode? }.
 */
export function createFakeOfficialSourceAdapter({ registry = [], responses = {} } = {}) {
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) throw new TypeError('responses must be an object keyed by URL.');
  if (!Array.isArray(registry) || registry.length === 0) throw new TypeError('registry must contain at least one operator-reviewed source.');
  const sourceById = new Map();
  for (const rawSource of registry) {
    const source = defineOfficialSource(rawSource);
    if (sourceById.has(source.id)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_REGISTRY_DUPLICATE', `duplicate registry source ${source.id}.`);
    sourceById.set(source.id, source);
  }
  return Object.freeze({
    kind: 'fake_official_source_adapter',
    networkEnabled: false,
    async fetch(rawRequest) {
      const source = sourceById.get(rawRequest?.registryEntryId);
      if (!source) throw new OfficialSourceContractError('OFFICIAL_SOURCE_REGISTRY_NOT_FOUND', 'fetchRequest registry entry is not configured.');
      const request = validateRegistryBoundFetchRequest(rawRequest, source);
      const fixture = responses[request.url];
      if (!fixture) return failure(request, 'SOURCE_UNAVAILABLE');
      if (fixture.unavailableCode) return failure(request, String(fixture.unavailableCode));

      const status = fixture.status ?? 200;
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new OfficialSourceContractError('OFFICIAL_SOURCE_FAKE_INVALID', 'fake response status is invalid.');
      if (status === 404) return failure(request, 'SOURCE_NOT_FOUND', 'not_found', 404);
      if (status < 200 || status >= 300) return failure(request, 'SOURCE_UPSTREAM_ERROR', 'unavailable', status);

      const redirects = Array.isArray(fixture.redirects) ? fixture.redirects : [];
      if (redirects.length > MAX_REDIRECTS) throw new OfficialSourceContractError('OFFICIAL_SOURCE_REDIRECT_LIMIT', `official source exceeded ${MAX_REDIRECTS} redirects.`);
      for (const [index, redirect] of redirects.entries()) validateOfficialSourceUrl(redirect, `redirects[${index}]`, request.allowedHosts);
      const finalUrl = validateOfficialSourceUrl(fixture.finalUrl ?? redirects.at(-1) ?? request.url, 'finalUrl', request.allowedHosts);

      const mimeType = String(fixture.mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
      if (!request.expectedMimeTypes.includes(mimeType)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_MIME_REJECTED', `response MIME ${mimeType || '(missing)'} is not allowed.`);
      const bytes = bytesOf(fixture.body);
      if (bytes.byteLength > request.maxBytes) throw new OfficialSourceContractError('OFFICIAL_SOURCE_OVERSIZE', `response exceeded ${request.maxBytes} bytes.`);
      if (fixture.freshUntil != null && (typeof fixture.freshUntil !== 'string' || Number.isNaN(Date.parse(fixture.freshUntil)))) {
        throw new OfficialSourceContractError('OFFICIAL_SOURCE_FAKE_INVALID', 'freshUntil must be an ISO timestamp.');
      }
      if (fixture.freshUntil && Date.parse(fixture.freshUntil) < Date.parse(request.requestedAt)) return failure(request, 'SOURCE_STALE', 'stale', status);

      const attempt = validateSourceAttempt({
        registryEntryId: request.registryEntryId,
        attemptedAt: request.requestedAt,
        url: finalUrl,
        outcome: 'fetched',
        code: null,
        httpStatus: status,
      });
      return Object.freeze({
        ok: true,
        requestId: request.requestId,
        url: finalUrl,
        mimeType,
        byteLength: bytes.byteLength,
        bytes,
        retrievedAt: request.requestedAt,
        redirects: Object.freeze([...redirects]),
        attempts: Object.freeze([attempt]),
      });
    },
  });
}
