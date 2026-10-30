// Auto Middleware admin UI. Plain DOM, no framework; every value is set with textContent.
const $ = (sel) => document.querySelector(sel);
let token = sessionStorage.getItem('am-token') || '';
let meta = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
  return node;
}

function table(headers, rows) {
  if (!rows.length) return el('p', { class: 'muted' }, 'Nothing yet.');
  return el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))));
}

const badge = (text) => el('span', { class: `badge ${text}` }, text);

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new Error('Signed out: token rejected'); }
  if (!res.ok && !Array.isArray(data.errors)) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function busy(button, fn) {
  return async (...args) => {
    button.disabled = true;
    try { await fn(...args); } catch (e) { alertBox(e.message); } finally { button.disabled = false; }
  };
}
function alertBox(msg) { $('#plan-status').textContent = msg; console.warn(msg); }

// Tabs
function show(tab) {
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== tab; });
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ workflows: loadWorkflows, connectors: loadConnectors, approvals: loadApprovals, runs: loadRuns })[tab]?.();
}

function signOut() {
  token = '';
  sessionStorage.removeItem('am-token');
  $('#tabs').hidden = true;
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = true; });
  $('#login').hidden = false;
}

async function signIn() {
  try {
    meta = await call('GET', '/api/meta');
  } catch (e) {
    $('#login-error').textContent = e.message;
    return;
  }
  $('#login').hidden = true;
  $('#tabs').hidden = false;
  $('#plan-status').textContent = meta.llmConfigured ? `Model: ${meta.model}` : 'LLM_API_KEY is not set: write the JSON by hand.';
  fillConnectorTypes();
  show('workflows');
  refreshPending();
}

// Connectors
function fillConnectorTypes() {
  const sel = $('#c-type');
  sel.replaceChildren(...meta.types.map((t) => el('option', { value: t.type }, `${t.type} — ${t.description}`)));
  sel.onchange = renderConnectorFields;
  renderConnectorFields();
}

function renderConnectorFields() {
  const type = meta.types.find((t) => t.type === $('#c-type').value);
  $('#c-fields').replaceChildren(...Object.entries(type.configFields).map(([k, f]) =>
    el('label', {}, `${k}${f.required ? ' *' : ''} `, el('input', { 'data-field': k, placeholder: f.description, ...(f.required ? { required: '' } : {}) }))));
}

async function loadConnectors() {
  const list = await call('GET', '/api/connectors');
  $('#connector-list').replaceChildren(table(['Name', 'Type', 'Config', ''], list.map((c) => [
    el('strong', {}, c.name), c.type, el('pre', { class: 'mono' }, JSON.stringify(c.config, null, 1)),
    el('div', { class: 'row-actions' },
      el('button', { class: 'ghost', onclick: () => showSchema(c.name) }, 'Schema'),
      el('button', { class: 'ghost', onclick: async () => { if (confirm(`Delete connector ${c.name}?`)) { await call('DELETE', `/api/connectors/${c.name}`); loadConnectors(); } } }, 'Delete')),
  ])));
}

async function showSchema(name) {
  $('#schema-card').hidden = false;
  $('#schema-title').textContent = `Schema: ${name}`;
  $('#schema').replaceChildren(el('p', { class: 'muted' }, 'Inspecting…'));
  const r = await call('GET', `/api/connectors/${name}/schema`);
  const parts = [];
  if (r.error) parts.push(el('p', { class: 'error' }, r.error));
  if (r.schema?.note) parts.push(el('p', {}, r.schema.note));
  for (const t of r.schema?.tables ?? []) {
    parts.push(el('h3', {}, t.name), table(['Column', 'Type', 'Key', 'Null'], t.columns.map((c) => [c.name, c.type, c.key, c.nullable ? 'yes' : 'no'])));
  }
  $('#schema').replaceChildren(...parts);
}

$('#connector-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const config = {};
  document.querySelectorAll('#c-fields input').forEach((i) => { if (i.value.trim()) config[i.dataset.field] = i.value.trim(); });
  try {
    await call('POST', '/api/connectors', { name: $('#c-name').value.trim(), type: $('#c-type').value, config });
    $('#c-status').textContent = 'Saved.';
    loadConnectors();
  } catch (err) { $('#c-status').textContent = err.message; }
});

// Workflows
function renderPreview(def) {
  if (!def || typeof def !== 'object') { $('#preview').replaceChildren(); return; }
  const trig = def.trigger || {};
  const actionKind = (name) => meta.types.flatMap((t) => t.actions).find((a) => a.name === name)?.kind;
  const defaultPolicy = { read: 'auto', write: 'require_approval', delete: 'deny' };
  $('#preview').replaceChildren(
    el('p', {}, el('strong', {}, def.name || '(no name)')),
    el('p', {}, 'Trigger: ', el('code', {}, trig.type || '?'), trig.connector ? ` on ${trig.connector}` : '', ' ', el('code', {}, JSON.stringify(trig.params || {}))),
    ...(def.steps || []).map((s, i) => el('div', {},
      el('p', {}, `Step ${i + 1}: `, el('code', {}, s.action), ` via ${s.connector} `, el('code', {}, JSON.stringify(s.target || {})), ' policy ',
        badge(s.policy || defaultPolicy[actionKind(s.action)] || '?')),
      table(['Destination field', 'Value template'], Object.entries(s.mapping || {}).map(([k, v]) => [k, el('code', {}, v)])))),
  );
}

