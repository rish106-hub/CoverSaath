-- FTS5 index over policy_clauses (ADR 0008, slice B2). SQLite only: the PostgreSQL runtime has no retrieval path
-- yet (tsvector is deferred), so the catalog parity test ignores these objects.
-- External-content table maintained by triggers, so every clause delete (repository erasure or the document
-- erasure safety net) removes its index rows in the same statement.

CREATE VIRTUAL TABLE policy_clauses_fts USING fts5(
  text, title,
  content = 'policy_clauses', content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER policy_clauses_fts_insert
AFTER INSERT ON policy_clauses
BEGIN
  INSERT INTO policy_clauses_fts(rowid, text, title) VALUES (NEW.rowid, NEW.text, COALESCE(NEW.title, ''));
END;

CREATE TRIGGER policy_clauses_fts_delete
AFTER DELETE ON policy_clauses
BEGIN
  INSERT INTO policy_clauses_fts(policy_clauses_fts, rowid, text, title) VALUES ('delete', OLD.rowid, OLD.text, COALESCE(OLD.title, ''));
END;
