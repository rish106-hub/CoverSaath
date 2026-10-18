import {
  DOCUMENT_KINDS, formatBytes, messageForErrorCode, selectionKey, statusLabel, validateSelection,
} from '../state/document-selection.js';

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_MS = 2 * 60 * 1000;

const kindLabel = kind => DOCUMENT_KINDS.find(([value]) => value === kind)?.[1] ?? kind;

/**
 * Household document upload panel. Filenames are only ever written as text nodes.
 * LEGAL REVIEW REQUIRED: the consent wording on this panel is draft product copy and
 * is not final privacy-notice or consent text.
 *
 * `el` is the app's element helper; `client` is the v1 client. The returned element is
 * long-lived: the host re-attaches it on every render and calls setContext().
 */
export function createDocumentUploadPanel({
  el, client, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
  makeKey = () => crypto.randomUUID(),
}) {
  const state = { caseId: '', consentGrantId: '', kind: 'policy_wording', items: [], documents: [], uploading: false };
  const touched = { caseId: false, consent: false };
  const polls = new Map(); // document id -> { startedAt, timer }
  let nextId = 1;
  let loadedCase = '';

  const live = el('div', { class:'sr-only', role:'status', 'aria-live':'polite' });
  const announce = text => { live.textContent = ''; live.textContent = text; };
  const notice = el('p', { class:'hint', 'data-role':'notice' });
  const queueMount = el('ul', { class:'upload-list', 'aria-label':'Files selected for upload' });
  const docsMount = el('ul', { class:'upload-list', 'aria-label':'Uploaded documents' });

  const caseInput = el('input', { id:'doc-case-id', name:'caseId', type:'text', autocomplete:'off', onInput:event => {
    touched.caseId = true; state.caseId = event.currentTarget.value.trim(); updateButtons();
  }, onChange:() => { void refresh(); } });
  const consentInput = el('input', { id:'doc-consent-id', name:'consentGrantId', type:'text', autocomplete:'off', onInput:event => {
    touched.consent = true; state.consentGrantId = event.currentTarget.value.trim(); updateButtons();
  } });
  const kindSelect = el('select', { id:'doc-kind', name:'documentKind', onChange:event => { state.kind = event.currentTarget.value; } },
    DOCUMENT_KINDS.map(([value, label]) => el('option', { value }, label)));
  const fileInput = el('input', {
    id:'doc-files', name:'files', type:'file', multiple:'', accept:'application/pdf,.pdf',
    onChange:event => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; },
  });
  const uploadButton = el('button', { class:'button', type:'button', onClick:() => { void uploadAll(); } }, 'Upload all');

  function canUpload() {
    return Boolean(state.caseId && state.consentGrantId) && !state.uploading
      && state.items.some(item => item.state === 'ready' || item.state === 'error');
  }
  function updateButtons() { uploadButton.disabled = !canUpload(); }

  function addFiles(fileList) {
    const results = validateSelection(Array.from(fileList ?? []), state.items.map(item => item.file));
    let added = 0;
    const problems = [];
    for (const result of results) {
      if (!result.ok) { problems.push(`${result.file.name}: ${result.errors[0].message}`); continue; }
      state.items.push({
        id: nextId++, file: result.file, key: result.key, idempotencyKey: makeKey(), state: 'ready',
        loaded: 0, total: result.file.size, error: '', document: null, flag: result.warnings[0]?.message ?? '',
      });
      added += 1;
    }
    notice.textContent = problems.join(' ');
    announce(`${added} file${added === 1 ? '' : 's'} added.${problems.length ? ` ${problems.length} not added.` : ''}`);
    renderQueue();
  }

  function removeItem(id) {
    const item = state.items.find(entry => entry.id === id);
    if (!item || item.state === 'uploading') return;
    state.items = state.items.filter(entry => entry.id !== id);
    announce(`Removed ${item.file.name}.`);
    renderQueue();
  }

  async function uploadOne(item) {
    item.state = 'uploading'; item.error = ''; item.loaded = 0;
    renderQueue();
    try {
      // The same idempotencyKey is reused when this same file is retried.
      const result = await client.uploadDocument({
        caseId: state.caseId, file: item.file, documentKind: state.kind, consentGrantId: state.consentGrantId,
        idempotencyKey: item.idempotencyKey,
        onProgress(loaded, total) { item.loaded = loaded; item.total = total; paintProgress(item); },
      });
      item.state = 'done'; item.document = result.document;
      announce(`${item.file.name}: ${statusLabel(result.document?.status ?? 'received_pending_checks')}.`);
    } catch (error) {
      item.state = 'error';
      item.error = messageForErrorCode(error?.code);
      announce(`${item.file.name}: ${item.error}`);
    }
    renderQueue();
  }

  async function uploadAll() {
    if (!canUpload()) return;
    state.uploading = true; updateButtons();
    for (const item of state.items.filter(entry => entry.state === 'ready' || entry.state === 'error')) await uploadOne(item);
    state.uploading = false;
    state.items = state.items.filter(item => item.state !== 'done');
    renderQueue();
    await refresh();
  }

  async function retryOne(id) {
    const item = state.items.find(entry => entry.id === id);
    if (!item || state.uploading || !state.caseId || !state.consentGrantId) return;
    state.uploading = true; updateButtons();
    await uploadOne(item);
    state.uploading = false;
    if (item.state === 'done') state.items = state.items.filter(entry => entry !== item);
    renderQueue();
    await refresh();
  }

  const progressRefs = new Map();
  function paintProgress(item) {
    const bar = progressRefs.get(item.id);
    if (!bar) return;
    const pct = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
    bar.setAttribute('aria-valuenow', String(pct));
    bar.firstChild.style.width = `${pct}%`;
  }

  function renderQueue() {
    progressRefs.clear();
    queueMount.replaceChildren(...state.items.map(item => {
      const pct = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
      const bar = el('div', {
        class:'upload-progress', role:'progressbar', 'aria-label':`Upload progress for ${item.file.name}`,
        'aria-valuemin':'0', 'aria-valuemax':'100', 'aria-valuenow':String(item.state === 'done' ? 100 : pct),
      }, el('span', {}));
      bar.firstChild.style.width = `${pct}%`;
      progressRefs.set(item.id, bar);
      const statusText = item.state === 'ready' ? 'Ready to upload'
        : item.state === 'uploading' ? 'Uploading...'
          : item.state === 'done' ? statusLabel(item.document?.status ?? 'received_pending_checks')
            : item.error;
      return el('li', { class:`upload-item ${item.state === 'error' ? 'upload-error' : ''}` },
        el('div', { class:'upload-meta' },
          el('strong', { class:'upload-name' }, item.file.name),
          el('small', {}, formatBytes(item.file.size)),
          el('span', { class:'upload-status' }, statusText),
          item.flag ? el('small', { class:'hint' }, item.flag) : null),
        bar,
        el('div', { class:'upload-actions' },
          item.state === 'error' ? el('button', {
            class:'button secondary', type:'button', disabled:state.uploading, onClick:() => { void retryOne(item.id); },
          }, 'Retry') : null,
          el('button', {
            class:'button secondary', type:'button', disabled:item.state === 'uploading',
            'aria-label':`Remove ${item.file.name}`, onClick:() => removeItem(item.id),
          }, 'Remove')));
    }));
    if (state.items.length === 0) queueMount.replaceChildren(el('li', { class:'hint' }, 'No files selected.'));
    updateButtons();
  }

  function renderDocuments() {
    docsMount.replaceChildren(...(state.documents.length === 0
      ? [el('li', { class:'hint' }, 'No documents uploaded for this case yet.')]
      : state.documents.map(doc => el('li', { class:'upload-item' },
        el('div', { class:'upload-meta' },
          el('strong', {}, kindLabel(doc.documentKind)),
          el('small', {}, `${formatBytes(doc.byteSize)}${doc.uploadedAt ? `, uploaded ${new Date(doc.uploadedAt).toLocaleString()}` : ''}`),
          el('span', { class:'upload-status' }, statusLabel(doc.status))),
        doc.status === 'received_pending_checks' && polls.get(doc.id)?.expired
          ? el('small', { class:'hint' }, 'Checks are taking longer than usual. Refresh later to see the result.') : null))));
  }

  function stopPolling() {
    for (const poll of polls.values()) if (poll.timer) clearTimer(poll.timer);
    polls.clear();
  }

  function schedulePoll(id) {
    const poll = polls.get(id);
    if (!poll || poll.expired) return;
    poll.timer = setTimer(async () => {
      if (now() - poll.startedAt >= POLL_MAX_MS) { poll.expired = true; poll.timer = null; renderDocuments(); return; }
      try {
        const doc = await client.getDocument(id);
        const index = state.documents.findIndex(entry => entry.id === id);
        if (index >= 0) state.documents[index] = doc;
        if (doc.status !== 'received_pending_checks') {
          polls.delete(id);
          announce(`${kindLabel(doc.documentKind)}: ${statusLabel(doc.status)}.`);
          renderDocuments();
          return;
        }
      } catch { /* transient; keep polling until the time limit */ }
      schedulePoll(id);
    }, POLL_INTERVAL_MS);
  }

  function trackPending() {
    for (const doc of state.documents) {
      if (doc.status === 'received_pending_checks' && !polls.has(doc.id)) {
        polls.set(doc.id, { startedAt: now(), timer: null, expired: false });
        schedulePoll(doc.id);
      }
    }
  }

  async function refresh() {
    if (!state.caseId) { state.documents = []; stopPolling(); renderDocuments(); return; }
    const caseId = state.caseId;
    try {
      const result = await client.listCaseDocuments(caseId);
      if (caseId !== state.caseId) return;
      state.documents = result.documents ?? [];
      loadedCase = caseId;
      trackPending();
    } catch (error) {
      notice.textContent = messageForErrorCode(error?.code);
    }
    renderDocuments();
  }

  function setContext({ caseId = '', consentGrantId = '' } = {}) {
    if (!touched.caseId && caseId && caseInput.value !== caseId) { caseInput.value = caseId; state.caseId = caseId; }
    if (!touched.consent && consentGrantId && consentInput.value !== consentGrantId) { consentInput.value = consentGrantId; state.consentGrantId = consentGrantId; }
    updateButtons();
    if (state.caseId && state.caseId !== loadedCase) { loadedCase = state.caseId; void refresh(); }
  }

  const element = el('section', { class:'panel upload-panel', 'aria-labelledby':'doc-upload-title' },
    el('p', { class:'section-label' }, 'Policy documents'),
    el('h2', { id:'doc-upload-title' }, 'Upload policy PDFs'),
    el('p', { class:'hint' }, 'PDF only, up to 15 MB each and 10 files at a time. Files are sent as received and are not read until security checks finish. Consent and privacy wording here is draft copy pending legal review.'),
    el('div', { class:'field' }, el('label', { for:'doc-case-id' }, 'Case ID'), caseInput),
    el('div', { class:'field' }, el('label', { for:'doc-consent-id' }, 'Consent grant ID'), consentInput),
    el('div', { class:'field' }, el('label', { for:'doc-kind' }, 'Document type'), kindSelect),
    el('div', { class:'field' }, el('label', { for:'doc-files' }, 'PDF files'), fileInput),
    notice,
    queueMount,
    el('div', { class:'actions' }, uploadButton),
    el('h3', {}, 'Documents on this case'),
    docsMount,
    live);

  renderQueue();
  renderDocuments();

  return Object.freeze({
    element, setContext, refresh, addFiles, uploadAll, destroy: stopPolling,
    snapshot: () => structuredClone({ ...state, items: state.items.map(({ file, ...rest }) => ({ ...rest, name: file.name, key: selectionKey(file) })) }),
  });
}