let editingId = null;
function openReview(def, errors = [], id = null) {
  editingId = id;
  $('#review').hidden = false;
  $('#definition').value = JSON.stringify(def, null, 2);
  $('#save').textContent = id ? `Update workflow #${id}` : 'Save as draft';
  renderPreview(def);
  $('#review-errors').replaceChildren(...errors.map((e) => el('li', {}, e)));
  $('#review').scrollIntoView({ behavior: 'smooth' });
}

function currentDefinition() {
  try { return JSON.parse($('#definition').value); }
  catch { $('#review-errors').replaceChildren(el('li', {}, 'JSON is not valid')); return null; }
}

$('#definition').addEventListener('input', () => { try { renderPreview(JSON.parse($('#definition').value)); } catch { /* typing */ } });

$('#plan').addEventListener('click', busy($('#plan'), async () => {
  const rule = $('#rule').value.trim();
  if (!rule) return;
  $('#plan-status').textContent = 'Asking the model…';
  const r = await call('POST', '/api/plan', { rule });
  $('#plan-status').textContent = r.ok ? `Valid workflow after ${r.attempts} attempt(s). Review it below.` : 'The proposal needs fixing. Review the errors below.';
  openReview(r.definition ?? {}, r.errors);
}));

$('#validate').addEventListener('click', busy($('#validate'), async () => {
  const def = currentDefinition();
  if (!def) return;
  const r = await call('POST', '/api/validate', { definition: def });
  $('#review-errors').replaceChildren(...(r.ok ? [el('li', { class: 'executed' }, 'Valid.')] : r.errors.map((e) => el('li', {}, e))));
}));

$('#save').addEventListener('click', busy($('#save'), async () => {
  const def = currentDefinition();
  if (!def) return;
  const r = editingId
    ? await call('PUT', `/api/workflows/${editingId}`, { definition: def })
    : await call('POST', '/api/workflows', { rule: $('#rule').value.trim(), definition: def });
  if (!r.ok) { $('#review-errors').replaceChildren(...r.errors.map((e) => el('li', {}, e))); return; }
  $('#review').hidden = true;
  loadWorkflows();
}));

async function loadWorkflows() {
  const list = await call('GET', '/api/workflows');
  $('#workflow-list').replaceChildren(table(['#', 'Name', 'Trigger', 'Status', ''], list.map((w) => [
    String(w.id), el('div', {}, el('strong', {}, w.name), w.rule ? el('div', { class: 'muted' }, w.rule) : null),
    el('code', {}, w.definition.trigger?.type === 'webhook.received' ? `POST /hooks/${w.definition.trigger.params.path}` : w.definition.trigger?.type),
    badge(w.status),
    el('div', { class: 'row-actions' },
      w.status === 'active'
        ? el('button', { class: 'ghost', onclick: async () => { await call('POST', `/api/workflows/${w.id}/pause`); loadWorkflows(); } }, 'Pause')
        : el('button', { onclick: async () => {
          const r = await call('POST', `/api/workflows/${w.id}/activate`);
          if (!r.ok) return alert(r.errors.join('\n'));
          if (r.hookSecret) prompt('Send this value in the X-Hook-Secret header. It is shown once per activation:', r.hookSecret);
          loadWorkflows();
        } }, 'Activate'),
      w.status !== 'active' ? el('button', { class: 'ghost', onclick: () => openReview(w.definition, [], w.id) }, 'Edit') : null,
      el('button', { class: 'ghost', onclick: async () => { if (confirm(`Delete workflow #${w.id}?`)) { await call('DELETE', `/api/workflows/${w.id}`); loadWorkflows(); } } }, 'Delete')),
  ])));
}

// Approvals
async function refreshPending() {
  const list = await call('GET', '/api/approvals?status=pending');
  $('#pending-count').textContent = list.length ? `(${list.length})` : '';
}

async function loadApprovals() {
  const list = await call('GET', '/api/approvals');
  $('#approval-list').replaceChildren(table(['#', 'Workflow / step', 'Action', 'Exact payload', 'Status', ''], list.map((a) => [
    String(a.id), `#${a.workflow_id} / ${a.step_id}`, el('div', {}, el('code', {}, a.action), el('div', { class: 'muted' }, `via ${a.connector}`)),
    el('pre', { class: 'mono' }, JSON.stringify(a.payload, null, 1)), badge(a.status),
    a.status === 'pending' ? el('div', { class: 'row-actions' },
      el('button', { onclick: async () => { const r = await call('POST', `/api/approvals/${a.id}/approve`); if (!r.ok) alert(r.error); loadApprovals(); refreshPending(); } }, 'Approve'),
      el('button', { class: 'danger', onclick: async () => { await call('POST', `/api/approvals/${a.id}/reject`); loadApprovals(); refreshPending(); } }, 'Reject')) : '',
  ])));
}

// Runs
async function loadRuns() {
  const list = await call('GET', '/api/runs');
  $('#run-list').replaceChildren(table(['Time (UTC)', 'Workflow / step', 'Event', 'Decision', 'Status', 'Detail'], list.map((r) => [
    r.created_at, `${r.workflow_id ?? ''} / ${r.step_id ?? ''}`, el('code', {}, r.event_key ?? ''), badge(r.decision), badge(r.status), el('pre', { class: 'mono' }, r.detail),
  ])));
}
$('#poll-now').addEventListener('click', busy($('#poll-now'), async () => { await call('POST', '/api/poll'); loadRuns(); }));

// Boot
document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
$('#logout').addEventListener('click', signOut);
$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('#token').value;
  sessionStorage.setItem('am-token', token);
  signIn();
});
if (token) signIn();
