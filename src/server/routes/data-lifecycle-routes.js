import { readBody } from '../http/request.js';
import { createDataExportService } from '../../backend/services/data-export-service.js';
import { createDataLifecycleService } from '../../backend/services/data-lifecycle-service.js';
import { READ_FIELDS } from '../policies/read-response-policy.js';

// Erasure and export routes (S3). All require a session; ownership and role are checked inside the services before any work,
// and a foreign or missing household, case or member answers the same 404. Bodies and responses carry ids and counts, never
// names or values, except the export, which returns the caller's own data (see data-export-service.js).
//
//   POST /api/v1/households/{id}/erasure                 owner; body {"confirm": "<household id>"}
//   POST /api/v1/cases/{id}/erasure                      owner, operator or the case opener; body {"confirm": "<case id>"}
//   POST /api/v1/households/{id}/members/{memberId}/erasure   owner or member role; body {"confirm": "<member id>"}
//   GET  /api/v1/households/{id}/export
//   GET  /api/v1/cases/{id}/export
//   GET  /api/v1/households/{id}/members/{memberId}/export

const HOUSEHOLD_ERASURE = /^\/api\/v1\/households\/([^/]+)\/erasure$/;
const CASE_ERASURE = /^\/api\/v1\/cases\/([^/]+)\/erasure$/;
const MEMBER_ERASURE = /^\/api\/v1\/households\/([^/]+)\/members\/([^/]+)\/erasure$/;
const HOUSEHOLD_EXPORT = /^\/api\/v1\/households\/([^/]+)\/export$/;
const CASE_EXPORT = /^\/api\/v1\/cases\/([^/]+)\/export$/;
const MEMBER_EXPORT = /^\/api\/v1\/households\/([^/]+)\/members\/([^/]+)\/export$/;

const built = new WeakMap();

function serviceFor(services, documentUploads, responses) {
  const key = documentUploads ?? services;
  if (!built.has(key)) {
    built.set(key, {
      lifecycle: createDataLifecycleService({ access: services.access, households: services.households, erasure: services.erasure, documentWorker: documentUploads ?? null }),
      exporter: createDataExportService({
        access: services.access, database: services.access.database, households: services.households, appRepository: services.householdApp, consents: services.consents,
        userDataRepository: services.userDataRepository, profileAnswers: services.profileAnswers, columnCrypto: services.columnCrypto, audit: services.audit,
        requireCaseField: responses.requireCaseField, READ_FIELDS,
      }),
    });
  }
  return built.get(key);
}

/** Resolves a response, or null when the path is not a data-lifecycle route. Errors propagate to the caller's error mapper. */
export async function handleDataLifecycleRoute({ req, url, principal, services, documentUploads, responses }) {
  const path = url.pathname;
  let match;
  if (req.method === 'POST' && (match = HOUSEHOLD_ERASURE.exec(path))) {
    const result = await serviceFor(services, documentUploads, responses).lifecycle.eraseHousehold(principal, match[1], await readBody(req));
    return { status: result.status === 'erased' ? 200 : 202, body: result };
  }
  if (req.method === 'POST' && (match = CASE_ERASURE.exec(path))) {
    const result = await serviceFor(services, documentUploads, responses).lifecycle.eraseCase(principal, match[1], await readBody(req));
    return { status: result.status === 'erased' ? 200 : 202, body: result };
  }
  if (req.method === 'POST' && (match = MEMBER_ERASURE.exec(path))) {
    const result = await serviceFor(services, documentUploads, responses).lifecycle.eraseMember(principal, match[1], match[2], await readBody(req));
    return { status: result.status === 'erased' ? 200 : 202, body: result };
  }
  if (req.method === 'GET' && (match = HOUSEHOLD_EXPORT.exec(path))) {
    return { status: 200, body: await serviceFor(services, documentUploads, responses).exporter.exportHousehold(principal, match[1]) };
  }
  if (req.method === 'GET' && (match = CASE_EXPORT.exec(path))) {
    return { status: 200, body: await serviceFor(services, documentUploads, responses).exporter.exportCase(principal, match[1]) };
  }
  if (req.method === 'GET' && (match = MEMBER_EXPORT.exec(path))) {
    return { status: 200, body: await serviceFor(services, documentUploads, responses).exporter.exportMember(principal, match[1], match[2]) };
  }
  return null;
}
