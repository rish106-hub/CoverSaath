import { DocumentIntakeError } from '../../modules/document-intake/contracts.js';

// Postgres implementation of the document-intake repository contract.
// Immutable references are enforced by triggers in migrations 002 and 004 as well as here.

const IMMUTABLE = ['id', 'householdId', 'caseId', 'uploadedByAdultId', 'consentGrantId', 'logicalDocumentId', 'version', 'contentSha256'];

function mapDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    caseId: row.case_id,
    uploadedByAdultId: row.uploaded_by_adult_id,
    consentGrantId: row.consent_grant_id,
    logicalDocumentId: row.logical_document_id,
    version: Number(row.source_version),
    documentKind: row.document_kind,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    storageKey: row.storage_path,
    malwareStatus: row.malware_status,
    encryptionStatus: row.encryption_status,
    lifecycleState: row.lifecycle_state,
    createdAt: row.uploaded_at,
    deletedAt: row.deleted_at,
  };
}

function mapConsent(grant, scopes) {
  if (!grant) return null;
  return {
    id: grant.id,
    householdId: grant.household_id,
    subjectAdultId: grant.subject_adult_id,
    purpose: grant.purpose,
    status: grant.revoked_at ? 'revoked' : 'granted',
    revokedAt: grant.revoked_at,
    expiresAt: grant.expires_at,
    scopes: scopes.map(scope => ({
      resourceType: scope.resource_type,
      resourceId: scope.resource_id,
      action: scope.action,
      dataCategory: scope.data_category,
      recipient: scope.recipient,
    })),
  };
}

export class DocumentRepository {
  constructor(database) {
    this.database = database;
  }

  async getConsent(id) {
    const grant = await this.database.one('SELECT * FROM consent_grants WHERE id = $1', [id]);
    if (!grant) return null;
    const scopes = await this.database.query('SELECT * FROM consent_scopes WHERE consent_grant_id = $1', [id]);
    return mapConsent(grant, scopes);
  }

  async findByHash(householdId, contentSha256) {
    return mapDocument(await this.database.one(`SELECT * FROM document_uploads
      WHERE household_id = $1 AND content_sha256 = $2 AND lifecycle_state <> 'deleted' LIMIT 1`, [householdId, contentSha256]));
  }

  async findVersion(householdId, logicalDocumentId, version) {
    return mapDocument(await this.database.one(`SELECT * FROM document_uploads
      WHERE household_id = $1 AND logical_document_id = $2 AND source_version = $3 LIMIT 1`, [householdId, logicalDocumentId, String(version)]));
  }

  async createDocument(document) {
    await this.database.query(`INSERT INTO document_uploads
      (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename,
       storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state,
       uploaded_at, deleted_at, logical_document_id, source_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL, $16, $17)`, [
      document.id, document.householdId, document.caseId, document.uploadedByAdultId, document.consentGrantId,
      document.documentKind, document.originalFilename, document.storageKey, document.contentSha256,
      document.mimeType, document.byteSize, document.malwareStatus, document.encryptionStatus,
      document.lifecycleState, document.createdAt, document.logicalDocumentId, String(document.version),
    ]);
    return this.getDocument(document.id);
  }

  async getDocument(id) {
    return mapDocument(await this.database.one('SELECT * FROM document_uploads WHERE id = $1', [id]));
  }

  async listForHousehold(householdId, { limit = 100 } = {}) {
    const rows = await this.database.query(`SELECT * FROM document_uploads WHERE household_id = $1
      ORDER BY uploaded_at DESC, id LIMIT $2`, [householdId, Math.min(Math.max(limit, 1), 200)]);
    return rows.map(mapDocument);
  }

  async updateDocument(id, changes) {
    const current = await this.getDocument(id);
    if (!current) return null;
    const next = { ...current, ...structuredClone(changes) };
    for (const key of IMMUTABLE) {
      if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
        throw new DocumentIntakeError('IMMUTABLE_DOCUMENT_VERSION', `Document field ${key} is immutable.`);
      }
    }
    // Activation is a separate statement so the activation guard sees the final scan state.
    await this.database.transaction(async tx => {
      await tx.query(`UPDATE document_uploads SET malware_status = $1, encryption_status = $2,
        original_filename = $3, deleted_at = $4 WHERE id = $5`,
      [next.malwareStatus, next.encryptionStatus, next.originalFilename, next.deletedAt ?? null, id]);
      if (next.lifecycleState !== current.lifecycleState) {
        await tx.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', [next.lifecycleState, id]);
      }
    });
    return this.getDocument(id);
  }
}
