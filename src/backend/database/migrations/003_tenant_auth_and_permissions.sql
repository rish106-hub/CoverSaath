-- Knowvia v3 tenant authentication and field-level permission enforcement.
-- Session bearer tokens are never stored. Only their SHA-256 digests persist.

CREATE TABLE api_sessions (
  id TEXT PRIMARY KEY,
  adult_user_id TEXT NOT NULL REFERENCES adult_users(id),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (julianday(expires_at) > julianday(issued_at)),
  CHECK (revoked_at IS NULL OR julianday(revoked_at) >= julianday(issued_at))
) STRICT;

CREATE INDEX api_sessions_token_status_idx
ON api_sessions(token_sha256, revoked_at, expires_at);

CREATE INDEX api_sessions_adult_status_idx
ON api_sessions(adult_user_id, revoked_at, expires_at);

-- A profile-field recipient is an adult viewer inside the same household.
-- Other recipient values remain available for explicit institutional sharing.
CREATE TRIGGER consent_scopes_profile_viewer_insert
BEFORE INSERT ON consent_scopes
WHEN NEW.resource_type = 'profile_field'
  AND NEW.recipient IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM consent_grants grant_record
    JOIN household_roles viewer_role
      ON viewer_role.household_id = grant_record.household_id
     AND viewer_role.adult_user_id = NEW.recipient
     AND viewer_role.status = 'active'
    WHERE grant_record.id = NEW.consent_grant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'profile field recipient must be an active household viewer');
END;

CREATE TRIGGER consent_scopes_profile_viewer_update
BEFORE UPDATE OF consent_grant_id, resource_type, recipient ON consent_scopes
WHEN NEW.resource_type = 'profile_field'
  AND NEW.recipient IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM consent_grants grant_record
    JOIN household_roles viewer_role
      ON viewer_role.household_id = grant_record.household_id
     AND viewer_role.adult_user_id = NEW.recipient
     AND viewer_role.status = 'active'
    WHERE grant_record.id = NEW.consent_grant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'profile field recipient must be an active household viewer');
END;

CREATE INDEX consent_scopes_field_viewer_idx
ON consent_scopes(resource_type, resource_id, recipient, action, consent_grant_id);
