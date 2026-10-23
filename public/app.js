(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const sessionsNode = $('#sessions');
  const timelineNode = $('#timeline');
  const state = { sessions: [], timeline: [], before: null, timelineDone: false, timelineLoading: false, expanded: new Set(), priorStatus: new Map(), view: 'console', source: null, drafts: new Map(), replyStates: new Map(), replyFetchVersion: new Map(), replyNotices: new Map(), replyPending: new Set(), cancelPending: new Set(), replyRefreshTimers: new Map(), replyRefreshUntil: new Map(), picks: new Map(), capabilityFetchVersion: new Map(), capabilityRefreshPending: new Set(), capabilityRefreshNotice: new Map(), repliesEnabled: false };
  const draftRecovery = { enabled: false, error: '', entries: new Map(), recovered: new Set(), expired: new Set(), timer: null };
  const draftStorageKey = 'dash.reply-drafts.v1', draftLifetime = 30 * 60_000;
  const authorizationPreviews = new Map();
  const authorizationText = 'Go with your recommendation(s) in your last message. You are authorized for the action(s) you asked about there, including any approval, additional review waves, or destructive steps they require. This authorization covers only what your last message asked about.';
  const sourcesState = { snapshot: null, receivedAt: null, pending: null, refreshAgain: false, loading: false, error: false, debounceTimer: 0, clockTimer: 0, pollTimer: 0 };
  const sourceCardRecords = new WeakMap();
  const byId = (o, camel, snake = camel) => o?.[camel] ?? o?.[snake];
  const esc = (value) => String(value ?? '');
  const responseKey = (s) => String(byId(s, 'key', 'key') ?? `${byId(s,'host')}|${byId(s,'harness')}|${byId(s,'sessionId','session_id')}`);
  const responsesOf = (s) => byId(s, 'lastResponses', 'responses') ?? [];
  const projectRulesState = { rows: [], storedIssue: '', version: 0, previewTimer: 0, previewRequest: 0,
    topicsEnabled: false, loaded: false, loading: false };
  const questionPicks = new Map();
  const setConnection = (text, ok) => { const el = $('#connection'); el.classList.toggle('connected', Boolean(ok)); el.innerHTML = `<i></i> ${text}`; };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const isLoopback = () => location.hostname === 'localhost' || location.hostname === '::1' || location.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(location.hostname);
  const flatText = (text) => String(text ?? '').replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  const recOf = (decision) => Number.isInteger(decision?.recIndex) ? decision.options?.[decision.recIndex] : undefined;
  // R7/A1: the live response is the session's latest stored response, and only while it answers the current turn.
  // A newer row from another turn (or a backfilled one with no turn) means the agent's last message is not this one.
  const currentTurnResponse = (responses, turnSeq) => {
    const latest = responses[0];
    return turnSeq > 0 && latest && Number(byId(latest, 'turnSeq', 'turn_seq')) === turnSeq ? latest : undefined;
  };
  // R6 owner wording with the dashboard prefix: a pick, else the verified recommendation, else the agent's call.
  const dashboardChoice = (decisions, picks) => `[dash] The owner chose (via dashboard): ${decisions.map((decision, g) => {
    const pick = decision.options[picks.get(g)], rec = recOf(decision), head = `${g + 1}. ${flatText(decision.title)} →`;
    return pick ? `${head} ${pick.key} (${JSON.stringify(flatText(pick.label))}).` : rec ? `${head} your recommendation (${JSON.stringify(flatText(rec.label))}).` : `${head} your call.`;
  }).join(' ')}`;
  const postJson = (url, body = {}) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // One-pixel grid tracks pack natural-height cards without changing DOM/tab order.
  // Read the whole batch before writing spans; observing border boxes also catches
  // expanded details, wrapped text and manually resized reply editors.
  function sizeSessionCards(cards) {
    const sizes = cards.filter(card => card.isConnected).map(card => [card, card.getBoundingClientRect().height]);
    for (const [card, height] of sizes) {
      if (!height) continue; // The Sessions panel may be hidden by the Timeline tab.
      const rows = String(Math.ceil(height + 14));
      if (card.style.getPropertyValue('--session-rows') !== rows) card.style.setProperty('--session-rows', rows);
    }
  }
  const cardSizes = new ResizeObserver(entries => sizeSessionCards(entries.map(entry => entry.target)));

  async function refreshTelegram() {
    const panel = $('#telegram-status');
    try {
      const response = await fetch('/api/telegram');
      if (!response.ok) throw new Error('Telegram status unavailable');
      const telegram = await response.json();
      projectRulesState.topicsEnabled = telegram.topicsEnabled === true;
      if (!projectRulesState.topicsEnabled) {
        projectRulesState.loaded = false;
        $('#project-rules-panel').hidden = true;
        $('#project-rules-disclosure').hidden = true;
      } else {
        loadProjectRules().catch(() => {});
      }
      panel.replaceChildren(el('strong', '', 'Telegram'), el('span', 'telegram-state', telegram.state || 'unknown'), el('span', 'telegram-mode', telegram.mode || 'input'));
      if (telegram.botUsername) panel.append(el('span', 'telegram-bot', `@${telegram.botUsername}`));
      if (isLoopback() && !telegram.paired && telegram.pairingCode && telegram.botUsername) {
        const pairing = el('span', 'telegram-pairing');
        pairing.append(document.createTextNode('Send '), el('code', '', `/pair ${telegram.pairingCode}`), document.createTextNode(` to @${telegram.botUsername}`));
        panel.append(pairing);
      }
      if (isLoopback() && telegram.paired) {
        const unpair = el('button', 'button button-secondary telegram-unpair', 'Unpair');
        unpair.type = 'button';
        unpair.addEventListener('click', async () => {
          unpair.disabled = true;
          try {
            const result = await postJson('/api/telegram/unpair');
            if (!result.ok) throw new Error('Could not unpair Telegram');
            await refreshTelegram();
          } catch {
            unpair.disabled = false;
            panel.append(el('span', 'telegram-error', 'Unpair failed'));
          }
        });
        panel.append(unpair);
      }
      panel.hidden = false;
    } catch {
      panel.replaceChildren(el('strong', '', 'Telegram'), el('span', 'telegram-state', 'unavailable'));
      panel.hidden = false;
    }
  }

  function localProjectRuleErrors() {
    const errors = new Map();
    projectRulesState.rows.forEach((rule, index) => {
      const pattern = String(rule.pattern ?? ''), project = String(rule.project ?? '');
      if (pattern.length < 1 || pattern.length > 256) errors.set(index, 'Pattern must be 1–256 characters.');
      else {
        try { new RegExp(pattern); } catch { errors.set(index, 'Invalid regular expression.'); }
      }
      if (!errors.has(index) && (project.length < 1 || project.length > 128)) errors.set(index, 'Project must be 1–128 characters.');
    });
    return errors;
  }
  function showProjectRuleErrors(errors) {
    $('#project-rule-rows').querySelectorAll('[data-rule-error]').forEach((node) => {
      const index = Number(node.dataset.ruleError), message = errors.get(index) || '';
      node.textContent = message;
      const row = node.closest('.project-rule-row');
      row?.querySelectorAll('input').forEach((input) => {
        const invalid = message.startsWith('Project ') ? input.getAttribute('aria-label')?.startsWith('Project ') : Boolean(message) && input.getAttribute('aria-label')?.startsWith('Pattern ');
        input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      });
    });
  }
  function mergeProjectRuleErrors(serverErrors = []) {
    const errors = localProjectRuleErrors();
    for (const item of serverErrors) {
      if (Number.isInteger(item?.index) && item.index >= 0 && item.index < projectRulesState.rows.length && !errors.has(item.index)) errors.set(item.index, item.error || 'Invalid rule.');
    }
    showProjectRuleErrors(errors);
  }
  function projectRuleRowsChanged() {
    projectRulesState.version++;
    $('#project-rules-status').textContent = 'Unsaved changes.';
    mergeProjectRuleErrors();
    scheduleProjectPreview();
  }
  function renderProjectRuleRows(serverErrors = []) {
    const container = $('#project-rule-rows');
    container.replaceChildren();
    projectRulesState.rows.forEach((rule, index) => {
      const row = el('div', 'project-rule-row');
      row.dataset.index = String(index);
      const fields = el('div', 'project-rule-fields');
      const patternLabel = el('label', '', `Pattern ${index + 1}`);
      const pattern = el('input', ''); pattern.type = 'text'; pattern.value = String(rule.pattern ?? ''); pattern.autocomplete = 'off'; pattern.spellcheck = false;
      pattern.setAttribute('aria-label', `Pattern ${index + 1}`);
      pattern.addEventListener('input', () => { projectRulesState.rows[index].pattern = pattern.value; projectRuleRowsChanged(); });
      patternLabel.append(pattern);
      const projectLabel = el('label', '', `Project ${index + 1}`);
      const project = el('input', ''); project.type = 'text'; project.value = String(rule.project ?? ''); project.autocomplete = 'off';
      project.setAttribute('aria-label', `Project ${index + 1}`);
      project.addEventListener('input', () => { projectRulesState.rows[index].project = project.value; projectRuleRowsChanged(); });
      projectLabel.append(project);
      fields.append(patternLabel, projectLabel);
      const actions = el('div', 'project-rule-row-actions');
      const up = el('button', 'button button-secondary', 'Move up'); up.type = 'button'; up.disabled = index === 0;
      up.setAttribute('aria-label', `Move rule ${index + 1} up`);
      up.addEventListener('click', () => moveProjectRule(index, -1));
      const down = el('button', 'button button-secondary', 'Move down'); down.type = 'button'; down.disabled = index === projectRulesState.rows.length - 1;
      down.setAttribute('aria-label', `Move rule ${index + 1} down`);
      down.addEventListener('click', () => moveProjectRule(index, 1));
      const remove = el('button', 'button button-secondary', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', `Remove rule ${index + 1}`);
      remove.addEventListener('click', () => { projectRulesState.rows.splice(index, 1); projectRuleRowsChanged(); renderProjectRuleRows(); });
      actions.append(up, down, remove);
      const error = el('span', 'project-rule-error'); error.dataset.ruleError = String(index); error.setAttribute('role', 'status');
      row.append(fields, actions, error);
      container.append(row);
    });
    $('#project-rule-add').disabled = projectRulesState.rows.length >= 32;
    mergeProjectRuleErrors(serverErrors);
  }
  function moveProjectRule(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= projectRulesState.rows.length) return;
    const [rule] = projectRulesState.rows.splice(index, 1);
    projectRulesState.rows.splice(target, 0, rule);
    projectRuleRowsChanged();
    renderProjectRuleRows();
  }
  function scheduleProjectPreview() {
    window.clearTimeout(projectRulesState.previewTimer);
    projectRulesState.previewRequest++;
    projectRulesState.previewTimer = window.setTimeout(previewProjectRules, 250);
  }
  async function previewProjectRules() {
    const requestId = ++projectRulesState.previewRequest;
    const result = $('#project-preview-result'), cwd = $('#project-test-path').value;
    try {
      const response = await postJson('/api/projects/preview', { cwd, rules: projectRulesState.rows.map((rule) => ({ pattern: rule.pattern, project: rule.project })) });
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (requestId !== projectRulesState.previewRequest) return;
      if (!response.ok) {
        const errors = Number.isInteger(payload.index) && payload.index >= 0 ? [{ index: payload.index, error: payload.error || 'Invalid rules.' }] : [];
        mergeProjectRuleErrors(errors);
        result.textContent = payload.error === 'invalid rules' ? `Rule ${Number.isInteger(payload.index) ? payload.index + 1 : ''} needs attention.` : 'Could not preview this path.';
        return;
      }
      mergeProjectRuleErrors(payload.errors || []);
      const project = payload.project ? `Project: ${payload.project}` : 'Project unknown';
      const skipped = (payload.errors || []).map((item) => `Rule ${item.index + 1}: ${item.error}`).join(' · ');
      result.textContent = skipped ? `${project} · ${skipped}` : project;
    } catch {
      if (requestId === projectRulesState.previewRequest) result.textContent = 'Could not preview this path.';
    }
  }
  async function loadProjectRules() {
    if (!projectRulesState.topicsEnabled || projectRulesState.loaded || projectRulesState.loading) return;
    projectRulesState.loading = true;
    try {
      const response = await fetch('/api/projects/rules');
      if (!response.ok) throw new Error('Project rules unavailable');
      const payload = await response.json();
      if (!projectRulesState.topicsEnabled) return;
      projectRulesState.rows = (Array.isArray(payload.rules) ? payload.rules : []).map((rule) => ({ pattern: String(rule?.pattern ?? ''), project: String(rule?.project ?? '') }));
      projectRulesState.storedIssue = (payload.errors || []).some((item) => item?.index === -1)
        ? 'Stored project rules are malformed. Defaults are shown; saving will replace the stored value.' : '';
      $('#project-rules-notice').textContent = projectRulesState.storedIssue;
      $('#project-rules-panel').hidden = false;
      $('#project-rules-disclosure').hidden = false;
      $('#project-rules-status').textContent = '';
      renderProjectRuleRows(payload.errors || []);
      projectRulesState.loaded = true;
    } finally {
      projectRulesState.loading = false;
    }
  }
  async function saveProjectRules() {
    const button = $('#project-rule-save'), status = $('#project-rules-status');
    const submittedVersion = projectRulesState.version;
    const rules = projectRulesState.rows.map((rule) => ({ pattern: rule.pattern, project: rule.project }));
    button.disabled = true;
    status.textContent = 'Saving…';
    try {
      const response = await postJson('/api/projects/rules', { rules });
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        const errors = Number.isInteger(payload.index) && payload.index >= 0 ? [{ index: payload.index, error: payload.error || 'Invalid rules.' }] : [];
        if (projectRulesState.version === submittedVersion) mergeProjectRuleErrors(errors);
        status.textContent = payload.error === 'invalid rules' ? 'Rules were not saved. Fix the marked row.' : 'Rules could not be saved.';
        return;
      }
      let refreshed;
      try {
        const get = await fetch('/api/projects/rules');
        if (!get.ok) throw new Error('refresh failed');
        refreshed = await get.json();
      } catch {
        status.textContent = 'Rules were saved, but the refreshed list could not be loaded.';
        return;
      }
      projectRulesState.storedIssue = '';
      $('#project-rules-notice').textContent = '';
      if (projectRulesState.version === submittedVersion) {
        projectRulesState.rows = (Array.isArray(refreshed.rules) ? refreshed.rules : []).map((rule) => ({ pattern: String(rule?.pattern ?? ''), project: String(rule?.project ?? '') }));
        renderProjectRuleRows(refreshed.errors || []);
        status.textContent = 'Rules saved.';
      } else {
        mergeProjectRuleErrors();
        status.textContent = 'Submitted rules saved. Newer edits are still unsaved.';
      }
      scheduleProjectPreview();
    } catch {
      status.textContent = 'Rules could not be saved.';
    } finally {
      button.disabled = false;
    }
  }

  function markdown(text) {
    const raw = window.marked?.parse ? window.marked.parse(String(text ?? ''), { breaks: true }) : esc(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>');
    // Disallow images entirely: response content must not trigger remote fetches.
    return window.DOMPurify ? window.DOMPurify.sanitize(raw, { FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'style'], FORBID_ATTR: ['style'] }) : raw.replace(/<[^>]*>/g, '');
  }
  function appendMarkdown(container, text) { container.innerHTML = markdown(text); }
  function relative(ts) {
    if (!ts) return 'time unknown';
    const date = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (Number.isNaN(date.valueOf())) return 'time unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - date.valueOf()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
  function nameOf(s) { return byId(s,'displayName','display_name') || byId(s,'title') || (byId(s,'cwd') || '').split('/').filter(Boolean).pop() || byId(s,'sessionId','session_id') || 'Session'; }
  function statusOf(s) { return byId(s,'status') || 'unknown'; }
  function appendPill(parent, cls, text) { parent.append(el('span', `pill ${cls}`, text)); }
  const identityDrafts = new Map(), identityPending = new Set(), identityNotices = new Map();
  const identityText = s => `${byId(s,'host') || 'Unknown host'} · ${byId(s,'accountAlias') || 'Unassigned account'} · ${byId(s,'harness') === 'omp' ? 'OMP' : 'Claude'} · ${byId(s,'sessionId','session_id') || ''}`;

  const capabilityReceiptAnchors = new WeakMap();
  function recordCapabilityReceipt(capabilities) {
    if (capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) && !capabilityReceiptAnchors.has(capabilities)) {
      capabilityReceiptAnchors.set(capabilities, performance.now());
    }
  }

  async function saveIdentity(key, values) {
    if (identityPending.has(key)) return;
    identityPending.add(key); identityNotices.delete(key);
    const repaint = () => { const current = state.sessions.find(s => responseKey(s) === key); if (current) patchSessionCard(current, current); };
    repaint();
    try {
      const response = await postJson(`/api/sessions/${encodeURIComponent(key)}/identity`, values);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Identity could not be saved.');
      identityDrafts.delete(key);
      recordCapabilityReceipt(payload.session?.capabilities);
      scheduleSourcesRefresh();
      state.sessions = state.sessions.map(s => responseKey(s) === key ? payload.session : s);
      refreshSessionFilters();
      identityNotices.set(key, 'Identity saved.');
    } catch (error) {
      identityNotices.set(key, error.message || 'Identity could not be saved.');
    } finally { identityPending.delete(key); repaint(); }
  }

  function renderIdentity(s, key) {
    const details = el('details', 'identity-details');
    details.open = state.expanded.has(`${key}:identity`);
    details.addEventListener('toggle', () => details.open ? state.expanded.add(`${key}:identity`) : state.expanded.delete(`${key}:identity`));
    details.append(el('summary', '', 'Edit identity'));
    const form = el('form', 'identity-form'), busy = identityPending.has(key);
    const draft = identityDrafts.get(key) || { displayName: s.displayNameOverride || '', accountAlias: s.accountAliasOverride ?? '', followAccount: s.accountAliasOverride == null };
    const nameLabel = el('label', '', 'Session name'), name = el('input');
    name.type = 'text'; name.maxLength = 128; name.value = draft.displayName; name.placeholder = nameOf(s);
    name.dataset.replyFocus = 'identity-name'; name.disabled = busy; nameLabel.append(name);
    const aliasLabel = el('label', '', 'Account alias'), alias = el('input');
    alias.type = 'text'; alias.maxLength = 64; alias.value = draft.accountAlias; alias.placeholder = 'Unassigned';
    alias.pattern = '[A-Za-z0-9][A-Za-z0-9._ \\-]{0,63}'; alias.title = 'Start with a letter or number; use letters, numbers, spaces, dots, hyphens or underscores. No credentials.';
    alias.dataset.replyFocus = 'identity-account'; alias.disabled = busy; aliasLabel.append(alias);
    const followLabel = el('label', 'check-label'), follow = el('input');
    follow.type = 'checkbox'; follow.checked = draft.followAccount; follow.disabled = busy; follow.dataset.replyFocus = 'identity-follow-account';
    followLabel.append(follow, document.createTextNode('Follow source account'));
    alias.disabled = busy || follow.checked;
    const update = () => identityDrafts.set(key, { displayName: name.value, accountAlias: alias.value, followAccount: follow.checked });
    name.addEventListener('input', update); alias.addEventListener('input', update);
    follow.addEventListener('change', () => { alias.disabled = busy || follow.checked; update(); });
    const actions = el('div', 'reply-actions'), save = el('button', 'button button-secondary', busy ? 'Saving…' : 'Save identity');
    save.type = 'submit'; save.disabled = busy; save.dataset.replyFocus = 'identity-save';
    const reset = el('button', 'button button-secondary', 'Use source identity');
    reset.type = 'button'; reset.disabled = busy; reset.dataset.replyFocus = 'identity-reset';
    reset.addEventListener('click', () => saveIdentity(key, { displayName: null, accountAlias: null }));
    actions.append(save, reset);
    form.addEventListener('submit', event => {
      event.preventDefault();
      update();
      saveIdentity(key, { displayName: name.value.trim() || null, accountAlias: follow.checked ? null : alias.value.trim() });
    });
    const status = el('p', 'muted', identityNotices.get(key) || '');
    status.setAttribute('role', 'status');
    form.append(nameLabel, followLabel, aliasLabel, el('p', 'muted', `Source account: ${s.reportedAccountAlias || 'unassigned'}. An empty name uses the source name. Uncheck Follow source account to pin an alias; a blank pinned alias stays unassigned. Labels never change reply routing.`), actions, status);
    details.append(form);
    return details;
  }

  const capabilityActions = [
    ['view', 'View retained output'],
    ['message', 'Queue message'],
    ['structuredQuestion', 'Structured question'],
    ['approve', 'Approve'],
    ['interrupt', 'Interrupt'],
    ['resume', 'Resume'],
    ['launch', 'Launch'],
  ];
  const capabilityStatuses = new Set(['supported', 'unavailable', 'unknown']);
  function actionCapability(session, name) {
    const action = session?.capabilities?.actions?.[name];
    const status = capabilityStatuses.has(action?.status) ? action.status : 'unknown';
    const reason = typeof action?.reason === 'string' && action.reason ? action.reason :
      action ? 'The capability report did not include a reason.' : 'Capability report has not loaded.';
    return { status, reason };
  }
  function messageCapability(session) {
    const action = actionCapability(session, 'message');
    if (action.status !== 'supported') return { ...action, allowed: false };
    if (!state.repliesEnabled) return { ...action, reason: 'Replies are disabled.', allowed: false };
    if (statusOf(session) === 'ended') return { ...action, reason: 'Session has ended.', allowed: false };
    return { ...action, allowed: true };
  }
  function deliverySnapshot(session) {
    const capabilities = session?.capabilities || {}, delivery = capabilities.delivery || {};
    let status = ['observed', 'unknown', 'unavailable'].includes(delivery.status) ? delivery.status : 'unknown';
    let reason = typeof delivery.reason === 'string' && delivery.reason ? delivery.reason : 'Delivery report has not loaded.';
    if (status === 'observed') {
      const evaluatedAt = capabilities.evaluatedAt;
      if (typeof evaluatedAt !== 'number' || !Number.isFinite(evaluatedAt)) {
        status = 'unknown';
        reason = `Hub evaluation time is unavailable; delivery freshness is unknown. ${reason}`;
      } else if (typeof delivery.expiresAt !== 'number' || !Number.isFinite(delivery.expiresAt)) {
        status = 'unknown';
        reason = `Observation expiry is unavailable; delivery is unknown. ${reason}`;
      } else {
        const receivedAt = capabilityReceiptAnchors.get(capabilities);
        if (!Number.isFinite(receivedAt)) {
          status = 'unknown';
          reason = `Client receipt time is unavailable; delivery freshness is unknown. ${reason}`;
        } else {
          const evaluatedNow = evaluatedAt + Math.max(0, performance.now() - receivedAt);
          if (delivery.expiresAt <= evaluatedNow) {
            status = 'unknown';
            reason = `Observation expired; delivery is unknown. ${reason}`;
          }
        }
      }
    }
    return { status, reason, observedAt: delivery.observedAt, expiresAt: delivery.expiresAt, protocol: delivery.protocol };
  }
  function capabilityTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
  }
  function renderSessionCapabilities(session, key) {
    const details = el('details', 'session-capabilities');
    details.open = state.expanded.has(`${key}:capabilities`);
    details.addEventListener('toggle', () => details.open ? state.expanded.add(`${key}:capabilities`) : state.expanded.delete(`${key}:capabilities`));
    const summary = el('summary', 'capability-summary');
    summary.dataset.replyFocus = 'capabilities-summary';
    summary.append(el('span', '', 'Controls'), el('span', 'capability-summary-help', '7 actions · delivery snapshot'));
    details.append(summary);
    const list = el('dl', 'capability-actions');
    for (const [name, label] of capabilityActions) {
      const capability = actionCapability(session, name), row = el('div', 'capability-row');
      const title = el('dt', 'capability-name', label), description = el('dd', 'capability-detail');
      description.append(el('span', `capability-state ${capability.status}`, capability.status), el('span', 'capability-reason', capability.reason));
      row.append(title, description); list.append(row);
    }
    details.append(list);
    const delivery = deliverySnapshot(session), status = el('div', 'capability-delivery');
    status.append(
      el('span', 'capability-delivery-label', 'Delivery · snapshot'),
      el('span', `capability-state ${delivery.status}`, delivery.status),
      el('span', 'capability-reason', delivery.reason)
    );
    details.append(status);
    const timestamps = [];
    const observedAt = capabilityTime(delivery.observedAt), expiresAt = capabilityTime(delivery.expiresAt);
    if (observedAt) timestamps.push(`Hub receipt ${observedAt}`);
    if (expiresAt) timestamps.push(`expires ${expiresAt}`);
    if (delivery.protocol) timestamps.push(`protocol ${delivery.protocol}`);
    if (timestamps.length) details.append(el('p', 'capability-timestamps', timestamps.join(' · ')));
    details.append(el('p', 'capability-note', 'When Queue message is supported, Send accepts text into Dash’s bounded queue; this does not confirm delivery. Delivery is a snapshot, not a connection indicator.'));
    const pending = state.capabilityRefreshPending.has(key);
    const refresh = el('button', 'button button-secondary capability-refresh', pending ? 'Refreshing…' : 'Refresh snapshot');
    refresh.type = 'button'; refresh.dataset.replyFocus = 'capability-refresh';
    refresh.setAttribute('aria-label', `Refresh capabilities for ${nameOf(session)}`);
    refresh.setAttribute('aria-busy', String(pending));
    refresh.addEventListener('click', () => refreshSessionCapabilities(key));
    const footer = el('div', 'capability-footer');
    footer.append(refresh);
    const notice = state.capabilityRefreshNotice.get(key) || (pending ? 'Refreshing capability snapshot…' : '');
    if (notice) { const message = el('span', 'capability-refresh-notice', notice); message.setAttribute('role', 'status'); footer.append(message); }
    details.append(footer);
    return details;
  }
  async function refreshSessionCapabilities(key) {
    if (state.capabilityRefreshPending.has(key)) return;
    const session = state.sessions.find(item => responseKey(item) === key);
    if (!session) return;
    const version = (state.capabilityFetchVersion.get(key) || 0) + 1;
    state.capabilityFetchVersion.set(key, version);
    state.capabilityRefreshPending.add(key);
    state.capabilityRefreshNotice.delete(key);
    patchSessionCard(session, session);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(key)}/capabilities`, { credentials: 'same-origin' });
      if (state.capabilityFetchVersion.get(key) !== version) return;
      if (!response.ok) throw new Error(`capabilities ${response.status}`);
      const capabilities = await response.json(); recordCapabilityReceipt(capabilities);
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new Error('invalid capability report');
      if (state.capabilityFetchVersion.get(key) !== version) return;
      const index = state.sessions.findIndex(item => responseKey(item) === key);
      if (index < 0) return;
      const current = state.sessions[index];
      if (current !== session) {
        state.capabilityRefreshNotice.set(key, 'Session updated during refresh; showing its latest report.');
        return;
      }
      const updated = { ...current, capabilities };
      state.sessions[index] = updated;
      state.capabilityRefreshNotice.set(key, 'Capabilities refreshed.');
      patchSessionCard(updated, current);
    } catch {
      if (state.capabilityFetchVersion.get(key) !== version) return;
      state.capabilityRefreshNotice.set(key, 'Could not refresh; showing the last report.');
      const current = state.sessions.find(item => responseKey(item) === key);
      if (current) patchSessionCard(current, current);
    } finally {
      if (state.capabilityFetchVersion.get(key) === version) {
        state.capabilityRefreshPending.delete(key);
        const current = state.sessions.find(item => responseKey(item) === key);
        if (current) patchSessionCard(current, current);
      }
    }
  }
  function replyDialogCopy(s) {
    if (statusOf(s) !== 'needs_input') return '';
    const reason = byId(s, 'needsReason', 'needs_reason');
    if (byId(s, 'harness') === 'claude' && reason === 'question') {
      const id = s.pendingQuestion?.id ?? s.pendingQuestionId;
      if (id && s.pendingQuestion?.id === id) return '';
      return 'Answer in the terminal or Remote Control (remote questions are opt-in)';
    }
    if (byId(s, 'harness') === 'claude' && ['permission','permission_prompt','elicitation_dialog','elicitation_url_dialog'].includes(reason)) return 'Answer in the terminal or Remote Control (dialog answering: Step 6)';
    if (byId(s, 'harness') === 'omp' && reason === 'permission') return 'Approve in the terminal (dialog answering: Step 6)';
    return '';
  }
  function replyNotice(key, message) {
    if (message) state.replyNotices.set(key, message); else state.replyNotices.delete(key);
    const session = state.sessions.find(item => responseKey(item) === key);
    if (session) patchSessionCard(session, session);
  }
  function replyApiPath(key, suffix = '') {
    const endpoint = suffix === '/reply' ? suffix : `/replies${suffix}`;
    return `/api/sessions/${encodeURIComponent(key)}${endpoint}`;
  }
  async function refreshReplyAvailability() {
    const response = await fetch('/healthz');
    if (!response.ok) throw new Error('Reply status unavailable');
    const payload = await response.json(), enabled = payload?.replies?.enabled === true;
    if (enabled === state.repliesEnabled) return enabled;
    state.repliesEnabled = enabled;
    $('#ideas-open').hidden = !enabled; if (enabled) refreshIdeas(true);
    renderSessions();
    if (enabled) refreshVisibleReplyLists();
    else stopAllReplyRefreshes();
    return enabled;
  }
  function stopReplyRefresh(key, forgetUntil = true) {
    const timer = state.replyRefreshTimers.get(key);
    if (timer) window.clearTimeout(timer);
    state.replyRefreshTimers.delete(key);
    if (forgetUntil) state.replyRefreshUntil.delete(key);
  }
  function stopAllReplyRefreshes() {
    for (const key of new Set([...state.replyRefreshTimers.keys(), ...state.replyRefreshUntil.keys()])) stopReplyRefresh(key);
  }
  function scheduleReplyRefresh(key) {
    const visible = state.repliesEnabled && (replySessions().some(session => responseKey(session) === key && statusOf(session) !== 'ended') || selectiveSendState.targets.get(key)?.replyId);
    const hasPending = (state.replyStates.get(key) || []).some(reply => reply.state === 'leased' ||
      (reply.state === 'queued' && reply.id === selectiveSendState.targets.get(key)?.replyId));
    if (!visible || !hasPending) { stopReplyRefresh(key); return; }
    const until = state.replyRefreshUntil.get(key) ?? Date.now() + 60_000;
    state.replyRefreshUntil.set(key, until);
    if (Date.now() >= until) { stopReplyRefresh(key, false); return; }
    if (state.replyRefreshTimers.has(key)) return;
    state.replyRefreshTimers.set(key, window.setTimeout(() => {
      state.replyRefreshTimers.delete(key);
      if (Date.now() < until) refreshReplyList(key);
    }, 1000));
  }
  async function refreshReplyList(key) {
    if (!state.repliesEnabled) return;
    const requestedSession = state.sessions.find(item => responseKey(item) === key);
    const version = (state.replyFetchVersion.get(key) || 0) + 1;
    state.replyFetchVersion.set(key, version);
    try {
      const response = await fetch(replyApiPath(key));
      if (state.replyFetchVersion.get(key) !== version) return;
      if (response.status === 404) {
        stopReplyRefresh(key);
        await refreshReplyAvailability().catch(() => {});
        return;
      }
      if (!response.ok) { scheduleReplyRefresh(key); return; }
      const payload = await response.json(); recordCapabilityReceipt(payload?.capabilities);
      if (state.replyFetchVersion.get(key) !== version) return;
      state.replyStates.set(key, Array.isArray(payload?.replies) ? payload.replies : []);
      updateSelectiveReceipt(key);
      let session = state.sessions.find(item => responseKey(item) === key);
      if (session && session === requestedSession && payload?.capabilities && typeof payload.capabilities === 'object' && !Array.isArray(payload.capabilities)) {
        const index = state.sessions.findIndex(item => responseKey(item) === key);
        if (index >= 0) { session = { ...session, capabilities: payload.capabilities }; state.sessions[index] = session; }
      }
      if (session) patchSessionCard(session, session);
      scheduleReplyRefresh(key);
    } catch { scheduleReplyRefresh(key); }
  }
  function replySessions() {
    return state.view === 'sessions' ? visibleSessions() : state.view === 'console' ? state.sessions.filter(s => responseKey(s) === consoleState.selectedKey) : [];
  }
  function refreshVisibleReplyLists() {
    const visible = state.repliesEnabled ? replySessions().filter(session => statusOf(session) !== 'ended') : [];
    const visibleKeys = new Set(visible.map(responseKey));
    for (const [key, target] of selectiveSendState.targets) if (target.replyId) visibleKeys.add(key);
    for (const key of new Set([...state.replyRefreshTimers.keys(), ...state.replyRefreshUntil.keys()])) if (!visibleKeys.has(key)) stopReplyRefresh(key);
    for (const key of visibleKeys) refreshReplyList(key);
  }
  function focusSnapshot(root) {
    const active = document.activeElement;
    if (!root?.contains(active) || !active?.dataset?.replyFocus) return null;
    return {
      key: root.dataset.key,
      focus: active.dataset.replyFocus,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      direction: active.selectionDirection || 'none'
    };
  }
  function restoreCardFocus(snapshot, root) {
    if (!snapshot || snapshot.key !== root?.dataset.key) return;
    const target = [...root.querySelectorAll('[data-reply-focus]')].find(node => node.dataset.replyFocus === snapshot.focus);
    if (!target || target.disabled) return;
    target.focus({ preventScroll: true });
    if (snapshot.start !== null && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction); } catch {}
    }
  }
  async function cancelReply(key, id) {
    const token = `${key}:${id}`;
    if (state.cancelPending.has(token)) return;
    state.cancelPending.add(token);
    const session = state.sessions.find(item => responseKey(item) === key);
    if (session) patchSessionCard(session, session);
    try {
      const response = await postJson(replyApiPath(key, '/cancel'), { id });
      if (!response.ok) { replyNotice(key, 'Could not cancel this reply.'); return; }
      await refreshReplyList(key);
    } catch { replyNotice(key, 'Could not cancel this reply.'); }
    finally {
      state.cancelPending.delete(token);
      const current = state.sessions.find(item => responseKey(item) === key);
      if (current) patchSessionCard(current, current);
    }
  }
  function persistDraftRecovery() {
    window.clearTimeout(draftRecovery.timer);
    draftRecovery.timer = null;
    try {
      if (draftRecovery.enabled) sessionStorage.setItem(draftStorageKey, JSON.stringify({ entries: [...draftRecovery.entries] }));
      else sessionStorage.removeItem(draftStorageKey);
      draftRecovery.error = '';
    } catch {
      draftRecovery.error = 'Draft storage is unavailable. Recovery or clearing stored copies could not be confirmed; clear this site’s session data if needed.';
    }
    for (const note of document.querySelectorAll('.reply-recovery-note')) {
      const key = note.closest('.reply-controls')?.querySelector('textarea')?.dataset.sessionKey;
      if (key) note.textContent = draftRecoveryNote(key);
    }
  }
  function loadDraftRecovery() {
    try {
      const raw = sessionStorage.getItem(draftStorageKey);
      if (raw === null) return;
      const saved = JSON.parse(raw), now = Date.now();
      if (!Array.isArray(saved?.entries) || saved.entries.length > 100) throw new Error('Invalid draft storage');
      draftRecovery.enabled = true;
      for (const entry of saved.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, value] = entry;
        if (typeof key !== 'string' || key.length > 2048 || !key || typeof value?.text !== 'string' ||
          !value.text || value.text.length > 32_000 || !Number.isFinite(value.editedAt) || value.editedAt > now) continue;
        if (value.editedAt + draftLifetime <= now) { draftRecovery.expired.add(key); continue; }
        draftRecovery.entries.set(key, value);
        draftRecovery.recovered.add(key);
        state.drafts.set(key, value.text);
      }
      persistDraftRecovery();
    } catch {
      draftRecovery.enabled = false;
      draftRecovery.entries.clear();
      persistDraftRecovery();
      draftRecovery.error ||= 'Stored drafts were invalid and could not be recovered.';
    }
  }
  function saveDraft(key, text) {
    const hadStoredCopy = draftRecovery.entries.has(key);
    draftRecovery.recovered.delete(key);
    draftRecovery.expired.delete(key);
    if (text) state.drafts.set(key, text); else state.drafts.delete(key);
    if (draftRecovery.enabled && text && text.length <= 32_000 &&
      (draftRecovery.entries.has(key) || draftRecovery.entries.size < 100)) {
      draftRecovery.entries.set(key, { text, editedAt: Date.now() });
    } else draftRecovery.entries.delete(key);
    if (draftRecovery.entries.has(key)) {
      window.clearTimeout(draftRecovery.timer);
      draftRecovery.timer = window.setTimeout(persistDraftRecovery, 250);
    } else if (hadStoredCopy || !text) persistDraftRecovery();
  }
  function expireDraftRecovery() {
    const now = Date.now(), changed = [];
    for (const [key, entry] of draftRecovery.entries) {
      if (entry.editedAt + draftLifetime > now) continue;
      draftRecovery.entries.delete(key);
      draftRecovery.recovered.delete(key);
      draftRecovery.expired.add(key);
      state.drafts.delete(key);
      changed.push(key);
    }
    if (!changed.length) return;
    persistDraftRecovery();
    for (const key of changed) {
      const session = state.sessions.find(item => responseKey(item) === key);
      if (session) patchSessionCard(session, session);
    }
  }
  function draftRecoveryNote(key) {
    if (draftRecovery.error) return draftRecovery.error;
    if (draftRecovery.expired.has(key)) return 'Draft expired and was cleared after 30 minutes without editing.';
    if (!draftRecovery.enabled) return 'Drafts stay in memory. Recovery is off; reloading discards them.';
    if (state.drafts.has(key) && !draftRecovery.entries.has(key)) return 'This draft is memory-only: recovery is limited to 100 drafts of 32,000 characters each.';
    return `${draftRecovery.recovered.has(key) ? 'Recovered draft. ' : ''}Recovery saves text in this tab’s session storage after a short typing pause and when leaving the page; it expires 30 minutes after editing and is never shared with other devices. Clear draft or turn recovery off to remove stored copies. Browser session restore may retain unexpired drafts.`;
  }
  function renderAuthorizationPreview(s, key, current, turnSeq, ready) {
    const preview = authorizationPreviews.get(key);
    if (!preview) return null;
    const valid = preview.turnSeq === turnSeq && preview.responseId === byId(current, 'id') &&
      preview.text === byId(current, 'text') && preview.identity === identityText(s);
    if (!valid) {
      authorizationPreviews.delete(key);
      return el('p', 'reply-hint reply-dialog-note', 'Authorization scope changed. Review the current response before authorizing.');
    }
    const box = el('section', 'authorization-preview');
    box.setAttribute('aria-label', 'Authorization scope');
    box.append(el('strong', '', `Authorize turn ${turnSeq} · response ${preview.responseId}`),
      el('p', 'reply-target', `${nameOf(s)} · ${preview.identity}`),
      el('p', 'authorization-warning', 'This grants approval for the actions requested in the response below, including any destructive steps. It is not an ordinary Continue or option selection.'),
      el('pre', 'authorization-scope', preview.text),
      el('p', 'reply-hint', `Exact instruction to send: ${authorizationText}`));
    const actions = el('div', 'reply-actions');
    const confirm = el('button', 'button button-secondary', 'Authorize this scope');
    confirm.type = 'button'; confirm.disabled = !ready; confirm.dataset.replyFocus = 'authorize-confirm';
    confirm.addEventListener('click', () => {
      const live = state.sessions.find(item => responseKey(item) === key);
      const response = live && currentTurnResponse(responsesOf(live), preview.turnSeq);
      if (!live || Number(byId(live, 'turnSeq', 'turn_seq')) !== preview.turnSeq ||
        statusOf(live) !== 'your_turn' || byId(response, 'id') !== preview.responseId ||
        byId(response, 'text') !== preview.text || identityText(live) !== preview.identity) {
        authorizationPreviews.delete(key);
        replyNotice(key, 'Out of date: review the current response before authorizing.');
        return;
      }
      authorizationPreviews.delete(key);
      submitReply(key, authorizationText, preview.turnSeq);
    });
    const cancel = el('button', 'button button-secondary', 'Do not authorize');
    cancel.type = 'button'; cancel.dataset.replyFocus = 'authorize-cancel';
    cancel.addEventListener('click', () => {
      authorizationPreviews.delete(key);
      const live = state.sessions.find(item => responseKey(item) === key);
      if (live) patchSessionCard(live, live);
    });
    actions.append(confirm, cancel); box.append(actions);
    return box;
  }
  function replyDeliveryLabel(reply) {
    if (reply.state === 'queued') return ['Queued', 'Waiting for a safe delivery point; cancellation is available.'];
    if (reply.state === 'leased') return reply.committed === true
      ? ['Committed', 'Delivery has committed; it can no longer be cancelled. Execution is not confirmed.']
      : reply.committed === false
        ? ['Sending', 'A delivery worker has the reply; cancellation is still available until commitment.']
        : ['Sending', 'Delivery is in progress; cancellation availability is unknown.'];
    if (reply.state === 'delivered') return ['Delivered', 'Delivery was recorded, not task completion. A committed handoff may be recorded after its receipt times out.'];
    if (reply.state === 'expired') return ['Expired', 'The queue deadline passed without delivery; nothing will be sent.'];
    if (reply.state === 'cancelled') return ['Cancelled', reply.cancelReason === 'stale'
      ? 'The session moved to another turn; this reply will not be sent.'
      : 'This reply was cancelled before commitment and will not be sent.'];
    return ['Unknown', 'Delivery state could not be determined.'];
  }
  async function submitReply(key, text, answersTurn, answersQuestion) {
    if (state.replyPending.has(key)) return;
    const session = state.sessions.find(item => responseKey(item) === key);
    if (!session || !messageCapability(session).allowed || replyDialogCopy(session)) return;
    if (answersQuestion !== undefined && (session.pendingQuestion?.id ?? session.pendingQuestionId) !== answersQuestion) {
      replyNotice(key, 'Out of date: the question has been answered or replaced');
      await loadSessions().catch(() => {});
      return;
    }
    state.replyNotices.delete(key);
    state.replyPending.add(key);
    patchSessionCard(session, session);
    try {
      const response = await postJson(replyApiPath(key, '/reply'), {
        text,
        ...(answersTurn !== undefined ? { answersTurn } : {}),
        ...(answersQuestion !== undefined ? { answersQuestion } : {})
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 404 && payload?.error === 'not found') {
          state.repliesEnabled = false; stopAllReplyRefreshes(); renderSessions(); return;
        }
        if (response.status === 409 && ['stale_turn', 'stale_question'].includes(payload?.reason)) {
          await loadSessions().catch(() => {});
          replyNotice(key, payload.reason === 'stale_question' ? 'Out of date: the question has been answered or replaced' : 'Out of date: the session has moved on');
        } else replyNotice(key, payload?.reason === 'invalid_question' ? 'Could not send this answer. Refresh the question and try again.' : 'Could not send this reply.');
        return;
      }
      const draftKey = answersQuestion === undefined ? key : `${key}#${answersQuestion}`;
      if (answersTurn === undefined && state.drafts.get(draftKey) === text) saveDraft(draftKey, '');
      if (answersTurn !== undefined) state.picks.delete(`${key}#${answersTurn}`);
      await refreshReplyList(key);
    } catch { replyNotice(key, 'Could not send this reply.'); }
    finally {
      state.replyPending.delete(key);
      const current = state.sessions.find(item => responseKey(item) === key);
      if (current) patchSessionCard(current, current);
    }
  }

  async function submitQuestion(key, questionId, answers) {
    if (state.replyPending.has(key)) return;
    const session = state.sessions.find(item => responseKey(item) === key);
    if (!session || statusOf(session) !== 'needs_input' || byId(session, 'harness') !== 'claude' ||
        replyDialogCopy(session) || (session.pendingQuestion?.id ?? session.pendingQuestionId) !== questionId) {
      await loadSessions().catch(() => {});
      replyNotice(key, 'Out of date: the question has been answered or replaced');
      return;
    }
    state.replyNotices.delete(key);
    state.replyPending.add(key);
    patchSessionCard(session, session);
    try {
      const response = await postJson(`/api/sessions/${encodeURIComponent(key)}/question`, { questionId, answers });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 404 && payload?.error === 'not found') {
          state.repliesEnabled = false; stopAllReplyRefreshes(); renderSessions(); return;
        }
        if (response.status === 409 && payload?.reason === 'stale_question') {
          await loadSessions().catch(() => {});
          replyNotice(key, 'Out of date: the question has been answered or replaced');
        } else replyNotice(key, payload?.reason === 'invalid_question'
          ? 'Could not send this answer. Check the selections and try again.'
          : 'Could not send this answer.');
        return;
      }
      questionPicks.delete(`${key}#${questionId}`);
      await loadSessions().catch(() => {});
    } catch { replyNotice(key, 'Could not send this answer.'); }
    finally {
      state.replyPending.delete(key);
      const current = state.sessions.find(item => responseKey(item) === key);
      if (current) patchSessionCard(current, current);
    }
  }

  function renderReplyControls(s, key, status, responses) {
    if (!state.repliesEnabled || status === 'ended') return null;
    const controls = el('section', 'reply-controls');
    const message = messageCapability(s), dialogCopy = replyDialogCopy(s), busy = state.replyPending.has(key);
    const harness = byId(s, 'harness'), reason = byId(s, 'needsReason', 'needs_reason');
    const pendingId = harness === 'omp' && status === 'needs_input' && !dialogCopy
      ? s.pendingQuestion?.id ?? s.pendingQuestionId
      : harness === 'claude' && status === 'needs_input' && reason === 'question' &&
        s.pendingQuestion && s.pendingQuestion.id === s.pendingQuestionId ? s.pendingQuestion.id : undefined;
    const pending = pendingId ? s.pendingQuestion : undefined, claudeQuestion = harness === 'claude' && Boolean(pending);
    const draftKey = pendingId ? `${key}#${pendingId}` : key, allowed = message.allowed && !dialogCopy;
    controls.append(el('p', 'reply-target', `Target locked · ${nameOf(s)} · ${identityText(s)}`));
    if (pending) controls.append(renderPendingQuestion(key, pending, busy, harness));
    const actions = el('div', 'reply-actions');
    if (!claudeQuestion) {
      const ompQuestion = harness === 'omp' && status === 'needs_input' && reason === 'question';
      const structured = ompQuestion ? actionCapability(s, 'structuredQuestion') : null;
      const hint = !message.allowed ? message.reason : dialogCopy || (ompQuestion
        ? pendingId ? "Answers omp's pending question" : `This queues ordinary text; it does not submit a structured answer to the OMP question. Structured-question capability is ${structured.status}: ${structured.reason}`
        : 'Cmd/Ctrl+Enter to queue a message.');
      const label = el('label', 'reply-label', `Reply to ${nameOf(s)}`), textarea = el('textarea', 'reply-input');
      if (allowed) controls.append(el('p', 'reply-queue-note', 'Send places text in Dash’s bounded queue; it does not confirm delivery.'));
      textarea.rows = 3; textarea.value = state.drafts.get(draftKey) ?? ''; textarea.disabled = !allowed;
      textarea.dataset.sessionKey = draftKey;
      textarea.setAttribute('aria-label', `Reply to ${nameOf(s)}`); textarea.dataset.replyFocus = 'input';
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!textarea.disabled && textarea.value.trim()) submitReply(key, textarea.value, undefined, pendingId);
        }
      });
      label.append(textarea); controls.append(label, el('p', `reply-hint${allowed ? '' : ' reply-dialog-note'}`, hint));
      const recoveryLabel = el('label', 'reply-recovery-toggle'), recovery = el('input');
      recovery.type = 'checkbox'; recovery.checked = draftRecovery.enabled; recovery.dataset.replyFocus = 'recovery';
      recoveryLabel.append(recovery, document.createTextNode(' Recover drafts after reload in this tab'));
      const recoveryNote = el('p', 'reply-hint reply-recovery-note', draftRecoveryNote(draftKey));
      recovery.addEventListener('change', () => {
        draftRecovery.enabled = recovery.checked;
        draftRecovery.entries.clear();
        draftRecovery.recovered.clear();
        if (draftRecovery.enabled) for (const [draftKey, text] of state.drafts) {
          if (text.length <= 32_000 && draftRecovery.entries.size < 100) draftRecovery.entries.set(draftKey, { text, editedAt: Date.now() });
        }
        persistDraftRecovery();
        for (const session of replySessions()) patchSessionCard(session, session);
      });
      controls.append(recoveryLabel, recoveryNote);
      const send = el('button', 'button button-primary', 'Send reply');
      send.type = 'button'; send.disabled = !allowed || busy || !textarea.value.trim(); send.dataset.replyFocus = 'send';
      textarea.addEventListener('input', () => {
        saveDraft(draftKey, textarea.value);
        recoveryNote.textContent = draftRecoveryNote(draftKey);
        send.disabled = !allowed || state.replyPending.has(key) || !textarea.value.trim();
      });
      send.addEventListener('click', () => submitReply(key, textarea.value, undefined, pendingId)); actions.append(send);
      const clearDraft = el('button', 'button button-secondary', 'Clear draft');
      clearDraft.type = 'button'; clearDraft.dataset.replyFocus = 'clear-draft';
      clearDraft.addEventListener('click', () => {
        saveDraft(draftKey, '');
        const live = state.sessions.find(item => responseKey(item) === key);
        if (live) patchSessionCard(live, live);
      });
      actions.append(clearDraft);
    }
    const turnSeq = Number(byId(s, 'turnSeq', 'turn_seq') || 0), current = currentTurnResponse(responses, turnSeq);
    if (!pendingId && responses.length > 0 && turnSeq > 0) {
      const ready = status === 'your_turn' && allowed && !busy && Boolean(current);
      if (current) controls.append(...renderDecisions(key, current, turnSeq, ready));
      else controls.append(el('p', 'reply-hint reply-dialog-note', "Quick actions are off: the latest response isn't this turn's. Reply with text."));
      const continueButton = el('button', 'button button-secondary', 'Continue');
      continueButton.type = 'button'; continueButton.disabled = !ready; continueButton.dataset.replyFocus = 'continue';
      continueButton.addEventListener('click', () => submitReply(key, 'Continue with the next step you recommended.', turnSeq));
      const recommendationButton = el('button', 'button button-secondary', 'Authorize recommendation');
      recommendationButton.type = 'button'; recommendationButton.disabled = !ready; recommendationButton.dataset.replyFocus = 'recommendation';
      recommendationButton.addEventListener('click', () => {
        authorizationPreviews.set(key, { turnSeq, responseId: byId(current, 'id'), text: byId(current, 'text'), identity: identityText(s) });
        const live = state.sessions.find(item => responseKey(item) === key);
        if (live) patchSessionCard(live, live);
      });
      actions.append(continueButton, recommendationButton);
      const preview = renderAuthorizationPreview(s, key, current, turnSeq, ready);
      if (preview) controls.append(preview);
    }
    if (actions.children.length) controls.append(actions);
    const replies = state.replyStates.get(key) || [];
    if (replies.length) {
      const list = el('ul', 'reply-history'); list.setAttribute('aria-label', 'Recent replies');
      for (const reply of replies) {
        const item = el('li', 'reply-history-item'), [stateLabel, explanation] = replyDeliveryLabel(reply);
        item.append(el('span', 'reply-history-state', stateLabel), el('span', 'reply-history-source', String(reply.source || 'unknown')),
          el('span', 'reply-history-explanation', explanation));
        const cancelable = reply.state === 'queued' || reply.state === 'leased' && reply.committed === false;
        if (cancelable) {
          const cancel = el('button', 'button button-secondary reply-cancel', 'Cancel'), token = `${key}:${reply.id}`;
          cancel.type = 'button'; cancel.disabled = state.cancelPending.has(token); cancel.dataset.replyFocus = `cancel-${reply.id}`;
          cancel.setAttribute('aria-label', `Cancel ${stateLabel.toLowerCase()} ${String(reply.source || 'unknown')} reply`);
          cancel.addEventListener('click', () => cancelReply(key, reply.id)); item.append(cancel);
        }
        list.append(item);
      }
      controls.append(list);
    }
    const notice = el('p', 'reply-status', state.replyNotices.get(key) || ''); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); controls.append(notice);
    return controls;
  }

  function renderPendingQuestion(key, pending, busy, harness) {
    const isClaude = harness === 'claude', pickKey = `${key}#${pending.id}`, questions = pending.questions;
    let answers = questionPicks.get(pickKey);
    if (!answers) {
      answers = questions.map(() => ({ selected: new Set(), other: false, custom: '' }));
      questionPicks.set(pickKey, answers);
    }
    const box = el('div', 'decisions');
    if (isClaude) box.dataset.claudeQuestionId = pending.id;
    else box.dataset.ompQuestionId = pending.id;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Pending ${isClaude ? 'Claude' : 'OMP'} questions`);
    const send = el('button', 'button button-primary', questions.length === 1 ? 'Send answer' : 'Send answers');
    send.type = 'button';
    if (isClaude) send.dataset.claudeQuestionSubmit = ''; else send.dataset.ompSubmit = '';
    send.dataset.replyFocus = `question-${pending.id}-send`;
    const ready = () => questions.every((question, index) => question.multi === true ||
      answers[index].selected.size === 1 || answers[index].other && answers[index].custom.trim());
    const refreshSend = () => { send.disabled = busy || !ready(); };
    const submit = () => {
      if (!ready()) return;
      if (isClaude) {
        const selections = Object.create(null);
        questions.forEach((question, index) => {
          const answer = answers[index];
          selections[question.question] = {
            selectedOptions: [...answer.selected].sort((left, right) => left - right),
            ...(answer.other && answer.custom.trim() ? { customInput: answer.custom } : {}),
          };
        });
        submitQuestion(key, pending.id, selections);
        return;
      }
      const text = questions.map((question, index) => {
        const answer = answers[index], result = {
          selectedOptions: question.options.filter((_, option) => answer.selected.has(option)).map(option => option.label),
          ...(answer.other && answer.custom.trim() ? { customInput: answer.custom } : {}),
        };
        return `${JSON.stringify(question.id)}: ${JSON.stringify(result)}`;
      }).join('\n');
      if ([...text].length > 4000) { replyNotice(key, 'Answer is too long. Shorten the custom text before sending.'); return; }
      submitReply(key, text, undefined, pending.id);
    };
    questions.forEach((question, index) => {
      const answer = answers[index], group = el('div', 'omp-question'), options = el('div', 'decision-options');
      group.dataset[isClaude ? 'claudeQuestionIndex' : 'ompQuestionIndex'] = String(index);
      group.setAttribute('role', 'group'); group.setAttribute('aria-label', question.question);
      if (question.header) group.append(el('p', 'reply-hint', question.header));
      group.append(el('p', 'decision-title', question.question));
      const optionButtons = [];
      const refreshOptions = () => {
        optionButtons.forEach((button, option) => {
          const selected = answer.selected.has(option);
          button.classList.toggle('picked', selected); button.setAttribute('aria-pressed', String(selected));
        });
      };
      question.options.forEach((option, optionIndex) => {
        const recommended = question.multi !== true && question.recommended === optionIndex;
        const button = el('button', 'button button-secondary decision-option', `${option.label}${recommended && !option.label.endsWith(' (Recommended)') ? ' (Recommended)' : ''}`);
        button.type = 'button'; button.disabled = busy;
        button.dataset[isClaude ? 'claudeOptionIndex' : 'ompOptionIndex'] = String(optionIndex);
        button.dataset.replyFocus = `question-${pending.id}-${index}-${optionIndex}`;
        if (option.description) button.append(el('span', 'omp-option-description', option.description));
        button.addEventListener('click', () => {
          if (question.multi === true) {
            answer.selected.has(optionIndex) ? answer.selected.delete(optionIndex) : answer.selected.add(optionIndex);
          } else {
            answer.selected.clear(); answer.selected.add(optionIndex); answer.other = false;
            custom.hidden = true; other.setAttribute('aria-pressed', 'false');
          }
          refreshOptions(); refreshSend();
          if (questions.length === 1 && question.multi !== true) submit();
        });
        const row = el('div', 'omp-option');
        row.append(button);
        if (option.preview) {
          const preview = el('details', 'omp-option-preview'), summary = el('summary', '', `Preview: ${option.label}`);
          preview.append(summary, el('pre', '', option.preview)); row.append(preview);
        }
        optionButtons.push(button); options.append(row);
      });
      const other = el('button', 'button button-secondary decision-option', 'Other (type your own)');
      other.type = 'button'; other.disabled = busy;
      if (isClaude) other.dataset.claudeOther = ''; else other.dataset.ompOther = '';
      other.dataset.replyFocus = `question-${pending.id}-${index}-other`;
      other.setAttribute('aria-pressed', String(answer.other));
      const custom = el('textarea', 'reply-input');
      custom.rows = 2; custom.value = answer.custom; custom.hidden = !answer.other; custom.disabled = busy; custom.maxLength = 4000;
      if (isClaude) custom.dataset.claudeCustom = ''; else custom.dataset.ompCustom = '';
      custom.dataset.replyFocus = `question-${pending.id}-${index}-custom`;
      custom.setAttribute('aria-label', `Custom answer: ${question.question}`);
      other.addEventListener('click', () => {
        answer.other = !answer.other;
        if (answer.other && question.multi !== true) answer.selected.clear();
        other.setAttribute('aria-pressed', String(answer.other)); custom.hidden = !answer.other;
        refreshOptions(); refreshSend();
        if (answer.other) custom.focus();
      });
      custom.addEventListener('input', () => { answer.custom = custom.value; refreshSend(); });
      options.append(other); group.append(options, custom);
      if (question.multi === true) group.append(el('p', 'reply-hint', 'Choose any options, or send no selections.'));
      box.append(group); refreshOptions();
    });
    send.addEventListener('click', submit); refreshSend(); box.append(send);
    return box;
  }

  // R7: the current turn's options submit through submitReply only; every option/title string is textContent.
  function renderDecisions(key, current, turnSeq, ready) {
    const nodes = [], decisions = byId(current, 'decisions')?.decisions ?? [], verified = decisions.filter(recOf), quote = byId(current, 'recommendation');
    if (byId(current, 'decisionState', 'decision_state') === 'pending') nodes.push(el('p', 'decision-pending', 'Checking for options…'));
    nodes.push(el('p', 'decision-rec', verified.length ? `⭐ Recommended: ${verified.map(d => `${d.title} → ${recOf(d).key} (${recOf(d).label})`).join('; ')}` :
      quote ? `⭐ Recommended (agent's words): ${quote}` : 'No recommendation found in the response.'));
    if (!decisions.length) return nodes;
    const pickKey = `${key}#${turnSeq}`, picks = state.picks.get(pickKey) || new Map(), several = decisions.length > 1;
    const repaint = () => { const session = state.sessions.find(item => responseKey(item) === key); if (session) patchSessionCard(session, session); };
    const box = el('div', 'decisions'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Decisions');
    decisions.forEach((decision, g) => {
      const options = el('div', 'decision-options');
      decision.options.forEach((option, o) => {
        const picked = picks.get(g) === o, rec = decision.recIndex === o;
        const button = el('button', `button button-secondary decision-option${picked ? ' picked' : ''}`, `${option.key}${picked ? '✓' : ''}${rec ? '⭐' : ''} · ${option.label}`);
        button.type = 'button'; button.disabled = !ready; button.dataset.replyFocus = `decision-${g}-${o}`;
        button.setAttribute('aria-label', `Decision ${g + 1}, option ${option.key}: ${option.label}${rec ? ' (recommended)' : ''}`);
        if (several) {
          button.setAttribute('aria-pressed', String(picked));
          button.addEventListener('click', () => { picked ? picks.delete(g) : picks.set(g, o); state.picks.set(pickKey, picks); repaint(); });
        } else button.addEventListener('click', () => submitReply(key, dashboardChoice(decisions, new Map([[g, o]])), turnSeq));
        options.append(button);
      });
      box.append(el('p', 'decision-title', `${g + 1}. ${decision.title}`), options);
    });
    if (several) {
      const multi = el('div', 'decision-options'), send = el('button', 'button button-primary', '✅ Send picks'), all = el('button', 'button button-secondary', '⭐ All recs');
      send.type = all.type = 'button'; send.disabled = all.disabled = !ready; send.dataset.replyFocus = 'send-picks'; all.dataset.replyFocus = 'all-recs';
      send.addEventListener('click', () => submitReply(key, dashboardChoice(decisions, picks), turnSeq));
      all.addEventListener('click', () => submitReply(key, dashboardChoice(decisions, new Map()), turnSeq));
      multi.append(send, all); box.append(multi);
    }
    nodes.push(box);
    return nodes;
  }
  function prunePicks() {
    const live = new Set(state.sessions.map(s => `${responseKey(s)}#${Number(byId(s, 'turnSeq', 'turn_seq') || 0)}`));
    for (const pickKey of state.picks.keys()) if (!live.has(pickKey)) state.picks.delete(pickKey);
    const liveQuestions = new Set(state.sessions.filter(s => s.pendingQuestion).map(s => `${responseKey(s)}#${s.pendingQuestion.id}`));
    for (const key of questionPicks.keys()) if (!liveQuestions.has(key)) { questionPicks.delete(key); state.drafts.delete(key); }
  }

  function responseBlock(r, session, extraClass = '') {
    const article = el('article', `response ${extraClass}`);
    article.dataset.responseId = String(byId(r, 'id'));
    const head = el('div', 'response-head');
    head.append(el('span','response-time',relative(byId(r,'ts'))));
    const prompt = byId(r,'prompt');
    if (prompt) head.append(el('span','response-prompt',prompt));
    article.append(head);
    const body = el('div','markdown-body'); appendMarkdown(body, byId(r,'text') || ''); article.append(body);
    const decisions = byId(r,'decisions')?.decisions ?? [];
    // Every response other than the live current-turn one lists its options as display-only.
    const live = session !== r ? currentTurnResponse(responsesOf(session), Number(byId(session,'turnSeq','turn_seq') || 0)) : undefined;
    if (state.repliesEnabled && session !== r && decisions.length && byId(r,'id') !== byId(live,'id')) {
      const old = el('div','decisions decisions-history');
      decisions.forEach((decision, g) => {
        const list = el('ul','decision-history-options'); decision.options.forEach((option, o) => list.append(el('li','',`${option.key} · ${option.label}${decision.recIndex === o ? ' ⭐' : ''}`)));
        old.append(el('p','decision-title',`${g + 1}. ${decision.title}`), list);
      });
      old.append(el('p','muted decision-stale','Out of date: the session has moved on')); article.append(old);
    }
    return article;
  }

  function renderCard(s, reading = s, historical = false) {
    const key = responseKey(s), responses = responsesOf(reading), status = statusOf(s);
    const card = el('article', `session-card status-${status}`); card.dataset.key = key;
    const header = el('div','card-header');
    const title = el('div','session-title');
    title.append(el('h2','',nameOf(s)));
    if ((byId(s,'unreadCount','unread_count') || 0) > 0) { const dot=el('span','unread-dot'); dot.title='Unread responses'; title.append(dot); }
    header.append(title);
    const badges = el('div','badges');
    appendPill(badges, `status-pill ${status}`, `${historical ? 'Current: ' : ''}${statusLabel(s)}`);
    appendPill(badges,'host-pill',byId(s,'host') || 'local'); appendPill(badges,`harness-pill ${byId(s,'harness')}`,byId(s,'harness') === 'omp' ? 'OMP' : 'Claude');
    appendPill(badges, 'account-pill', byId(s,'accountAlias') || 'Unassigned account');
    if (byId(s,'sessionKind','session_kind') === 'bg') appendPill(badges,'kind-pill','bg');
    header.append(badges); card.append(header);
    const meta = el('div','card-meta'), resolvedProject = byId(s,'project');
    const projectLabel = resolvedProject === undefined || resolvedProject === null ? (byId(s,'cwd') || '').split('/').filter(Boolean).pop() || 'Project unknown' : String(resolvedProject) || 'Project unknown';
    meta.append(el('span','project-name',projectLabel));
    meta.append(el('span','activity-time',relative(byId(s,'lastActivity','last_activity')))); card.append(meta);
    card.append(renderIdentity(s, key));
    if (status === 'needs_input') {
      const box = el('div','needs-box');
      box.append(el('strong','',`${historical ? 'Current request: ' : ''}${byId(s,'needsReason','needs_reason') === 'permission' ? 'Permission requested' : 'Waiting for your input'}`));
      const needText = byId(s,'needsText','needs_text'); if (needText) { const content = el('div','needs-text'); appendMarkdown(content,needText); box.append(content); }
      card.append(box);
    }
    const promptText = byId(reading,'lastPrompt','last_prompt');
    if (promptText) {
      const prompt = el('details','prompt-details'); prompt.open = state.expanded.has(`${key}:prompt`);
      prompt.addEventListener('toggle', () => prompt.open ? state.expanded.add(`${key}:prompt`) : state.expanded.delete(`${key}:prompt`));
      prompt.append(el('summary','','Last prompt')); const p = el('div','prompt-text'); p.textContent = promptText; prompt.append(p); card.append(prompt);
    }
    if (responses.length) {
      const latest = responses[0], expanded = state.view === 'console' || state.expanded.has(`${key}:latest`);
      const wrap = el('div',`latest-response${expanded ? ' expanded' : ''}`); wrap.append(responseBlock(latest,reading));
      if (state.view !== 'console') {
        const toggle = el('button','text-button',expanded ? 'Collapse response' : 'Expand response'); toggle.type = 'button';
        toggle.addEventListener('click', () => { state.expanded.has(`${key}:latest`) ? state.expanded.delete(`${key}:latest`) : state.expanded.add(`${key}:latest`); renderSessions(); });
        wrap.append(toggle);
      }
      card.append(wrap);
      if (responses.length > 1) {
        const earlierOpen = state.expanded.has(`${key}:earlier`), details = el('details','earlier-details'); details.open = earlierOpen;
        details.addEventListener('toggle', () => details.open ? state.expanded.add(`${key}:earlier`) : state.expanded.delete(`${key}:earlier`));
        details.append(el('summary','',`Show ${responses.length - 1} earlier`));
        responses.slice(1).forEach((r) => details.append(responseBlock(r,reading,'earlier-response'))); card.append(details);
      }
    } else card.append(el('p','muted no-response','No responses yet.'));
    const actions = el('div','card-actions');
    if (!historical) {
      const read = el('button','button button-secondary','Mark session read');
      read.type = 'button';
      read.disabled = !(byId(s,'unreadCount','unread_count') || 0);
      read.title = 'Acknowledges all retained responses in this session.';
      read.addEventListener('click', () => markSeen(key));
      actions.append(read);
    }
    const copy = el('button','button button-secondary','Copy resume cmd'); copy.type='button'; copy.addEventListener('click', async () => {
      const id = byId(s,'sessionId','session_id') || ''; const command = `${byId(s,'harness') === 'omp' ? 'omp' : 'claude'} --resume ${JSON.stringify(String(id))}`;
      try { await navigator.clipboard.writeText(command); copy.textContent='Copied'; setTimeout(() => copy.textContent='Copy resume cmd',1200); } catch { copy.textContent='Clipboard unavailable'; setTimeout(() => copy.textContent='Copy resume cmd',1600); }
    }); actions.append(copy); card.append(actions);
    card.append(renderSessionCapabilities(s, key));
    if (!historical) {
      const replyControls = renderReplyControls(s, key, status, responses);
      if (replyControls) card.append(replyControls);
    }
    if (state.view === 'sessions') cardSizes.observe(card, { box: 'border-box' });
    return card;
  }

  function readConsoleLocation() {
    const params = new URLSearchParams(location.hash.slice(1));
    const view = params.get('view');
    return {
      key: params.get('session') || '',
      response: params.get('response'),
      view: view === 'timeline' || view === 'sessions' ? view : 'console',
    };
  }
  function historicalTargetFromLocation(locationState) {
    if (locationState.response === null) return null;
    const validId = /^[1-9]\d*$/.test(locationState.response) && Number.isSafeInteger(Number(locationState.response));
    const valid = validId && Boolean(locationState.key);
    return {
      key: locationState.key, responseId: validId ? Number(locationState.response) : null,
      status: valid ? 'loading' : 'error',
      error: !validId ? 'This response link has an invalid response id.' : !locationState.key ? 'This response link has no session key.' : '',
      response: null, session: null, result: null, requested: false,
    };
  }
  const initialConsoleLocation = readConsoleLocation();
  const consoleState = {
    selectedKey: initialConsoleLocation.key,
    order: [], reading: new Map(), history: new Map(), scroll: new Map(), follow: false, inventorySelection: '',
    preserveEmptySelection: false, allSessions: null, pinInventoryLoading: false, pinInventoryError: '',
    selectionVersion: 0, selectionInitialized: false, readResume: null, readNavigation: null, readPositions: new Map(), readPositionRequests: new Map(),
    readActionNotice: null, markingResponse: null,
    historicalTarget: historicalTargetFromLocation(initialConsoleLocation),
    paneMode: 'session',
  };
  const comparisonSlots = { a: null, b: null };
  const selectiveSendState = { phase: 'draft', targets: new Map(), text: '', submitted: 0 };
  const outputSearchState = { version: 0, query: '', filters: '', results: [], nextCursor: null, loading: false, status: 'idle', error: '' };
  const consolePreferences = {
    revision: -1, pins: [], views: [], loaded: false, loading: false, writing: false, fetchVersion: 0,
    error: '', errorSource: '', notice: '', selectedViewId: null, appliedViewConfig: null, viewChangedElsewhere: false,
    renameDraftViewId: null, renameDraft: '',
  };
  const consoleSignature = s => JSON.stringify([statusOf(s), byId(s, 'needsReason', 'needs_reason'), byId(s, 'needsText', 'needs_text'), byId(s, 'turnSeq', 'turn_seq'), byId(s, 'lastPrompt', 'last_prompt'),
    responsesOf(s).map(r => [byId(r, 'id'), byId(r, 'ts'), byId(r, 'turnSeq', 'turn_seq'), byId(r, 'decisionState', 'decision_state')])]);
  const statusLabel = s => ({ needs_input: 'Needs you', your_turn: 'Your turn', working: 'Working', ended: 'Ended' })[statusOf(s)] || 'Unknown';
  function setSessionUrl(key, push = false, responseId = null) {
    if (state.view !== 'console' && !push) return;
    const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1));
    hash.delete('view');
    if (key) hash.set('session', key); else hash.delete('session');
    if (responseId !== null && responseId !== undefined) hash.set('response', String(responseId)); else hash.delete('response');
    url.hash = hash.toString();
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }
  function setViewUrl(view, push = false) {
    const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1));
    if (view === 'timeline' || view === 'sessions') {
      if (hash.get('view') === view && !hash.has('session') && !hash.has('response')) return;
      url.hash = new URLSearchParams({ view }).toString();
    } else if (hash.has('view')) {
      hash.delete('view');
      if (consoleState.selectedKey && !hash.get('session')) hash.set('session', consoleState.selectedKey);
      url.hash = hash.toString();
    } else return;
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }
  function setConsolePaneMode(mode, render = true) {
    const isTimeline = mode === 'timeline';
    consoleState.paneMode = isTimeline ? 'timeline' : 'session';
    const sessionBtn = $('#console-pane-session'), timelineBtn = $('#console-pane-timeline');
    sessionBtn.classList.toggle('active', !isTimeline);
    sessionBtn.setAttribute('aria-pressed', String(!isTimeline));
    timelineBtn.classList.toggle('active', isTimeline);
    timelineBtn.setAttribute('aria-pressed', String(isTimeline));
    $('#console-detail').hidden = isTimeline;
    $('.console-history-section').hidden = isTimeline;
    $('#console-read-boundary').hidden = isTimeline;
    $('#console-pin-selected').hidden = isTimeline;
    $('#console-follow-wrap').hidden = isTimeline;
    $('#console-copy-link').hidden = isTimeline;
    $('#console-pane-timeline-view').hidden = !isTimeline;
    if (isTimeline) {
      $('#console-update').hidden = true;
      $('#console-selection-status').textContent = 'All client outputs in chronological order.';
      if (!state.timeline.length) loadTimeline(false).catch(() => {});
      else renderTimeline();
    } else if (render) {
      renderConsole();
      renderConsoleHistory();
    }
  }
  function selectConsoleSession(key, push = true, responseId = null, searchResult = null, selectionOptions = {}) {
    if (consoleState.paneMode === 'timeline') setConsolePaneMode('session', false);
    const pane = $('.console-pane');
    if (consoleState.historicalTarget) {
      consoleState.reading.delete(consoleState.historicalTarget.key);
      consoleState.history.delete(consoleState.historicalTarget.key);
      consoleState.historicalTarget = null;
    }
    if (consoleState.inventorySelection && consoleState.inventorySelection !== key) consoleState.inventorySelection = '';
    if (consoleState.selectedKey) consoleState.scroll.set(consoleState.selectedKey, pane.scrollTop);
    consoleState.preserveEmptySelection = false;
    consoleState.selectedKey = key;
    let target = null;
    if (responseId !== null && responseId !== undefined) {
      consoleState.reading.delete(key);
      consoleState.history.delete(key);
      const id = Number(responseId), validId = Number.isSafeInteger(id) && id > 0;
      target = {
        key, responseId: validId ? id : null, status: validId && key ? 'loading' : 'error',
        error: !validId ? 'This response link has an invalid response id.' : !key ? 'This response link has no session key.' : '',
        response: null, session: state.sessions.find(session => responseKey(session) === key) || null,
        result: searchResult, requested: false,
      };
      consoleState.historicalTarget = target;
      consoleState.follow = false;
      $('#console-follow').checked = false;
    }
    const shouldResume = selectionOptions.resume ?? (responseId === null || responseId === undefined);
    beginConsoleSelection(key, shouldResume && !target, selectionOptions.fetchPosition !== false);
    setSessionUrl(key, push, target?.status === 'loading' ? target.responseId : null);
    renderConsole(); renderConsoleHistory();
    pane.scrollTop = target ? 0 : consoleState.scroll.get(key) || 0;
    refreshVisibleReplyLists();
    if (target?.status === 'loading') startHistoricalResponse(target);
  }
  function applyConsoleLatest() {
    consoleState.readResume = null;
    consoleState.readNavigation = null;
    const key = consoleState.selectedKey, target = consoleState.historicalTarget;
    const s = state.sessions.find(session => responseKey(session) === key) || (target?.key === key ? target.session : null);
    if (target?.key === key) {
      consoleState.historicalTarget = null;
      consoleState.reading.delete(key);
      consoleState.history.delete(key);
      consoleState.follow = false;
      $('#console-follow').checked = false;
      setSessionUrl(key, true);
    }
    if (!s) { renderConsole(); renderConsoleHistory(); return; }
    consoleState.reading.set(responseKey(s), s); consoleState.history.delete(responseKey(s));
    renderConsole(); renderConsoleHistory(); $('.console-pane').scrollTop = 0;
  }
  function historicalReading(session, response) {
    return { ...session, lastResponses: [response], lastPrompt: byId(response, 'prompt') ?? '', turnSeq: 0 };
  }
  function startHistoricalResponse(target) {
    if (target.requested || target.status !== 'loading') return;
    target.requested = true;
    const session = state.sessions.find(item => responseKey(item) === target.key);
    if (session) target.session = session;
    else loadSessions({ includeAll: true }).catch(() => {
      if (consoleState.historicalTarget === target) {
        target.sessionLoadError = true;
        renderConsole();
      }
    });
    fetch(`/api/sessions/${encodeURIComponent(target.key)}/responses/${encodeURIComponent(String(target.responseId))}`)
      .then(async response => {
        if (!response.ok) {
          const error = new Error(response.status === 404 ? 'This retained response is no longer available.' : `History unavailable (${response.status}).`);
          error.display = error.message;
          throw error;
        }
        const payload = await response.json(), row = payload?.response;
        if (!row || Number(byId(row, 'id')) !== target.responseId ||
            String(byId(row, 'sessionKey', 'session_key') ?? target.key) !== target.key) {
          const error = new Error('The response did not match this session link.');
          error.display = error.message;
          throw error;
        }
        if (consoleState.historicalTarget !== target) return;
        target.response = row;
        target.status = 'ready';
        const current = state.sessions.find(item => responseKey(item) === target.key);
        if (current) target.session = current;
        if (target.session) consoleState.reading.set(target.key, historicalReading(target.session, row));
      })
      .catch(error => {
        if (consoleState.historicalTarget !== target) return;
        target.status = 'error';
        target.error = error.display || 'This retained response is unavailable.';
        if (consoleState.selectedKey === target.key) fetchReadPosition(target.key, consoleState.selectionVersion);
      })
      .finally(() => {
        if (consoleState.historicalTarget === target) {
          renderConsole();
          renderConsoleHistory();
        }
      });
  }
  function beginConsoleSelection(key, resume, fetchPosition = true) {
    const version = ++consoleState.selectionVersion;
    consoleState.selectionInitialized = Boolean(key);
    consoleState.readResume = resume && key ? { key, version } : null;
    consoleState.readNavigation = null;
    consoleState.readActionNotice = null;
    if (fetchPosition && key) fetchReadPosition(key, version);
    return version;
  }
  function normalizeReadPosition(key, payload) {
    const unreadCount = payload?.unreadCount, retainedCount = payload?.retainedCount;
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'firstUnread') ||
        !Number.isSafeInteger(unreadCount) || unreadCount < 0 ||
        !Number.isSafeInteger(retainedCount) || retainedCount < 0 || unreadCount > retainedCount) {
      throw new Error('Unread position response was incomplete.');
    }
    const firstUnread = payload.firstUnread;
    if ((unreadCount === 0) !== (firstUnread === null)) throw new Error('Unread position response was inconsistent.');
    if (firstUnread !== null) {
      const id = Number(byId(firstUnread, 'id')), ts = Number(byId(firstUnread, 'ts'));
      const rowKey = byId(firstUnread, 'sessionKey', 'session_key');
      const seen = byId(firstUnread, 'seen');
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(ts) ||
          String(rowKey ?? '') !== key || !(seen === false || seen === 0)) {
        throw new Error('Unread position response did not identify a retained unread response.');
      }
    }
    return { firstUnread, unreadCount, retainedCount };
  }
  function updateUnreadCount(key, unreadCount) {
    const index = state.sessions.findIndex(session => responseKey(session) === key);
    if (index >= 0 && Number(byId(state.sessions[index], 'unreadCount', 'unread_count') || 0) !== unreadCount) {
      state.sessions[index] = { ...state.sessions[index], unreadCount };
    }
    const allSession = consoleState.allSessions?.get(key);
    if (allSession) consoleState.allSessions.set(key, { ...allSession, unreadCount });
    const target = consoleState.historicalTarget;
    if (target?.key === key) {
      const current = state.sessions.find(session => responseKey(session) === key);
      if (current) target.session = current;
      else if (target.session) target.session = { ...target.session, unreadCount };
    }
  }
  function displayedReadResponse(key) {
    const target = consoleState.historicalTarget;
    if (target?.key === key) return target.status === 'ready' ? target.response : null;
    return responsesOf(consoleState.reading.get(key))[0] || null;
  }
  function renderReadBoundary() {
    renderComparisonSelection();
    renderSelectiveSend();
    const key = consoleState.selectedKey, entry = key ? consoleState.readPositions.get(key) : null;
    const data = entry?.data, status = $('#console-read-status');
    if (!key) status.textContent = 'Select a session to check retained unread responses.';
    else if (entry?.status === 'loading') status.textContent = 'Checking unread position…';
    else if (entry?.status === 'error') status.textContent = `Unread position unavailable: ${entry.error}`;
    else if (entry?.status === 'ready' && data?.retainedCount === 0) status.textContent = 'No retained response history.';
    else if (entry?.status === 'ready' && data?.unreadCount === 0) status.textContent = `All retained output read · ${data.retainedCount} retained.`;
    else if (entry?.status === 'ready' && data?.firstUnread) {
      status.textContent = `First unread response #${byId(data.firstUnread, 'id')} · ${data.unreadCount} unread · ${data.retainedCount} retained.`;
    } else status.textContent = 'Unread position has not been checked.';

    const next = $('#console-next-unread');
    next.textContent = entry?.status === 'loading' ? 'Checking…' : entry?.status === 'error' ? 'Retry unread check' : 'Next unread';
    next.disabled = !key || entry?.status === 'loading' || entry?.status === 'ready' && !data?.firstUnread;
    const response = displayedReadResponse(key), responseId = Number(byId(response, 'id')), ts = Number(byId(response, 'ts'));
    const seen = byId(response, 'seen'), pending = consoleState.markingResponse;
    const marking = pending?.key === key && pending.id === responseId && pending.selectionVersion === consoleState.selectionVersion;
    const mark = $('#console-mark-response-read');
    mark.textContent = Number.isSafeInteger(responseId) && responseId > 0
      ? seen === true || seen === 1 ? `Response #${responseId} read` : `Mark response #${responseId} read`
      : 'Mark displayed response read';
    mark.disabled = !response || !(Number.isSafeInteger(responseId) && responseId > 0 && Number.isSafeInteger(ts)) ||
      !(seen === false || seen === 0) || Boolean(marking);
    const notice = consoleState.readActionNotice;
    const feedback = $('#console-read-feedback');
    feedback.textContent = notice?.key === key && notice.selectionVersion === consoleState.selectionVersion ? notice.text : '';
    feedback.hidden = !feedback.textContent;
  }
  function nextReadPositionRequest(key) {
    const version = (consoleState.readPositionRequests.get(key) || 0) + 1;
    consoleState.readPositionRequests.set(key, version);
    return version;
  }
  function stopPendingUnreadResume(key, selectionVersion = consoleState.selectionVersion) {
    const resuming = consoleState.readResume?.key === key && consoleState.readResume.version === selectionVersion;
    const navigating = consoleState.readNavigation?.key === key && consoleState.readNavigation.version === selectionVersion;
    if (resuming || navigating) {
      consoleState.readResume = null;
      consoleState.readNavigation = null;
      nextReadPositionRequest(key);
    }
  }
  async function fetchReadPosition(key, selectionVersion = consoleState.selectionVersion) {
    if (!key || consoleState.selectedKey !== key || consoleState.selectionVersion !== selectionVersion) return;
    const requestVersion = nextReadPositionRequest(key);
    const previous = consoleState.readPositions.get(key);
    consoleState.readPositions.set(key, { status: 'loading', data: previous?.data || null, error: '' });
    renderReadBoundary();
    const isCurrent = () => consoleState.selectedKey === key &&
      consoleState.selectionVersion === selectionVersion &&
      consoleState.readPositionRequests.get(key) === requestVersion;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(key)}/read-position`, { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `Unread position unavailable (${response.status}).`);
      const data = normalizeReadPosition(key, payload);
      if (!isCurrent()) return;
      consoleState.readPositions.set(key, { status: 'ready', data, error: '' });
      updateUnreadCount(key, data.unreadCount);
      const resume = consoleState.readResume?.key === key && consoleState.readResume.version === selectionVersion;
      const navigate = consoleState.readNavigation?.key === key && consoleState.readNavigation.version === selectionVersion;
      if (resume) consoleState.readResume = null;
      if (navigate) consoleState.readNavigation = null;
      renderSessions(); renderReadBoundary();
      if (resume && !consoleState.historicalTarget && data.firstUnread) {
        openUnreadResponse(key, data.firstUnread, { automatic: true, selectionVersion });
      } else if (resume && !consoleState.historicalTarget && !data.firstUnread) {
        const current = state.sessions.find(session => responseKey(session) === key);
        if (current) {
          consoleState.reading.set(key, current);
          consoleState.history.delete(key);
          consoleState.scroll.set(key, 0);
          $('.console-pane').scrollTop = 0;
          renderConsole(); renderConsoleHistory();
        }
      } else if (navigate && data.firstUnread) {
        openUnreadResponse(key, data.firstUnread, { automatic: false, selectionVersion });
      }
    } catch (error) {
      if (!isCurrent()) return;
      consoleState.readPositions.set(key, { status: 'error', data: null, error: error.message || 'Request failed.' });
      if (consoleState.readResume?.key === key && consoleState.readResume.version === selectionVersion) consoleState.readResume = null;
      if (consoleState.readNavigation?.key === key && consoleState.readNavigation.version === selectionVersion) consoleState.readNavigation = null;
      renderReadBoundary();
    }
  }
  function openUnreadResponse(key, response, { automatic = false, selectionVersion = consoleState.selectionVersion } = {}) {
    const id = Number(byId(response, 'id')), ts = Number(byId(response, 'ts'));
    if (consoleState.selectedKey !== key || consoleState.selectionVersion !== selectionVersion ||
        !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(ts) ||
        String(byId(response, 'sessionKey', 'session_key') ?? '') !== key) return;
    selectConsoleSession(key, !automatic && consoleState.historicalTarget?.key === key, id, null, { resume: false, fetchPosition: false });
  }
  async function markDisplayedResponseRead() {
    const key = consoleState.selectedKey, selectionVersion = consoleState.selectionVersion;
    const response = displayedReadResponse(key), id = Number(byId(response, 'id')), ts = Number(byId(response, 'ts'));
    const seen = byId(response, 'seen');
    if (!key || !response || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(ts) ||
        !(seen === false || seen === 0)) return;
    stopPendingUnreadResume(key, selectionVersion);
    const operation = { key, id, selectionVersion };
    consoleState.markingResponse = operation;
    consoleState.readActionNotice = null;
    renderReadBoundary();
    try {
      const result = await postJson(`/api/sessions/${encodeURIComponent(key)}/responses/${encodeURIComponent(String(id))}/seen`, { ts });
      const payload = await result.json().catch(() => null);
      if (!result.ok) {
        const message = result.status === 409 ? 'This response changed since it was displayed; it was not marked read.' :
          result.status === 404 ? 'This retained response is no longer available; it was not marked read.' :
          payload?.error || `Response #${id} could not be marked read (${result.status}).`;
        throw new Error(message);
      }
      if (consoleState.selectedKey !== key || consoleState.selectionVersion !== selectionVersion) return;
      if (payload?.ok !== true || responseKey(payload?.session || {}) !== key) throw new Error('The response acknowledgement could not be confirmed.');
      const target = consoleState.historicalTarget;
      if (target?.key === key) {
        if (target.response && Number(byId(target.response, 'id')) === id && Number(byId(target.response, 'ts')) === ts) {
          target.response = { ...target.response, seen: true };
        }
      }
      const reading = consoleState.reading.get(key);
      if (reading) consoleState.reading.set(key, {
        ...reading, lastResponses: responsesOf(reading).map(row =>
          Number(byId(row, 'id')) === id && Number(byId(row, 'ts')) === ts ? { ...row, seen: true } : row),
      });
      consoleState.readActionNotice = { key, selectionVersion, text: `Response #${id} marked read. Viewing output never acknowledges it.` };
      renderSessions();
      // A later SSE may already have arrived while this acknowledgement was in flight.
      // Keep its live session state and reconcile unread counts with a fresh versioned read.
      fetchReadPosition(key, selectionVersion);
    } catch (error) {
      if (consoleState.selectedKey !== key || consoleState.selectionVersion !== selectionVersion) return;
      consoleState.readActionNotice = { key, selectionVersion, text: error.message || 'The response was not marked read.' };
      renderReadBoundary();
      fetchReadPosition(key, selectionVersion);
    } finally {
      if (consoleState.markingResponse === operation) {
        consoleState.markingResponse = null;
        if (consoleState.selectedKey === key && consoleState.selectionVersion === selectionVersion) renderReadBoundary();
      }
    }
  }
  function nextUnreadResponse() {
    const key = consoleState.selectedKey, selectionVersion = consoleState.selectionVersion;
    if (!key) return;
    consoleState.readNavigation = { key, version: selectionVersion };
    fetchReadPosition(key, selectionVersion);
  }
  function comparisonSelection() {
    const key = consoleState.selectedKey, response = displayedReadResponse(key);
    if (!response || byId(response, 'sessionKey', 'session_key') !== key) return null;
    const session = state.sessions.find(item => responseKey(item) === key) ||
      consoleState.historicalTarget?.session || consoleState.reading.get(key);
    return { key, response, session };
  }
  function renderComparisonSelection() {
    const selected = comparisonSelection();
    for (const button of document.querySelectorAll('[data-comparison-set]')) button.disabled = !selected;
    $('#comparison-selection').textContent = selected
      ? `Selected response #${byId(selected.response, 'id')} · ${nameOf(selected.session || selected.response)}. Set A or B to capture exactly this output.`
      : 'Select a session or open an exact response from Search outputs, then set either side.';
  }
  function setComparison(side) {
    const selected = comparisonSelection();
    if (!selected) return;
    const { key, response, session } = selected;
    comparisonSlots[side] = {
      key, id: byId(response, 'id'), ts: byId(response, 'ts'), text: String(byId(response, 'text') ?? ''),
      name: nameOf(session || response),
      project: byId(session, 'project') ?? consoleState.historicalTarget?.result?.project ?? '',
      host: byId(response, 'host') ?? byId(session, 'host') ?? '',
      account: byId(response, 'accountAlias', 'account_alias') ?? byId(session, 'accountAlias', 'account_alias') ?? '',
      harness: byId(response, 'harness') ?? byId(session, 'harness') ?? '',
    };
    renderComparisonSide(side);
  }
  function renderComparisonSide(side) {
    const snapshot = comparisonSlots[side], label = side.toUpperCase();
    const slot = $(`#comparison-${side}`), body = $(`#comparison-${side}-body`), source = $(`#comparison-${side}-source`);
    $(`#comparison-${side}-status`).textContent = '';
    $(`[data-comparison-copy="${side}"]`).disabled = !snapshot;
    $(`[data-comparison-clear="${side}"]`).disabled = !snapshot;
    if (!snapshot) {
      delete slot.dataset.responseId; delete slot.dataset.sessionKey;
      $(`#comparison-${side}-title`).textContent = label;
      source.textContent = 'No response selected.';
      body.textContent = `Open a retained response, then set ${label}.`;
    } else {
      slot.dataset.responseId = String(snapshot.id); slot.dataset.sessionKey = snapshot.key;
      $(`#comparison-${side}-title`).textContent = `${label} · ${snapshot.name}`;
      const date = new Date(snapshot.ts);
      const timestamp = Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable';
      source.textContent = `Project: ${snapshot.project || 'Unassigned'} · Machine: ${snapshot.host || 'Unknown'} · Account: ${snapshot.account || 'Unassigned'} · Harness: ${snapshot.harness || 'Unknown'} · Response #${snapshot.id} · ${timestamp} · Session: ${snapshot.key}`;
      appendMarkdown(body, snapshot.text);
      $(`#comparison-${side}-status`).textContent = 'Frozen output and identity at capture. Reload clears comparison.';
    }
    body.scrollTop = 0; body.scrollLeft = 0;
  }
  async function copyComparison(side) {
    const snapshot = comparisonSlots[side];
    if (!snapshot) return;
    let message;
    try { await navigator.clipboard.writeText(snapshot.text); message = `Copied ${side.toUpperCase()}'s original Markdown.`; }
    catch { message = 'Clipboard unavailable. Select and copy the output manually.'; }
    if (comparisonSlots[side] === snapshot) $(`#comparison-${side}-status`).textContent = message;
  }
  function selectiveSnapshot(session) {
    const key = responseKey(session), capability = messageCapability(session);
    const identity = `${nameOf(session)} · Project: ${byId(session, 'project') || 'Unassigned'} · ${identityText(session)} · Session: ${key}`;
    return { key, identity, turn: Number(byId(session, 'turnSeq', 'turn_seq')), capability };
  }
  function updateSelectiveReceipt(key) {
    const target = selectiveSendState.targets.get(key);
    if (!target?.replyId) return;
    target.receipt = (state.replyStates.get(key) || []).find(reply => reply.id === target.replyId) || null;
    target.observedAt = Date.now();
    renderSelectiveSend();
  }
  function renderSelectiveSend() {
    const { phase, targets } = selectiveSendState, editing = phase === 'draft';
    const selected = state.sessions.find(session => responseKey(session) === consoleState.selectedKey);
    const add = $('#selective-add');
    add.disabled = !editing || !selected || targets.has(consoleState.selectedKey);
    add.textContent = selected ? `Add ${nameOf(selected)}` : 'Add current session';
    add.title = selected ? identityText(selected) : 'Select an available session first.';
    $('#selective-prompt').readOnly = !editing;
    $('#selective-preview').hidden = !editing;
    $('#selective-preview').disabled = !state.repliesEnabled || !targets.size || !$('#selective-prompt').value.trim();
    $('#selective-confirm').hidden = phase !== 'preview';
    $('#selective-confirm').disabled = !state.repliesEnabled;
    $('#selective-confirm').textContent = `Queue prompt to these ${targets.size} targets`;
    $('#selective-edit').hidden = phase !== 'preview';
    $('#selective-new').hidden = phase !== 'complete';
    $('#selective-refresh').hidden = ![...targets.values()].some(target => target.replyId);
    const list = $('#selective-targets'), existing = new Map([...list.children].map(row => [row.dataset.key, row]));
    for (const [key, row] of existing) if (!targets.has(key)) row.remove();
    for (const [key, target] of targets) {
      let row = existing.get(key);
      if (!row) {
        row = el('li', 'selective-target'); row.dataset.key = key;
        const identity = el('strong', 'selective-target-identity'), capability = el('p', 'selective-target-capability');
        const result = el('p', 'selective-target-result'); result.setAttribute('role', 'status');
        const actions = el('div', 'selective-target-actions');
        const open = el('button', 'button button-secondary', 'Open session'); open.type = 'button';
        open.addEventListener('click', () => selectConsoleSession(key));
        const remove = el('button', 'button button-secondary selective-remove', 'Remove target'); remove.type = 'button';
        remove.addEventListener('click', () => {
          if (selectiveSendState.phase !== 'draft') return;
          selectiveSendState.targets.delete(key); renderSelectiveSend();
        });
        actions.append(open, remove); row.append(identity, capability, result, actions); list.append(row);
      }
      row.querySelector('.selective-target-identity').textContent = target.snapshot.identity;
      row.querySelector('.selective-target-capability').textContent = `Preview turn ${target.snapshot.turn} · Message ${target.snapshot.capability.status}: ${target.snapshot.capability.reason}`;
      row.querySelector('.selective-remove').disabled = !editing;
      row.dataset.outcome = target.outcome || '';
      let result = phase === 'preview' ? 'Ready for explicit confirmation; nothing sent.' : 'Explicitly selected; nothing sent.';
      if (target.replyId) {
        const [label, detail] = target.receipt ? replyDeliveryLabel(target.receipt) : ['Unknown', 'This receipt is not in the returned recent history; check the session before resubmitting.'];
        result = `Reply #${target.replyId} · ${label}. ${detail}${target.observedAt ? ` Last observed ${new Date(target.observedAt).toLocaleTimeString()}.` : ''}`;
      } else if (target.outcome === 'sending') result = 'Submitting once; acceptance has not been confirmed.';
      else if (target.message) result = target.message;
      row.querySelector('.selective-target-result').textContent = result;
    }
    $('#selective-status').textContent = phase === 'draft'
      ? `${targets.size} explicitly selected. Filters and live events never add targets.`
      : phase === 'preview' ? 'Review every identity, capability, turn and the read-only prompt above. Confirmation submits each target independently.'
        : phase === 'sending' ? `Submitting independently: ${selectiveSendState.submitted} of ${targets.size} attempted. No automatic retries.`
          : 'Submission finished; individual delivery receipts remain separate. No automatic retry was made. Resolve unknown outcomes in the session history before starting another batch.';
  }
  function addSelectiveTarget() {
    if (selectiveSendState.phase !== 'draft') return;
    const session = state.sessions.find(item => responseKey(item) === consoleState.selectedKey);
    if (!session || selectiveSendState.targets.has(responseKey(session))) return;
    selectiveSendState.targets.set(responseKey(session), { snapshot: selectiveSnapshot(session), replyId: null, receipt: null, outcome: '', message: '' });
    renderSelectiveSend();
  }
  function previewSelectiveSend() {
    if (selectiveSendState.phase !== 'draft' || !state.repliesEnabled || !selectiveSendState.targets.size) return;
    const text = $('#selective-prompt').value.trim();
    if (!text) return;
    for (const [key, target] of selectiveSendState.targets) {
      const current = state.sessions.find(session => responseKey(session) === key);
      if (current) target.snapshot = selectiveSnapshot(current);
    }
    selectiveSendState.text = text; $('#selective-prompt').value = text;
    selectiveSendState.phase = 'preview'; renderSelectiveSend(); $('#selective-confirm').focus();
  }
  async function confirmSelectiveSend() {
    if (selectiveSendState.phase !== 'preview' || !state.repliesEnabled) return;
    selectiveSendState.phase = 'sending'; renderSelectiveSend();
    for (const [key, target] of selectiveSendState.targets) {
      const { snapshot } = target;
      const current = state.sessions.find(session => responseKey(session) === key);
      if (!snapshot.capability.allowed || !Number.isSafeInteger(snapshot.turn) || snapshot.turn < 0 ||
        (current && selectiveSnapshot(current).identity !== snapshot.identity)) {
        target.outcome = 'rejected';
        target.message = 'Not submitted: the preview capability is unavailable or its identity/version is invalid or changed. Make a new selection after checking this session.';
      } else {
        target.outcome = 'sending'; renderSelectiveSend();
        try {
          const response = await postJson(`/api/sessions/${encodeURIComponent(key)}/reply`, { text: selectiveSendState.text, expectedTurn: snapshot.turn });
          const payload = await response.json().catch(() => null);
          if (response.ok && payload?.ok === true && Number.isSafeInteger(payload.replyId) && payload.replyId > 0) {
            target.replyId = payload.replyId; target.outcome = 'accepted';
            target.receipt = (state.replyStates.get(key) || []).find(reply => reply.id === payload.replyId) || { id: payload.replyId, state: 'queued' };
            refreshReplyList(key);
          } else if (response.status >= 400 && response.status < 500) {
            target.outcome = 'rejected';
            target.message = `Rejected (${payload?.reason || payload?.error || response.status}). Nothing queued by this request; no retry was made.`;
          } else {
            target.outcome = 'unknown';
            target.message = 'Acceptance unknown: the response did not confirm a receipt. The request may have queued; no retry was made. Check this session before submitting again.';
          }
        } catch {
          target.outcome = 'unknown';
          target.message = 'Acceptance unknown after a network failure. The request may have queued; no retry was made. Check this session before submitting again.';
        }
      }
      selectiveSendState.submitted++; renderSelectiveSend();
    }
    selectiveSendState.phase = 'complete'; renderSelectiveSend();
  }
  function outputSearchFilterParams() {
    const params = new URLSearchParams();
    const project = $('#project-filter').value, account = $('#account-filter').value;
    const repositoryFilter = project ? repositorySearchFilter(project) : null;
    if (repositoryFilter) for (const [key, value] of Object.entries(repositoryFilter)) params.set(key, value);
    if ($('#host-filter').value) params.set('host', $('#host-filter').value);
    if (account) params.set('account', JSON.parse(account));
    if ($('#harness-filter').value) params.set('harness', $('#harness-filter').value);
    params.set('headless', $('#headless-filter').checked ? '1' : '0');
    params.set('ended', $('#ended-filter').checked ? '1' : '0');
    return params;
  }
  function outputSearchStatusText() {
    if (outputSearchState.status === 'loading') return 'Searching retained output…';
    if (outputSearchState.status === 'error') return outputSearchState.error || 'Output search is unavailable.';
    if (outputSearchState.status === 'stale') return outputSearchState.error || 'Search again to apply the current query and filters.';
    if (outputSearchState.status === 'empty' || outputSearchState.status === 'idle') return 'Enter a phrase to search retained output.';
    if (!outputSearchState.results.length) return `No retained output matched “${outputSearchState.query}”.`;
    const count = outputSearchState.results.length;
    return `${count} result${count === 1 ? '' : 's'} loaded${outputSearchState.nextCursor ? '. More results are available.' : '.'}`;
  }
  function renderOutputSearch() {
    const list = $('#output-search-results');
    list.replaceChildren();
    for (const result of outputSearchState.results) {
      const item = el('li', 'output-search-result'), meta = el('div', 'output-search-meta');
      const name = String(result.displayName || 'Session');
      meta.append(
        el('strong', 'output-search-name', name),
        el('span', '', String(result.project || 'Unassigned project')),
        el('span', '', String(result.host || 'Unknown machine')),
        el('span', '', String(result.accountAlias || 'Unassigned account')),
        el('span', '', result.harness === 'omp' ? 'OMP' : 'Claude Code'),
        el('span', 'output-search-match', result.match === 'identity' ? 'Session identity' : 'Response text'),
      );
      const ts = Number(result.ts), date = new Date(ts);
      const time = el('time', '', Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable');
      if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
      meta.append(time);
      item.append(meta, el('p', 'output-search-excerpt', String(result.excerpt || 'No retained response excerpt.')));
      const exact = result.responseId !== null && result.responseId !== undefined;
      const open = el('button', 'output-search-open');
      open.type = 'button';
      open.append(el('strong', '', exact ? `Open response ${String(result.responseId)}` : 'Open session'));
      open.addEventListener('click', () => openOutputSearchResult(result));
      item.append(open);
      list.append(item);
    }
    const status = $('#output-search-status');
    status.dataset.state = outputSearchState.status === 'error' ? 'error' : '';
    status.textContent = outputSearchStatusText();
    const more = $('#output-search-more');
    more.hidden = !outputSearchState.nextCursor;
    more.disabled = outputSearchState.loading;
    more.textContent = outputSearchState.loading ? 'Loading…' : 'Load more results';
  }
  function invalidateOutputSearch(message) {
    outputSearchState.version++;
    outputSearchState.query = '';
    outputSearchState.filters = '';
    outputSearchState.results = [];
    outputSearchState.nextCursor = null;
    outputSearchState.loading = false;
    outputSearchState.status = 'stale';
    outputSearchState.error = message;
    renderOutputSearch();
  }
  async function runOutputSearch(loadMore = false) {
    if (loadMore && (!outputSearchState.nextCursor || outputSearchState.loading)) return;
    if (loadMore && ($('#output-search-query').value.trim() !== outputSearchState.query ||
        outputSearchFilterParams().toString() !== outputSearchState.filters)) {
      invalidateOutputSearch('Query or filters changed. Search again to view matching output.');
      return;
    }
    if (!loadMore) {
      outputSearchState.version++;
      outputSearchState.query = $('#output-search-query').value.trim();
      outputSearchState.filters = outputSearchFilterParams().toString();
      outputSearchState.results = [];
      outputSearchState.nextCursor = null;
      outputSearchState.error = '';
      if (!outputSearchState.query) {
        outputSearchState.loading = false;
        outputSearchState.status = 'empty';
        renderOutputSearch();
        return;
      }
    }
    const version = outputSearchState.version, params = new URLSearchParams(outputSearchState.filters);
    params.set('q', outputSearchState.query);
    params.set('limit', '25');
    if (loadMore) params.set('cursor', outputSearchState.nextCursor);
    outputSearchState.loading = true;
    outputSearchState.status = 'loading';
    outputSearchState.error = '';
    renderOutputSearch();
    try {
      const response = await fetch(`/api/search?${params}`);
      if (version !== outputSearchState.version) return;
      if (!response.ok) {
        outputSearchState.status = 'error';
        outputSearchState.error = `Output search unavailable (${response.status}).`;
        return;
      }
      const payload = await response.json();
      if (version !== outputSearchState.version) return;
      if (!Array.isArray(payload?.results)) throw new Error('invalid response');
      const known = new Set(outputSearchState.results.map(row => JSON.stringify([row.key, row.responseId])));
      for (const row of payload.results) {
        const identity = JSON.stringify([row.key, row.responseId]);
        if (!known.has(identity)) {
          outputSearchState.results.push(row);
          known.add(identity);
        }
      }
      outputSearchState.nextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null;
      outputSearchState.status = 'ready';
    } catch {
      if (version !== outputSearchState.version) return;
      outputSearchState.status = 'error';
      outputSearchState.error = 'Output search is unavailable. Try again.';
    } finally {
      if (version === outputSearchState.version) {
        outputSearchState.loading = false;
        renderOutputSearch();
      }
    }
  }
  function openOutputSearchResult(result) {
    const key = String(result.key ?? '');
    if (!key) return;
    setFeedView('console');
    if (result.responseId === null || result.responseId === undefined) {
      selectConsoleSession(key);
      if (!state.sessions.some(session => responseKey(session) === key)) loadSessions({ includeAll: true }).catch(() => {
        if (consoleState.selectedKey === key) $('#console-selection-status').textContent = 'Selected session could not be loaded; the search result may be out of date.';
      });
      return;
    }
    const responseId = Number(result.responseId);
    if (!Number.isSafeInteger(responseId) || responseId < 1) {
      $('#output-search-status').textContent = 'This result has an invalid response link.';
      return;
    }
    selectConsoleSession(key, true, responseId, result);
  }
  function applyConsoleColumns() {
    for (const input of document.querySelectorAll('[data-console-column]')) {
      for (const cell of document.querySelectorAll(`#console-view [data-column="${input.dataset.consoleColumn}"]`)) cell.hidden = !input.checked;
    }
    const columns = 2 + document.querySelectorAll('[data-console-column]:checked').length;
    for (const heading of document.querySelectorAll('.console-group th')) heading.colSpan = columns;
  }
  function saveConsolePreferences() {
    const density = $('#console-density').value;
    $('#console-view').dataset.density = density; applyConsoleColumns();
    try { localStorage.setItem('dash.console', JSON.stringify({ density,
      columns: [...document.querySelectorAll('[data-console-column]')].filter(input => input.checked).map(input => input.dataset.consoleColumn) })); } catch {}
  }
  function loadConsolePreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem('dash.console') || '{}');
      if (['compact', 'comfortable'].includes(saved.density)) $('#console-density').value = saved.density;
      if (Array.isArray(saved.columns)) for (const input of document.querySelectorAll('[data-console-column]')) input.checked = saved.columns.includes(input.dataset.consoleColumn);
    } catch {}
    $('#console-view').dataset.density = $('#console-density').value; applyConsoleColumns();
  }
  const consoleConfigKeys = ['search', 'host', 'project', 'account', 'harness', 'status', 'headless', 'ended', 'group', 'density', 'columns'];
  const consoleConfigSignature = config => JSON.stringify(consoleConfigKeys.map(key => config[key]));
  const copyConsoleConfig = config => ({ ...config, columns: [...config.columns] });
  function validConsoleConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).length !== consoleConfigKeys.length || consoleConfigKeys.some(key => !Object.hasOwn(config, key))) return false;
    return typeof config.search === 'string' && config.search.length <= 1024 &&
      typeof config.host === 'string' && config.host.length <= 1024 &&
      (config.project === null || typeof config.project === 'string' && config.project.length <= 1024) &&
      (config.account === null || typeof config.account === 'string' && config.account.length <= 1024) &&
      ['','claude','omp'].includes(config.harness) &&
      ['','needs_input','your_turn','working','ended','unread','unknown'].includes(config.status) &&
      typeof config.headless === 'boolean' && typeof config.ended === 'boolean' &&
      ['','project','host','account','harness'].includes(config.group) &&
      ['compact','comfortable'].includes(config.density) && Array.isArray(config.columns) &&
      config.columns.every(column => ['project','host','account','harness','age'].includes(column)) &&
      new Set(config.columns).size === config.columns.length && (config.status !== 'ended' || config.ended);
  }
  function validateConsolePreferences(snapshot) {
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      !Array.isArray(snapshot.pins) || snapshot.pins.length > 1000 || !Array.isArray(snapshot.views) || snapshot.views.length > 100 ||
      snapshot.pins.some(key => typeof key !== 'string' || key.length > 2048) || new Set(snapshot.pins).size !== snapshot.pins.length ||
      snapshot.views.some(view => !view || typeof view.id !== 'string' || typeof view.name !== 'string' ||
        view.name.trim().length === 0 || view.name.length > 80 || /[\u0000-\u001f\u007f]/.test(view.name) || !validConsoleConfig(view.config)) ||
      new Set(snapshot.views.map(view => view.id)).size !== snapshot.views.length) {
      throw new Error('Saved preferences returned an invalid response.');
    }
    return snapshot;
  }
  function renderConsolePreferences() {
    const selector = $('#console-view-select'), selectedView = consolePreferences.views.find(view => view.id === consolePreferences.selectedViewId);
    if (consolePreferences.selectedViewId && !selectedView) {
      consolePreferences.selectedViewId = null;
      consolePreferences.appliedViewConfig = null;
      consolePreferences.viewChangedElsewhere = false;
      consolePreferences.notice = 'The selected view was deleted elsewhere. Current filters and session selection were kept.';
      consolePreferences.renameDraftViewId = null;
      consolePreferences.renameDraft = '';
    }
    const currentView = consolePreferences.views.find(view => view.id === consolePreferences.selectedViewId);
    if (currentView && consolePreferences.renameDraftViewId !== currentView.id) {
      consolePreferences.renameDraftViewId = currentView.id;
      consolePreferences.renameDraft = currentView.name;
    } else if (!currentView) {
      consolePreferences.renameDraftViewId = null;
      consolePreferences.renameDraft = '';
    }
    const currentCapture = currentView ? captureConsoleViewConfig() : null;
    const hasUnsavedControls = Boolean(currentView && consolePreferences.appliedViewConfig && currentCapture?.config &&
      consoleConfigSignature(currentCapture.config) !== consoleConfigSignature(consolePreferences.appliedViewConfig));
    const options = [['', 'Custom'], ...consolePreferences.views.map(view => [view.id, view.name])];
    const signature = JSON.stringify(options);
    if (selector.dataset.options !== signature) {
      selector.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
      selector.dataset.options = signature;
    }
    selector.value = consolePreferences.selectedViewId || '';
    const canEdit = Boolean(currentView);
    const busy = consolePreferences.writing;
    $('#console-view-apply').disabled = busy || !canEdit;
    $('#console-view-create-name').disabled = busy;
    $('#console-view-create').disabled = busy;
    $('#console-view-name').disabled = busy || !canEdit;
    $('#console-view-rename').disabled = busy || !canEdit;
    $('#console-view-update').disabled = busy || !canEdit;
    $('#console-view-delete').disabled = busy || !canEdit;
    $('#console-pins-refresh').disabled = consoleState.pinInventoryLoading;
    $('#console-view-name').value = currentView ? consolePreferences.renameDraft : '';
    const status = $('#console-preferences-status');
    if (consolePreferences.error) {
      status.dataset.state = 'error';
      const message = consolePreferences.errorSource === 'write'
        ? `Saved preference change failed${consolePreferences.loaded ? `; keeping revision ${consolePreferences.revision}` : ''}.`
        : consolePreferences.errorSource === 'stream'
          ? `Could not read a shared preferences update${consolePreferences.loaded ? `; keeping revision ${consolePreferences.revision}` : ''}.`
          : consolePreferences.loaded
            ? `Could not refresh shared preferences; keeping revision ${consolePreferences.revision}.`
            : 'Saved views and pins are unavailable.';
      status.textContent = `${message} ${consolePreferences.error}`;
    } else if (consolePreferences.viewChangedElsewhere) {
      status.dataset.state = 'notice';
      status.textContent = 'This saved view changed elsewhere. Current filters and session selection were kept.';
    } else if (currentView && currentCapture?.error) {
      status.dataset.state = 'notice';
      status.textContent = currentCapture.error;
    } else if (hasUnsavedControls) {
      status.dataset.state = 'notice';
      status.textContent = 'Current controls differ from this saved view. Use Update from current filters to save them.';
    } else if (consolePreferences.notice) {
      status.dataset.state = 'notice';
      status.textContent = consolePreferences.notice;
    } else if (consolePreferences.loading && !consolePreferences.loaded) {
      status.dataset.state = '';
      status.textContent = 'Loading saved views and pins…';
    } else if (consolePreferences.writing) {
      status.dataset.state = '';
      status.textContent = 'Saving shared preferences…';
    } else if (consolePreferences.loaded) {
      status.dataset.state = '';
      status.textContent = `Shared views and pins · revision ${consolePreferences.revision}.`;
    } else {
      status.dataset.state = '';
      status.textContent = 'Saved views and pins have not loaded.';
    }
    $('#console-pins-count').textContent = String(consolePreferences.pins.length);
    renderPinnedSessions();
    updateConsolePinButtons();
  }
  function acceptConsolePreferences(untrustedSnapshot, source, expectedConfig = null) {
    const snapshot = validateConsolePreferences(untrustedSnapshot);
    if (snapshot.revision < consolePreferences.revision || snapshot.revision === consolePreferences.revision && consolePreferences.loaded) return false;
    const previous = consolePreferences.views.find(view => view.id === consolePreferences.selectedViewId);
    const incoming = snapshot.views.find(view => view.id === consolePreferences.selectedViewId);
    if (snapshot.revision > consolePreferences.revision && previous && incoming &&
      consoleConfigSignature(previous.config) !== consoleConfigSignature(incoming.config)) {
      const expectedLocalUpdate = source === 'write' && expectedConfig &&
        consoleConfigSignature(incoming.config) === consoleConfigSignature(expectedConfig);
      if (expectedLocalUpdate) consolePreferences.viewChangedElsewhere = false;
      else consolePreferences.viewChangedElsewhere = true;
    }
    if (previous && incoming && consolePreferences.renameDraftViewId === previous.id && consolePreferences.renameDraft === previous.name) {
      consolePreferences.renameDraft = incoming.name;
    }
    consolePreferences.revision = snapshot.revision;
    consolePreferences.pins = [...snapshot.pins];
    consolePreferences.views = snapshot.views.map(view => ({ ...view, config: copyConsoleConfig(view.config) }));
    consolePreferences.loaded = true;
    consolePreferences.error = '';
    consolePreferences.errorSource = '';
    renderConsolePreferences();
    return true;
  }
  async function loadConsolePreferencesRemote() {
    const version = ++consolePreferences.fetchVersion;
    consolePreferences.loading = true;
    renderConsolePreferences();
    try {
      const response = await fetch('/api/console/preferences', { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `Saved preferences could not be loaded (${response.status}).`);
      validateConsolePreferences(payload);
      const accepted = acceptConsolePreferences(payload, 'refresh');
      if (accepted || version === consolePreferences.fetchVersion) {
        consolePreferences.error = '';
        consolePreferences.errorSource = '';
      }
    } catch (error) {
      if (version === consolePreferences.fetchVersion) {
        consolePreferences.error = error.message || 'Saved preferences could not be loaded.';
        consolePreferences.errorSource = 'refresh';
      }
    } finally {
      if (version === consolePreferences.fetchVersion) {
        consolePreferences.loading = false;
        renderConsolePreferences();
      }
    }
  }
  async function mutateConsolePreferences(body) {
    if (consolePreferences.writing) {
      consolePreferences.error = 'Another shared preference change is still in progress. Try again.';
      consolePreferences.errorSource = 'write';
      renderConsolePreferences();
      return null;
    }
    consolePreferences.writing = true;
    consolePreferences.error = '';
    consolePreferences.errorSource = '';
    consolePreferences.notice = '';
    renderConsolePreferences();
    try {
      const response = await postJson('/api/console/preferences', body);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `Saved preferences could not be changed (${response.status}).`);
      const expectedConfig = body.action === 'update' && body.id === consolePreferences.selectedViewId ? body.config : null;
      acceptConsolePreferences(payload, 'write', expectedConfig);
      consolePreferences.error = '';
      consolePreferences.errorSource = '';
      return payload;
    } catch (error) {
      consolePreferences.error = error.message || 'Saved preferences could not be changed.';
      consolePreferences.errorSource = 'write';
      return null;
    } finally {
      consolePreferences.writing = false;
      renderConsolePreferences();
    }
  }
  function captureConsoleViewConfig() {
    const status = $('#status-filter').value;
    if (status === 'ended' && !$('#ended-filter').checked) return { error: 'The Ended state filter requires Show ended. Enable it before saving.' };
    const project = $('#project-filter').value, account = $('#account-filter').value;
    try {
      return { config: {
        search: $('#session-search').value, host: $('#host-filter').value,
        project: project ? legacyProjectName(project) ?? project : null, account: account ? JSON.parse(account) : null,
        harness: $('#harness-filter').value, status, headless: $('#headless-filter').checked,
        ended: $('#ended-filter').checked, group: $('#group-filter').value,
        density: $('#console-density').value,
        columns: [...document.querySelectorAll('[data-console-column]:checked')].map(input => input.dataset.consoleColumn),
      } };
    } catch {
      return { error: 'The current project or account filter could not be saved. Choose that filter again before saving.' };
    }
  }
  function ensureConsoleFilterOption(dimension, value) {
    const select = $(`#${dimension}-filter`), optionValue = dimension === 'host' ? value : projectOptionValue(dimension, value);
    if (!optionValue || [...select.options].some(option => option.value === optionValue)) return;
    select.add(new Option(optionValue.startsWith('[') ? 'Saved repository filter (not currently available)' : `${dimensionLabel(dimension, value)} (unavailable)`, optionValue));
  }
  // A saved project value is either a legacy plain name or a repository identity (JSON array text).
  const projectOptionValue = (dimension, value) => dimension === 'project' && typeof value === 'string' && value.startsWith('[') && legacyProjectName(value) === null ? value : JSON.stringify(value);
  function applyConsoleView(id) {
    const view = consolePreferences.views.find(item => item.id === id);
    if (!view) {
      consolePreferences.notice = 'That saved view is no longer available. Current filters were kept.';
      renderConsolePreferences();
      return;
    }
    const config = view.config;
    consolePreferences.selectedViewId = view.id;
    consolePreferences.appliedViewConfig = copyConsoleConfig(config);
    consolePreferences.viewChangedElsewhere = false;
    consolePreferences.notice = `Applied “${view.name}”. Session selection and reply drafts were kept.`;
    if (consoleState.selectedKey) consoleState.inventorySelection = consoleState.selectedKey;
    if (!consoleState.selectedKey) consoleState.preserveEmptySelection = true;
    ensureConsoleFilterOption('host', config.host);
    if (config.project !== null) ensureConsoleFilterOption('project', config.project);
    if (config.account !== null) ensureConsoleFilterOption('account', config.account);
    $('#session-search').value = config.search;
    $('#host-filter').value = config.host;
    $('#project-filter').value = config.project === null ? '' : projectOptionValue('project', config.project);
    $('#account-filter').value = config.account === null ? '' : JSON.stringify(config.account);
    $('#harness-filter').value = config.harness;
    $('#status-filter').value = config.status;
    $('#headless-filter').checked = config.headless;
    $('#ended-filter').checked = config.ended;
    invalidateOutputSearch('Session source filters changed. Search again to apply them to output.');
    $('#group-filter').value = config.group;
    $('#console-density').value = config.density;
    for (const input of document.querySelectorAll('[data-console-column]')) input.checked = config.columns.includes(input.dataset.consoleColumn);
    refreshSessionFilters();
    saveConsolePreferences();
    renderSessions();
    refreshVisibleReplyLists();
    renderConsolePreferences();
    loadTimeline(false).catch(() => {});
    loadSessions({ includeAll: Boolean(consoleState.selectedKey) }).catch(error => {
      consolePreferences.notice = `View applied, but sessions could not be refreshed: ${error.message || 'request failed'}.`;
      renderConsolePreferences();
    });
  }
  async function toggleConsolePin(key, pinned) {
    if (!key || consolePreferences.writing) return;
    if (pinned && !state.sessions.some(session => responseKey(session) === key) && !consoleState.allSessions?.has(key)) {
      if (consoleState.allSessions && !consoleState.pinInventoryError) {
        consolePreferences.notice = `Cannot pin unavailable session ${key}.`;
        renderConsolePreferences();
        return;
      }
      consoleState.pinInventoryLoading = true;
      consoleState.pinInventoryError = '';
      renderConsolePreferences();
      try {
        const refreshed = await loadSessions({ includeAll: true });
        if (!refreshed) throw new Error('A newer session refresh replaced the availability check.');
      } catch (error) {
        consoleState.pinInventoryError = error.message || 'Session availability could not be checked.';
        renderConsolePreferences();
        return;
      } finally {
        consoleState.pinInventoryLoading = false;
        renderConsolePreferences();
      }
      if (!state.sessions.some(session => responseKey(session) === key) && !consoleState.allSessions?.has(key)) {
        consolePreferences.notice = `Cannot pin unavailable session ${key}.`;
        renderConsolePreferences();
        return;
      }
    }
    await mutateConsolePreferences({ action: 'pin', key, pinned });
    updateConsolePinButtons();
  }
  function refreshPinnedAvailability() {
    if (consoleState.pinInventoryLoading) return;
    consoleState.pinInventoryLoading = true;
    consoleState.pinInventoryError = '';
    if (!consoleState.selectedKey) consoleState.preserveEmptySelection = true;
    renderPinnedSessions();
    renderConsolePreferences();
    loadSessions({ includeAll: true }).then(refreshed => {
      if (!refreshed) throw new Error('A newer session refresh replaced this availability check.');
    }).catch(error => {
      consoleState.pinInventoryError = error.message || 'Pinned session availability could not be checked.';
    }).finally(() => {
      consoleState.pinInventoryLoading = false;
      renderPinnedSessions();
      renderConsolePreferences();
    });
  }
  function renderPinnedSessions() {
    const list = $('#console-pins-list');
    if (!list) return;
    const pins = consolePreferences.pins;
    const status = $('#console-pins-status');
    if (consoleState.pinInventoryLoading) status.textContent = 'Checking retained sessions…';
    else if (consoleState.pinInventoryError) status.textContent = `Availability check failed: ${consoleState.pinInventoryError}`;
    else if (!pins.length) status.textContent = 'No pinned sessions yet. Pin a session from its row or the selected-session toolbar.';
    else if (!consoleState.allSessions) status.textContent = 'Pins not in the current list are unknown until you open them or refresh availability.';
    else status.textContent = 'Unresolved pins are unavailable in the retained session list. Keys remain unchanged.';
    const entries = pins.map(key => {
      const session = state.sessions.find(item => responseKey(item) === key) || consoleState.allSessions?.get(key);
      const unavailable = !session && consoleState.allSessions !== null && !consoleState.pinInventoryError;
      const availability = session ? identityText(session) : unavailable ? 'Unavailable' :
        consoleState.pinInventoryError ? 'Availability unknown · last check failed' : 'Availability unknown';
      const item = el('li', 'console-pin-item');
      const identity = el('div', 'console-pin-identity');
      identity.append(el('strong', 'console-pin-name', session ? nameOf(session) : unavailable ? key : 'Not in current list'));
      identity.append(el('span', `console-pin-availability${unavailable ? ' unavailable' : ''}`, availability));
      identity.append(el('code', 'console-pin-key', key));
      const actions = el('div', 'console-pin-actions');
      const open = el('button', 'button button-secondary', 'Open');
      open.type = 'button';
      open.disabled = consoleState.pinInventoryLoading;
      open.setAttribute('aria-label', `Open pinned session ${session ? nameOf(session) : key}; session key ${key}`);
      open.addEventListener('click', () => selectInventorySession(key));
      const unpin = el('button', 'button button-secondary', 'Unpin');
      unpin.type = 'button';
      unpin.disabled = consolePreferences.writing;
      unpin.setAttribute('aria-label', `Unpin session key ${key}`);
      unpin.addEventListener('click', () => toggleConsolePin(key, false));
      actions.append(open, unpin);
      item.append(identity, actions);
      return item;
    });
    if (!entries.length) entries.push(el('li', 'console-pins-empty', 'Pinned sessions will appear here.'));
    list.replaceChildren(...entries);
  }
  function updateConsolePinButtons() {
    const key = consoleState.selectedKey, current = state.sessions.find(session => responseKey(session) === key);
    const selectedButton = $('#console-pin-selected');
    const selectedPinned = Boolean(key && consolePreferences.pins.includes(key));
    selectedButton.textContent = selectedPinned ? 'Unpin selected' : 'Pin selected';
    selectedButton.setAttribute('aria-pressed', String(selectedPinned));
    selectedButton.setAttribute('aria-label', key
      ? `${selectedPinned ? 'Unpin' : 'Pin'} selected session ${current ? nameOf(current) : key}; session key ${key}`
      : 'Pin selected session; no session selected');
    selectedButton.disabled = consolePreferences.writing || !key || consoleState.pinInventoryLoading && !selectedPinned && !current ||
      !selectedPinned && !current && consoleState.allSessions !== null && !consoleState.allSessions.has(key) && !consoleState.pinInventoryError;
    for (const row of $('#console-rows').querySelectorAll('[data-key]')) {
      const rowKey = row.dataset.key, session = state.sessions.find(item => responseKey(item) === rowKey);
      const pinButton = row.querySelector('.console-row-pin');
      if (!pinButton) continue;
      const pinned = consolePreferences.pins.includes(rowKey);
      pinButton.textContent = pinned ? 'Unpin' : 'Pin';
      pinButton.setAttribute('aria-pressed', String(pinned));
      pinButton.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${session ? nameOf(session) : 'session'}; session key ${rowKey}`);
      pinButton.disabled = consolePreferences.writing;
    }
  }
  function historicalResponseBanner(target, session = target.session) {
    const result = target.result || {}, response = target.response || {};
    const name = result.displayName || session && nameOf(session) || byId(response, 'displayName') || 'Session';
    const projectValue = result.project ?? byId(session, 'project');
    const project = projectValue == null ? 'Project unavailable' : String(projectValue) || 'Unassigned project';
    const host = result.host ?? byId(session, 'host') ?? byId(response, 'host') ?? 'Unknown machine';
    const account = result.accountAlias ?? byId(session, 'accountAlias') ?? byId(response, 'accountAlias') ?? 'Unassigned account';
    const harness = result.harness ?? byId(session, 'harness') ?? byId(response, 'harness');
    const details = [project, host || 'Unknown machine', account || 'Unassigned account',
      harness === 'omp' ? 'OMP' : harness === 'claude' ? 'Claude Code' : 'Harness unavailable'].join(' · ');
    return el('p', 'historical-response-note',
      `Historical output match · ${name} · response ${target.responseId}. ${details}. Reply and decision actions are disabled.`);
  }
  function renderHistoricalResponseOnly(target) {
    const root = $('#console-detail');
    root.style.minHeight = '';
    root.replaceChildren(historicalResponseBanner(target), responseBlock(target.response, target.response));
  }
  function renderConsole(changedKey) {
    const rows = visibleSessions(), keys = new Set(state.sessions.map(responseKey));
    consoleState.order = consoleState.order.filter(key => keys.has(key));
    const known = new Set(consoleState.order);
    for (const s of rows) if (!known.has(responseKey(s))) consoleState.order.push(responseKey(s));
    const positions = new Map(consoleState.order.map((key, i) => [key, i]));
    rows.sort((a, b) => positions.get(responseKey(a)) - positions.get(responseKey(b)));
    if (!consoleState.selectedKey && rows.length && !consoleState.preserveEmptySelection) { consoleState.selectedKey = responseKey(rows[0]); if (state.view === 'console') setSessionUrl(consoleState.selectedKey); }
    if (!consoleState.selectionInitialized && consoleState.selectedKey) {
      const explicitTarget = consoleState.historicalTarget?.key === consoleState.selectedKey;
      beginConsoleSelection(consoleState.selectedKey, !explicitTarget);
    }
    const focusedRow = document.activeElement?.closest?.('#console-rows [data-key]')?.dataset.key;
    const body = $('#console-rows'), existing = new Map([...body.querySelectorAll('[data-key]')].map(row => [row.dataset.key, row]));
    const headings = new Map([...body.querySelectorAll('[data-group]')].map(row => [row.dataset.group, row]));
    const grouping = $('#group-filter').value, groups = new Map(), ordered = [];
    for (const session of rows) {
      const group = grouping ? dimensionValue(session, grouping) : '';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(session);
    }
    for (const [group, members] of groups) {
      if (grouping) {
        const groupKey = JSON.stringify([grouping, group]), heading = headings.get(groupKey) || el('tr', 'console-group');
        heading.dataset.group = groupKey;
        if (!heading.firstElementChild) heading.append(el('th'));
        const needs = members.filter(s => statusOf(s) === 'needs_input').length;
        heading.firstElementChild.textContent = `${dimensionLabels[grouping]}: ${dimensionLabel(grouping, group)} · ${members.length} session${members.length === 1 ? '' : 's'}${needs ? ` · ${needs} needs you` : ''}`;
        ordered.push(heading);
      }
      for (const s of members) {
        const key = responseKey(s), row = existing.get(key) || el('tr'), selected = key === consoleState.selectedKey;
        row.dataset.key = key; row.dataset.selected = String(selected); row.className = `status-${statusOf(s)}`;
        const values = [['state', statusLabel(s)], ['project', byId(s, 'project') || 'Unassigned'], ['session', nameOf(s)],
          ['host', byId(s, 'host') || 'Unknown'], ['account', byId(s, 'accountAlias') || 'Unassigned'],
          ['harness', byId(s, 'harness') === 'omp' ? 'OMP' : 'Claude'], ['age', relative(byId(s, 'lastActivity', 'last_activity'))]];
        for (const [column, value] of values) {
          let cell = row.querySelector(`[data-cell="${column}"]`);
          if (!cell) {
            cell = el('td'); cell.dataset.cell = column; row.append(cell);
            if (column === 'state') cell.append(el('span'));
            else if (column === 'session') {
              const button = el('button', 'console-session'); button.type = 'button';
              button.addEventListener('click', () => selectConsoleSession(key));
              const pin = el('button', 'console-row-pin', 'Pin'); pin.type = 'button';
              pin.addEventListener('click', () => toggleConsolePin(key, !consolePreferences.pins.includes(key)));
              cell.append(button, pin, el('span', 'console-unread'));
            } else cell.dataset.column = column;
          }
          if (column === 'session' && !cell.querySelector('.console-row-pin')) {
            const pin = el('button', 'console-row-pin', 'Pin'); pin.type = 'button';
            pin.addEventListener('click', () => toggleConsolePin(key, !consolePreferences.pins.includes(key)));
            cell.insertBefore(pin, cell.querySelector('.console-unread'));
          }
          if (column === 'state') {
            cell.firstElementChild.className = `status-pill ${statusOf(s)}`; cell.firstElementChild.textContent = value;
          } else if (column === 'session') {
            const button = cell.firstElementChild, unread = Number(byId(s, 'unreadCount', 'unread_count') || 0);
            button.textContent = value; button.title = `${value} · ${identityText(s)}`; button.setAttribute('aria-pressed', String(selected));
            cell.lastElementChild.textContent = `${unread} unread`; cell.lastElementChild.hidden = !unread;
          } else { cell.textContent = value; cell.title = value; }
        }
        ordered.push(row);
      }
    }
    const retained = new Set(ordered);
    for (const row of [...body.children]) if (!retained.has(row)) row.remove();
    ordered.forEach((row, index) => { if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null); });
    applyConsoleColumns();
    updateConsolePinButtons();
    if (focusedRow) $('#console-rows').querySelector(`[data-key="${CSS.escape(focusedRow)}"] button`)?.focus({ preventScroll: true });
    $('#console-empty').hidden = rows.length > 0;
    const target = consoleState.historicalTarget?.key === consoleState.selectedKey ? consoleState.historicalTarget : null;
    const current = state.sessions.find(s => responseKey(s) === consoleState.selectedKey) || target?.session || null;
    renderReadBoundary();
    $('#console-copy-link').disabled = !current && !target;
    $('#console-follow').disabled = !current || Boolean(target);
    $('#console-update').disabled = !current;
    if (consoleState.paneMode === 'timeline') {
      $('#console-update').hidden = true;
      $('#console-selection-status').textContent = 'All client outputs in chronological order.';
      return;
    }
    if (target) {
      $('#console-follow').checked = false;
      $('#console-update').hidden = !current;
      if (!current) {
        $('#console-detail').style.minHeight = '';
        if (target.status === 'ready' && target.response) renderHistoricalResponseOnly(target);
        else $('#console-detail').replaceChildren(el('p', 'empty-state',
          target.status === 'loading' ? 'Loading the retained response and session…' : target.error || 'This session is unavailable.'));
        $('#console-selection-status').textContent = target.status === 'loading'
          ? 'Loading the exact retained response…'
          : target.status === 'error' ? 'Historical response unavailable.' : 'Historical output match · session details unavailable.';
        renderConsoleHistory();
        return;
      }
      if (target.status === 'loading') {
        $('#console-detail').style.minHeight = '';
        $('#console-detail').replaceChildren(el('p', 'console-placeholder', 'Loading the exact retained response…'));
        $('#console-selection-status').textContent = `Loading retained response ${target.responseId} for ${nameOf(current)}.`;
        renderConsoleHistory();
        return;
      }
      if (target.status === 'error' || !target.response) {
        $('#console-detail').style.minHeight = '';
        $('#console-detail').replaceChildren(el('p', 'empty-state', target.error || 'This retained response is unavailable.'));
        $('#console-selection-status').textContent = 'Historical response unavailable.';
        renderConsoleHistory();
        return;
      }
      let reading = consoleState.reading.get(consoleState.selectedKey);
      if (!reading) {
        reading = historicalReading(current, target.response);
        consoleState.reading.set(consoleState.selectedKey, reading);
      }
      $('#console-update').hidden = false;
      $('#console-selection-status').textContent = `Historical response ${target.responseId} · replies and quick actions are disabled.`;
      if (!changedKey || changedKey === consoleState.selectedKey) renderConsoleDetail(current, reading, true, true);
      renderConsoleHistory();
      return;
    }
    $('#console-follow').checked = consoleState.follow;
    $('#console-update').hidden = false;
    if (!current) {
      $('#console-detail').style.minHeight = '';
      $('#console-detail').replaceChildren(el('p', 'empty-state', consoleState.selectedKey ? 'This session is unavailable. Show ended/headless sessions or select another row.' : 'Select a session to read and reply.'));
      $('#console-selection-status').textContent = ''; $('#console-update').hidden = true; renderConsoleHistory(); return;
    }
    let reading = consoleState.reading.get(responseKey(current));
    if (!reading || consoleState.follow && consoleSignature(reading) !== consoleSignature(current)) {
      reading = current; consoleState.reading.set(responseKey(current), reading);
      consoleState.history.delete(responseKey(current)); renderConsoleHistory();
    }
    const pending = consoleSignature(reading) !== consoleSignature(current);
    $('#console-update').hidden = !pending;
    const outside = rows.some(s => responseKey(s) === responseKey(current)) ? '' : 'Outside current filters. ';
    $('#console-selection-status').textContent = `${outside}${pending ? 'New output waiting — show latest to see the current turn.' : 'Reading selected session.'}`;
    if (!changedKey || changedKey === responseKey(current)) renderConsoleDetail(current, reading, pending);
  }
  function renderConsoleDetail(current, reading, pending, historical = false) {
    const root = $('#console-detail'), old = root.firstElementChild, pane = $('.console-pane');
    const focus = focusSnapshot(old), scrollTop = pane.scrollTop, pageScroll = window.scrollY;
    const sameSession = !historical && old?.dataset.key === responseKey(current);
    const readingNode = sameSession && [...root.querySelectorAll('[data-response-id]')].find(node => {
      const rect = node.getBoundingClientRect(); return rect.bottom > Math.max(0, pane.getBoundingClientRect().top) && rect.top < window.innerHeight;
    });
    const anchorSelector = sameSession && focus ? `[data-reply-focus="${CSS.escape(focus.focus)}"]` :
      readingNode ? `[data-response-id="${CSS.escape(readingNode.dataset.responseId)}"]` : null;
    const anchorTop = anchorSelector ? root.querySelector(anchorSelector)?.getBoundingClientRect().top : null;
    root.style.minHeight = sameSession && pending ? `${root.offsetHeight}px` : '';
    const oldScroll = new Map([...root.querySelectorAll('[data-response-id]')].map(node => [node.dataset.responseId, [node.scrollTop, node.scrollLeft]]));
    const textarea = root.querySelector('textarea'), editorScroll = textarea?.scrollTop, editorHeight = textarea?.style.height;
    const replacement = renderCard(current, reading, historical);
    root.replaceChildren(...(historical ? [historicalResponseBanner(consoleState.historicalTarget, current), replacement] : [replacement]));
    for (const node of root.querySelectorAll('[data-response-id]')) {
      const position = oldScroll.get(node.dataset.responseId);
      if (position) { node.scrollTop = position[0]; node.scrollLeft = position[1]; }
    }
    const editor = root.querySelector('textarea');
    if (editor) { if (editorHeight) editor.style.height = editorHeight; editor.scrollTop = editorScroll || 0; }
    restoreCardFocus(focus, replacement); pane.scrollTop = scrollTop; window.scrollTo(0, pageScroll);
    const anchor = anchorSelector && root.querySelector(anchorSelector);
    if (anchor && anchorTop != null) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (['auto', 'scroll'].includes(getComputedStyle(pane).overflowY)) pane.scrollTop += delta;
      else window.scrollBy(0, delta);
    }
  }
  function renderConsoleHistory() {
    const key = consoleState.selectedKey, target = consoleState.historicalTarget?.key === key ? consoleState.historicalTarget : null;
    const reading = consoleState.reading.get(key), page = consoleState.history.get(key);
    const current = state.sessions.find(s => responseKey(s) === key) || target?.session || null;
    const latestIds = new Set(responsesOf(reading).map(r => byId(r, 'id')));
    $('#console-history').replaceChildren(...(page?.rows || []).filter(r => !latestIds.has(byId(r, 'id'))).map(r => {
      const item = el('li', 'console-history-entry');
      item.append(responseBlock(r, r)); return item;
    }));
    const button = $('#console-history-more');
    button.hidden = !current || !responsesOf(reading).length || Boolean(page?.done) || Boolean(target && target.status !== 'ready');
    button.disabled = Boolean(page?.loading);
    button.textContent = page?.loading ? 'Loading…' : page?.error ? 'Retry older responses' : 'Load older responses';
    $('#console-history-status').textContent = page?.error || (page?.done ? 'Beginning of retained history.' : '');
  }
  async function loadConsoleHistory() {
    const key = consoleState.selectedKey, reading = consoleState.reading.get(key);
    if (!reading) return;
    let page = consoleState.history.get(key);
    if (!page) {
      const responses = responsesOf(reading); if (!responses.length) return;
      const first = responses.reduce((oldest, response) => {
        const candidate = { ts: Number(byId(response, 'ts')), id: Number(byId(response, 'id')) };
        return candidate.ts < oldest.ts || candidate.ts === oldest.ts && candidate.id < oldest.id ? candidate : oldest;
      }, { ts: Number(byId(responses[0], 'ts')), id: Number(byId(responses[0], 'id')) });
      page = { rows: [], before: first, done: false, loading: false, error: '' };
      consoleState.history.set(key, page);
    }
    if (page.loading || page.done) return;
    page.loading = true; page.error = ''; renderConsoleHistory();
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(key)}/responses?limit=50&before=${page.before.ts}&beforeId=${page.before.id}`);
      if (!response.ok) throw new Error(`History unavailable (${response.status}).`);
      const payload = await response.json();
      if (consoleState.history.get(key) !== page) return;
      const ids = new Set(page.rows.map(r => byId(r, 'id')));
      page.rows.push(...payload.responses.filter(r => !ids.has(byId(r, 'id'))));
      if (payload.responses.length) {
        const last = payload.responses.at(-1);
        page.before = { ts: Number(byId(last, 'ts')), id: Number(byId(last, 'id')) };
      }
      page.done = !payload.hasMore;
    } catch (error) { page.error = error.message || 'History unavailable.'; }
    finally { page.loading = false; if (consoleState.selectedKey === key && consoleState.history.get(key) === page) renderConsoleHistory(); }
  }

  function sortSessions(list) {
    const rank = (s) => { const status=statusOf(s), unread=Number(byId(s,'unreadCount','unread_count')||0); return status==='needs_input'?0:status==='your_turn'&&unread?1:status==='working'?2:status==='your_turn'?3:status==='ended'?4:5; };
    return [...list].sort((a,b) => { const d=rank(a)-rank(b); if(d) return d; const at=Number(byId(a,'lastActivity','last_activity')||0),bt=Number(byId(b,'lastActivity','last_activity')||0); return rank(a)===0?at-bt:bt-at; });
  }
  function renderSessions() {
    if (state.view === 'console') { renderConsole(); updateCounts(); return; }
    if (state.view !== 'sessions') { updateCounts(); return; }
    const filtered = visibleSessions();
    const activeCard = document.activeElement?.closest?.('.session-card'), focus = focusSnapshot(activeCard), oldScroll=window.scrollY;
    cardSizes.disconnect();
    sessionsNode.replaceChildren(...filtered.map(session => renderCard(session)));
    sizeSessionCards([...sessionsNode.children]);
    $('#sessions-empty').hidden=filtered.length>0; window.scrollTo(0,oldScroll);
    if (focus) restoreCardFocus(focus, sessionsNode.querySelector(`[data-key="${CSS.escape(focus.key)}"]`));
    updateCounts();
  }
  // repository-filter helpers (oh-my-dash identity: host + cwd, else project label); pure, tested via slice.
  function projectFolderOf(session) {
    const cwd = byId(session, 'cwd');
    if (typeof cwd !== 'string' || !cwd) return '';
    return cwd.replace(/\/+$/, '') || '/';
  }
  function projectFilterIdentity(session) {
    const host = String(byId(session, 'host') ?? '');
    const cwd = projectFolderOf(session);
    if (cwd) return JSON.stringify([host, 'cwd', cwd]);
    const project = String(byId(session, 'project') ?? '');
    return project ? JSON.stringify([host, 'project', project]) : JSON.stringify([host, 'unknown']);
  }
  function projectFilterLabel(session) {
    const project = byId(session, 'project');
    if (typeof project === 'string' && project) return project;
    return projectFolderOf(session).split(/[\\/]/).filter(Boolean).pop() || 'Project unknown';
  }
  // Legacy values (a JSON string = plain project name, from older saved views/localStorage) match every repository with that label.
  function legacyProjectName(selected) {
    try { const parsed = JSON.parse(selected); return typeof parsed === 'string' ? parsed : null; } catch { return null; }
  }
  function repositorySearchFilter(selected) {
    const legacy = legacyProjectName(selected);
    if (legacy !== null) return { project: legacy };
    try {
      const identity = JSON.parse(selected);
      if (!Array.isArray(identity) || typeof identity[0] !== 'string') return null;
      const [repositoryHost, kind, value] = identity;
      if (kind === 'unknown' && identity.length === 2) return { repositoryHost, cwd: '' };
      if (identity.length !== 3) return null;
      if (kind === 'cwd' && typeof value === 'string') return { repositoryHost, cwd: value };
      if (kind === 'project' && typeof value === 'string') return { repositoryHost, project: value };
    } catch {}
    return null;
  }
  function repositoryFilterMatches(session, selected) {
    if (!selected) return true;
    const legacy = legacyProjectName(selected);
    return legacy !== null ? String(byId(session, 'project') || '') === legacy : projectFilterIdentity(session) === selected;
  }
  function repositoryFilterChoices(rows, selected) {
    const entries = new Map();
    for (const session of rows) {
      const id = projectFilterIdentity(session);
      if (!entries.has(id)) entries.set(id, { id, name: projectFilterLabel(session), cwd: projectFolderOf(session), host: String(byId(session, 'host') ?? '') });
    }
    const counts = new Map();
    for (const entry of entries.values()) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    const options = [...entries.values()].map(entry => ({ ...entry, label: counts.get(entry.name) > 1 ? `${entry.name} — ${entry.cwd || entry.host || 'unknown folder'}` : entry.name }));
    const labelCounts = new Map();
    for (const entry of options) labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);
    options.sort((a, b) => a.label.localeCompare(b.label));
    const choices = options.map(entry => [entry.id, labelCounts.get(entry.label) > 1 ? `${entry.label} (${entry.host || 'unknown host'})` : entry.label]);
    if (selected && !entries.has(selected)) {
      const legacy = legacyProjectName(selected);
      choices.push([selected, legacy !== null ? `${legacy || 'Unassigned project'} (all folders)` : 'Saved repository filter (not currently available)']);
    }
    return choices;
  }
  // repository-filter helpers end
  const dimensionLabels = { project: 'Project', host: 'Machine', account: 'Account', harness: 'Harness' };
  const dimensionValue = (session, dimension) => String(byId(session, dimension === 'account' ? 'accountAlias' : dimension) || '');
  const dimensionLabel = (dimension, value) => value ? dimension === 'harness' ? value === 'omp' ? 'OMP' : 'Claude Code' : value : `Unassigned ${dimensionLabels[dimension].toLowerCase()}`;
  function visibleSessions(ignoreStatus = false) {
    const host = $('#host-filter').value, harness = $('#harness-filter').value;
    const project = $('#project-filter').value, account = $('#account-filter').value, status = $('#status-filter').value;
    const headless = $('#headless-filter').checked, ended = $('#ended-filter').checked;
    const query = $('#session-search').value.trim().toLocaleLowerCase();
    return sortSessions(state.sessions.filter(s =>
      (headless || byId(s, 'interactive') !== false && byId(s, 'interactive') !== 0) &&
      (ended || statusOf(s) !== 'ended') && (!host || byId(s, 'host') === host) && (!harness || byId(s, 'harness') === harness) &&
      repositoryFilterMatches(s, project) &&
      (!account || JSON.stringify(dimensionValue(s, 'account')) === account) &&
      (!query || [nameOf(s), byId(s, 'project'), byId(s, 'host'), byId(s, 'accountAlias'), byId(s, 'harness'), byId(s, 'cwd'), byId(s, 'sessionId', 'session_id')].join(' ').toLocaleLowerCase().includes(query)) &&
      (ignoreStatus || !status || (status === 'unread' ? Number(byId(s, 'unreadCount', 'unread_count') || 0) > 0 : statusOf(s) === status))));
  }
  function patchSessionCard(dto, prior) {
    const key=responseKey(dto), old=sessionsNode.querySelector(`[data-key="${CSS.escape(key)}"]`);
    let identityChanged = false;
    for (const row of state.timeline) {
      if (byId(row,'sessionKey','session_key') === key && (row.displayName !== nameOf(dto) || row.accountAlias !== dto.accountAlias)) {
        row.displayName = nameOf(dto); row.accountAlias = dto.accountAlias; identityChanged = true;
      }
    }
    if (identityChanged) renderTimeline();
    if (state.view === 'console') { renderConsole(key); updateCounts(); return; }
    if (state.view !== 'sessions') { updateCounts(); return; }
    if (old) cardSizes.unobserve(old);
    if (!visibleSessions().some(s=>responseKey(s)===key)) { old?.remove(); $('#sessions-empty').hidden=sessionsNode.children.length>0; updateCounts(); return; }
    const focus = focusSnapshot(old);
    const replacement=renderCard(dto);
    if (old) replacement.style.setProperty('--session-rows', old.style.getPropertyValue('--session-rows'));
    if (old) {
      const oldScroll=[...old.querySelectorAll('.response,.needs-text,pre')].map(node=>[node.scrollTop,node.scrollLeft]);
      old.replaceWith(replacement);
      replacement.querySelectorAll('.response,.needs-text,pre').forEach((node,i)=>{node.scrollTop=oldScroll[i]?.[0]||0;node.scrollLeft=oldScroll[i]?.[1]||0;});
    }
    const ordered=visibleSessions(), index=ordered.findIndex(s=>responseKey(s)===key);
    const next=ordered.slice(index+1).map(responseKey).map(k=>sessionsNode.querySelector(`[data-key="${CSS.escape(k)}"]`)).find(Boolean);
    if (next) sessionsNode.insertBefore(replacement,next); else sessionsNode.append(replacement);
    sizeSessionCards([replacement]);
    restoreCardFocus(focus, replacement);
    $('#sessions-empty').hidden=sessionsNode.children.length>0;
    updateCounts();
  }
  function updateCounts() {
    const base = visibleSessions(true), needs = base.filter(s => statusOf(s) === 'needs_input'), selected = $('#status-filter').value;
    $('#needs-count').textContent = needs.length;
    $('#unread-count').textContent = base.reduce((n, s) => n + Number(byId(s, 'unreadCount', 'unread_count') || 0), 0);
    $('#working-count').textContent = base.filter(s => statusOf(s) === 'working').length;
    for (const [id, status] of [['needs', 'needs_input'], ['unread', 'unread'], ['working', 'working']]) {
      $(`#${id}-filter-toggle`).setAttribute('aria-pressed', String(selected === status));
    }
    $('#next-unresolved').disabled = !needs.length;
    const visible = visibleSessions().length;
    $('#filter-summary').textContent = `${visible} session${visible === 1 ? '' : 's'} shown. Attention counts use search, source and headless/ended filters, independent of State.`;
  }
  function refreshSessionFilters() {
    for (const dimension of ['project', 'host', 'account']) {
      const select = $(`#${dimension}-filter`), selected = select.value;
      if (dimension === 'project') {
        const options = repositoryFilterChoices([...state.sessions, ...state.timeline], selected), signature = JSON.stringify(options);
        if (select.dataset.options === signature) continue;
        select.replaceChildren(new Option('All repositories', ''), ...options.map(([value, label]) => new Option(label, value)));
        select.value = selected; select.dataset.options = signature;
        continue;
      }
      const values = [...new Set(state.sessions.map(s => dimensionValue(s, dimension)).filter(value => dimension !== 'host' || value))].sort();
      const options = values.map(value => [dimension === 'host' ? value : JSON.stringify(value), dimensionLabel(dimension, value)]);
      if (selected && !options.some(([value]) => value === selected)) {
        const value = dimension === 'host' ? selected : JSON.parse(selected);
        options.push([selected, `${dimensionLabel(dimension, value)} (unavailable)`]);
      }
      const signature = JSON.stringify(options);
      if (select.dataset.options === signature) continue;
      select.replaceChildren(new Option(`All ${dimension === 'host' ? 'machines' : dimension + 's'}`, ''),
        ...options.map(([value, label]) => new Option(label, value)));
      select.value = selected; select.dataset.options = signature;
    }
  }
  function nextUnresolved() {
    const needs = visibleSessions(true).filter(s => statusOf(s) === 'needs_input');
    if (!needs.length) return;
    const index = needs.findIndex(s => responseKey(s) === consoleState.selectedKey);
    $('#status-filter').value = 'needs_input';
    setFeedView('console');
    selectConsoleSession(responseKey(needs[(index + 1) % needs.length]));
  }

  const navigationDialogs = new Map();
  let composing = false;
  const selectedComposer = () => state.view === 'console' ? $('#console-detail textarea.reply-input:not(:disabled)') : null;
  function focusSessionSearch() {
    if (state.view === 'timeline') setFeedView('console');
    $('#session-search').focus();
  }
  function navigateConsole(direction) {
    if (state.view !== 'console') return;
    const rows = [...document.querySelectorAll('#console-rows [data-key]')];
    if (!rows.length) return;
    const current = rows.findIndex(row => row.dataset.key === consoleState.selectedKey);
    const index = direction === 'first' ? 0 : direction === 'last' ? rows.length - 1 :
      current < 0 ? direction > 0 ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + direction));
    const key = rows[index].dataset.key;
    selectConsoleSession(key);
    const button = $('#console-rows').querySelector(`[data-key="${CSS.escape(key)}"] button`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function showNavigationDialog(id) {
    if (document.querySelector('dialog[open]')) return;
    const dialog = $('#'+id), node = document.activeElement;
    navigationDialogs.set(dialog, { node, row: node?.closest?.('#console-rows [data-key]')?.dataset.key, action: null });
    if (id === 'command-dialog') { $('#command-search').value = ''; renderCommandPalette(); }
    dialog.showModal();
    (id === 'command-dialog' ? $('#command-search') : dialog.querySelector('.dialog-close')).focus();
  }
  function navigationCommands() {
    const control = (id, label, selector) => {
      const node = $(selector);
      return { id, label, enabled: Boolean(node && !node.disabled && !node.closest('[hidden]')), run: () => node.click() };
    };
    return [
      { id: 'search', label: 'Search sessions', hint: '/', enabled: true, run: focusSessionSearch },
      { id: 'reply', label: 'Focus selected reply composer', hint: 'r', enabled: Boolean(selectedComposer()), run: () => selectedComposer()?.focus() },
      { id: 'console', label: 'Show Console', enabled: true, run: () => { setFeedView('console', true); $('#console-tab').focus(); } },
      { id: 'feed', label: 'Show Feed', enabled: true, run: () => { setFeedView('sessions', true); $('#sessions-tab').focus(); } },
      { id: 'timeline', label: 'Show Timeline', enabled: true, run: () => { setFeedView('timeline', true); $('#timeline-tab').focus(); } },
      { id: 'consolePaneTimeline', label: 'Show all client outputs in Console pane', enabled: state.view === 'console', run: () => { setConsolePaneMode('timeline'); $('#console-pane-timeline').focus(); } },
      { id: 'consolePaneSession', label: 'Show selected session in Console pane', enabled: state.view === 'console', run: () => { setConsolePaneMode('session'); $('#console-pane-session').focus(); } },
      control('next', 'Next unresolved session', '#next-unresolved'),
      control('nextUnread', 'Next unread response', '#console-next-unread'),
      control('markResponseRead', 'Mark displayed response read', '#console-mark-response-read'),
      control('latest', 'Show latest selected output', '#console-update'),
      control('copy', 'Copy selected session link', '#console-copy-link'),
      control('older', 'Load older selected responses', '#console-history-more'),
      control('sort', 'Sort sessions by attention', '#console-sort'),
      control('clear', 'Clear session filters', '#clear-filters'),
      control('read', 'Mark all read', '#mark-all'),
      { id: 'notifications', label: 'Notification settings', enabled: true, run: () => $('#notifications-dialog').showModal() },
      { id: 'help', label: 'Keyboard shortcuts', hint: '?', enabled: true, run: () => showNavigationDialog('shortcut-dialog') },
    ];
  }
  function renderCommandPalette() {
    const query = $('#command-search').value.trim().toLocaleLowerCase();
    const commands = navigationCommands().filter(command => command.label.toLocaleLowerCase().includes(query));
    const selected = state.sessions.find(s => responseKey(s) === consoleState.selectedKey);
    $('#command-context').textContent = selected ? `Selected: ${nameOf(selected)} · ${identityText(selected)}` : 'No available session selected.';
    $('#command-status').textContent = commands.length ? 'Unavailable actions are disabled. No command sends or authorizes.' : 'No matching commands.';
    $('#command-results').replaceChildren(...commands.map(command => {
      const button = el('button', 'command-result'); button.type = 'button'; button.disabled = !command.enabled;
      button.dataset.command = command.id;
      button.append(el('span', '', command.label), el('small', '', command.enabled ? command.hint || '' : 'Unavailable'));
      button.addEventListener('click', () => {
        const fresh = navigationCommands().find(item => item.id === command.id);
        if (!fresh?.enabled) { renderCommandPalette(); $('#command-search').focus(); return; }
        navigationDialogs.get($('#command-dialog')).action = fresh.run;
        $('#command-dialog').close();
      });
      return button;
    }));
  }
  for (const id of ['command-dialog', 'shortcut-dialog', 'ideas-dialog']) {
    const dialog = $('#'+id);
    dialog.addEventListener('close', () => {
      const saved = navigationDialogs.get(dialog);
      navigationDialogs.delete(dialog);
      const row = saved?.row && $('#console-rows').querySelector(`[data-key="${CSS.escape(saved.row)}"] button`);
      (row || (saved?.node?.isConnected ? saved.node : $('#command-open'))).focus({ preventScroll: true });
      saved?.action?.();
    });
  }
  $('#command-search').addEventListener('input', renderCommandPalette);
  $('#command-dialog').addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') { event.preventDefault(); $('#command-dialog').close(); return; }
    const buttons = [...document.querySelectorAll('#command-results button:not(:disabled)')];
    if (event.key === 'Enter' && event.target === $('#command-search')) {
      event.preventDefault(); buttons[0]?.click();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && (event.target === $('#command-search') || buttons.includes(event.target))) {
      event.preventDefault();
      const index = buttons.indexOf(event.target), direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = index < 0 ? direction > 0 ? 0 : buttons.length - 1 : index + direction;
      if (next < 0 || next >= buttons.length) $('#command-search').focus(); else buttons[next].focus();
    }
  });
  $('#command-open').addEventListener('click', () => showNavigationDialog('command-dialog'));
  $('#shortcut-open').addEventListener('click', () => showNavigationDialog('shortcut-dialog'));
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; });
  document.addEventListener('keydown', event => {
    const target = event.target;
    if (event.defaultPrevented || event.isComposing || composing || event.keyCode === 229 || document.querySelector('dialog[open]') ||
      target.isContentEditable || target.closest?.('input, textarea, select, [role="textbox"], [role="combobox"], [role="slider"]')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault(); showNavigationDialog('command-dialog'); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/') { event.preventDefault(); focusSessionSearch(); }
    else if (event.key === '?') { event.preventDefault(); showNavigationDialog('shortcut-dialog'); }
    else if (event.key === 'r' && selectedComposer()) { event.preventDefault(); selectedComposer().focus(); }
    else if (state.view === 'console') {
      const rowFocused = target.closest?.('#console-rows [data-key]');
      const direction = event.key === 'j' || rowFocused && event.key === 'ArrowDown' ? 1 :
        event.key === 'k' || rowFocused && event.key === 'ArrowUp' ? -1 :
        rowFocused && event.key === 'Home' ? 'first' : rowFocused && event.key === 'End' ? 'last' : null;
      if (direction !== null) { event.preventDefault(); navigateConsole(direction); }
    }
  });
  function sourceTimestamp(value) { return typeof value === 'number' && Number.isFinite(value); }
  function sourceHubNow(snapshot = sourcesState.snapshot) {
    if (!snapshot || !sourceTimestamp(snapshot.generatedAt) || sourcesState.receivedAt === null) return null;
    return snapshot.generatedAt + Math.max(0, performance.now() - sourcesState.receivedAt);
  }
  function sourceRelativeTime(timestamp, snapshot = sourcesState.snapshot) {
    if (!sourceTimestamp(timestamp)) return 'time unknown';
    const now = sourceHubNow(snapshot);
    if (!sourceTimestamp(now)) return 'time unknown';
    const elapsed = now - timestamp;
    if (elapsed < 0) return 'ahead of hub clock';
    if (elapsed < 1000) return 'just now';
    if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
  }
  function sourceAbsoluteTime(timestamp) {
    if (!sourceTimestamp(timestamp)) return '';
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
  }
  function sourceSnapshotAge() {
    return sourcesState.receivedAt === null ? null : Math.max(0, performance.now() - sourcesState.receivedAt);
  }
  function sourceElapsedLabel(milliseconds) {
    if (!sourceTimestamp(milliseconds)) return 'unknown age';
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
  }
  function sourceFreshness(source, snapshot) {
    const lastReportAt = source?.lastReportAt, lastHeartbeatAt = source?.lastHeartbeatAt;
    if (lastReportAt === null && lastHeartbeatAt === null) return { status: 'unreported', reason: 'No hub report has been received.' };
    if (lastReportAt !== null && !sourceTimestamp(lastReportAt) || lastHeartbeatAt !== null && !sourceTimestamp(lastHeartbeatAt)) {
      return { status: 'unknown', reason: 'Hub receipt time is unavailable.' };
    }
    const now = sourceHubNow(snapshot), staleAfterMs = snapshot?.staleAfterMs;
    if (!sourceTimestamp(now) || !sourceTimestamp(staleAfterMs) || staleAfterMs < 0) {
      return { status: 'unknown', reason: 'Hub freshness cannot be evaluated from this snapshot.' };
    }
    if (lastReportAt !== null && lastReportAt > now || lastHeartbeatAt !== null && lastHeartbeatAt > now) {
      return { status: 'unknown', reason: 'A hub receipt time is ahead of the hub clock.' };
    }
    const age = now - Math.max(lastReportAt ?? -Infinity, lastHeartbeatAt ?? -Infinity);
    if (age > staleAfterMs) return { status: 'stale', reason: 'The last hub report is outside the freshness window.' };
    return { status: 'reporting', reason: 'A hub report arrived within the freshness window.' };
  }
  function sourceHostLabel(host) {
    const label = typeof host === 'string' ? host.trim() : '';
    const address = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(label) ||
      label.includes(':') && /^[\da-f:.%]+$/i.test(label.replace(/^\[|\]$/g, ''));
    return label && !address ? label : 'Unlabelled source';
  }
  function appendSourceTime(parent, label, timestamp, snapshot, emptyText = 'Time unavailable') {
    const fact = el('div', 'source-fact');
    fact.append(el('strong', '', label));
    const time = el('time');
    if (timestamp === null) time.textContent = emptyText;
    else {
      const absolute = sourceAbsoluteTime(timestamp);
      if (absolute) {
        time.dataset.sourceTime = String(timestamp);
        time.dateTime = new Date(timestamp).toISOString();
        time.textContent = `${absolute} · ${sourceRelativeTime(timestamp, snapshot)}`;
      } else time.textContent = emptyText;
    }
    fact.append(time);
    parent.append(fact);
  }
  function renderSourceSession(session, hostLabel, accountLabel, snapshot) {
    const key = typeof session?.key === 'string' ? session.key : '';
    const name = typeof session?.displayName === 'string' && session.displayName.trim() ? session.displayName.trim() : 'Session';
    const harness = session?.harness === 'omp' ? 'OMP' : session?.harness === 'claude' ? 'Claude' : 'Harness unknown';
    const status = typeof session?.status === 'string' && session.status.trim() ? session.status.trim() : 'unknown';
    const mode = session?.interactive === true ? 'Interactive' : session?.interactive === false ? 'Headless' : 'Mode unknown';
    const activity = sourceTimestamp(session?.lastActivity) ? sourceRelativeTime(session.lastActivity, snapshot) : 'time unknown';
    const button = el('button', 'source-session');
    button.type = 'button';
    button.disabled = !key;
    button.dataset.sourceSessionKey = key;
    button.dataset.sourceName = name;
    button.dataset.sourceHost = hostLabel;
    button.dataset.sourceAccount = accountLabel;
    button.dataset.sourceHarness = harness;
    button.dataset.sourceStatus = status;
    button.dataset.sourceMode = mode;
    button.dataset.sourceActivity = sourceTimestamp(session?.lastActivity) ? String(session.lastActivity) : '';
    button.append(
      el('span', 'source-session-name', name),
      el('span', 'source-session-meta', `${harness} · ${status} · ${mode}`)
    );
    const activityNode = el('span', 'source-session-activity');
    activityNode.append(el('strong', '', 'Last session activity · '));
    const activityTime = el('time');
    const absolute = sourceAbsoluteTime(session?.lastActivity);
    if (absolute) {
      activityTime.dateTime = new Date(session.lastActivity).toISOString();
      activityTime.dataset.sourceTime = String(session.lastActivity);
      activityTime.textContent = `${absolute} · ${activity}`;
    } else activityTime.textContent = 'Time unknown';
    activityNode.append(activityTime);
    button.append(activityNode);
    if (key) {
      button.setAttribute('aria-label', `Select ${name} on ${hostLabel}, ${accountLabel}; ${harness}, ${status}, ${mode}; last session activity ${activity}`);
      button.addEventListener('click', () => selectInventorySession(key));
    } else button.setAttribute('aria-label', `Session ${name} has no selectable key`);
    return button;
  }
  function renderSourceCard(source, snapshot) {
    const hostLabel = sourceHostLabel(source?.host), freshness = sourceFreshness(source, snapshot);
    const card = el('article', 'source-card');
    sourceCardRecords.set(card, source);
    const heading = el('div', 'source-heading');
    heading.append(el('strong', 'source-label', hostLabel));
    const markers = el('div', 'source-markers');
    markers.append(el('span', 'source-configured', source?.configured === true ? 'Configured peer label' : 'No peer label configured'));
    markers.append(el('span', `source-status ${freshness.status}`, freshness.status));
    heading.append(markers);
    card.append(heading);
    const facts = el('div', 'source-facts');
    appendSourceTime(facts, 'Last hub report', source?.lastReportAt, snapshot, source?.lastReportAt === null ? 'No report received' : 'Time unavailable');
    if (source?.lastHeartbeatAt !== null && source?.lastHeartbeatAt !== undefined) {
      appendSourceTime(facts, 'Last heartbeat', source.lastHeartbeatAt, snapshot);
    }
    card.append(facts, el('p', 'source-reason', freshness.reason));
    if (freshness.status === 'unreported' && source?.configured === true) {
      card.append(el('p', 'source-guidance', 'No report yet. Check that the source agent is running and configured to report under this label, and that the hub allows the label.'));
    }
    const accounts = Array.isArray(source?.accounts) ? source.accounts : [];
    if (!accounts.length) {
      card.append(el('p', 'source-empty', 'No retained account or session metadata.'));
      return card;
    }
    const accountGroups = el('div', 'source-accounts');
    for (const account of accounts) {
      const alias = typeof account?.accountAlias === 'string' ? account.accountAlias.trim() : '';
      const accountLabel = alias || 'Unassigned account';
      const group = el('section', 'source-account');
      group.append(el('h4', 'source-account-label', `Account · ${accountLabel}`));
      const sessions = Array.isArray(account?.sessions) ? account.sessions : [];
      if (sessions.length) {
        const rows = el('div', 'source-sessions');
        for (const session of sessions) rows.append(renderSourceSession(session, hostLabel, accountLabel, snapshot));
        group.append(rows);
      } else group.append(el('p', 'source-empty', 'No retained sessions.'));
      accountGroups.append(group);
    }
    card.append(accountGroups);
    return card;
  }
  function updateSourceSnapshotLabels() {
    const snapshot = sourcesState.snapshot, summary = $('#sources-summary-state'), status = $('#sources-status');
    const age = sourceSnapshotAge(), ageLabel = age === null ? '' : sourceElapsedLabel(age);
    const count = Array.isArray(snapshot?.sources) ? snapshot.sources.length : 0;
    if (!snapshot) {
      summary.textContent = sourcesState.loading ? 'Loading inventory…' : sourcesState.error ? 'Inventory unavailable' : 'No snapshot loaded';
      status.textContent = sourcesState.loading ? 'Loading source inventory…' : 'Source inventory is unavailable. Use Refresh inventory to retry.';
      return;
    }
    const snapshotState = sourcesState.error ? `Refresh failed · last snapshot ${ageLabel} old` :
      sourcesState.loading ? `Refreshing · last snapshot ${ageLabel} old` :
        age > 30_000 ? `Snapshot ${ageLabel} old` : `Updated ${ageLabel} ago`;
    summary.textContent = `${count} source${count === 1 ? '' : 's'} · ${snapshotState}`;
    status.textContent = sourcesState.error ? `Refresh failed; showing the last successful snapshot fetched ${ageLabel} ago.` :
      sourcesState.loading ? `Refreshing source inventory; last successful snapshot fetched ${ageLabel} ago.` :
        age > 30_000 ? `This inventory snapshot was fetched ${ageLabel} ago.` : `Inventory snapshot fetched ${ageLabel} ago.`;
  }
  function updateSourceRefreshControl() {
    const refresh = $('#sources-refresh');
    refresh.setAttribute('aria-busy', String(sourcesState.loading));
    refresh.textContent = sourcesState.loading ? 'Refreshing…' : 'Refresh inventory';
  }
  function refreshSourceClock() {
    const snapshot = sourcesState.snapshot;
    updateSourceSnapshotLabels();
    if (!snapshot) return;
    for (const time of $('#sources-list').querySelectorAll('time[data-source-time]')) {
      const timestamp = Number(time.dataset.sourceTime), absolute = sourceAbsoluteTime(timestamp);
      if (absolute) time.textContent = `${absolute} · ${sourceRelativeTime(timestamp, snapshot)}`;
    }
    for (const card of $('#sources-list').querySelectorAll('.source-card')) {
      const source = sourceCardRecords.get(card);
      if (!source) continue;
      const freshness = sourceFreshness(source, snapshot);
      const status = card.querySelector('.source-status'), reason = card.querySelector('.source-reason');
      if (status) { status.className = `source-status ${freshness.status}`; status.textContent = freshness.status; }
      if (reason) reason.textContent = freshness.reason;
    }
    for (const button of $('#sources-list').querySelectorAll('[data-source-session-key]:not(:disabled)')) {
      const { sourceName, sourceHost, sourceAccount, sourceHarness, sourceStatus, sourceMode, sourceActivity } = button.dataset;
      const activity = sourceActivity ? sourceRelativeTime(Number(sourceActivity), snapshot) : 'time unknown';
      button.setAttribute('aria-label', `Select ${sourceName} on ${sourceHost}, ${sourceAccount}; ${sourceHarness}, ${sourceStatus}, ${sourceMode}; last session activity ${activity}`);
    }
  }
  function renderSources() {
    const snapshot = sourcesState.snapshot, list = $('#sources-list'), unlabelled = $('#sources-unlabelled');
    const focused = list.contains(document.activeElement) ? document.activeElement?.dataset?.sourceSessionKey : null;
    updateSourceSnapshotLabels();
    if (!snapshot) {
      list.replaceChildren();
      unlabelled.hidden = true;
    } else {
      const unlabelledCount = Number.isSafeInteger(snapshot.unlabelledPeerEntries) ? Math.max(0, snapshot.unlabelledPeerEntries) : 0;
      unlabelled.hidden = unlabelledCount === 0;
      if (unlabelledCount) {
        const noun = unlabelledCount === 1 ? 'peer entry has' : 'peer entries have';
        unlabelled.textContent = `${unlabelledCount} ${noun} no label; peer addresses are withheld.`;
      }
      const entries = Array.isArray(snapshot.sources) ? snapshot.sources : [];
      if (entries.length) list.replaceChildren(...entries.map(source => renderSourceCard(source, snapshot)));
      else list.replaceChildren(el('p', 'source-empty', 'No labelled sources or retained sessions.'));
    }
    updateSourceRefreshControl();
    if (focused !== null && focused !== undefined) {
      const replacement = [...list.querySelectorAll('[data-source-session-key]')].find(button => button.dataset.sourceSessionKey === focused);
      (replacement || $('#sources-disclosure > summary'))?.focus({ preventScroll: true });
    }
  }
  function refreshSourceSnapshot() {
    if (sourcesState.pending) {
      sourcesState.refreshAgain = true;
      return sourcesState.pending;
    }
    sourcesState.loading = true;
    const previousSnapshot = sourcesState.snapshot;
    updateSourceSnapshotLabels();
    updateSourceRefreshControl();
    const pending = Promise.resolve().then(async () => {
      try {
        const response = await fetch('/api/sources', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('source inventory unavailable');
        const payload = await response.json();
        if (!payload || typeof payload !== 'object' || !sourceTimestamp(payload.generatedAt) ||
          !sourceTimestamp(payload.staleAfterMs) || !Number.isSafeInteger(payload.unlabelledPeerEntries) ||
          !Array.isArray(payload.sources)) throw new Error('invalid source inventory');
        sourcesState.snapshot = payload;
        sourcesState.receivedAt = performance.now();
        sourcesState.error = false;
      } catch {
        sourcesState.error = true;
      } finally {
        if (sourcesState.pending === pending) sourcesState.pending = null;
        sourcesState.loading = false;
        if (sourcesState.snapshot !== previousSnapshot) renderSources();
        else {
          updateSourceSnapshotLabels();
          updateSourceRefreshControl();
        }
        const refreshAgain = sourcesState.refreshAgain;
        sourcesState.refreshAgain = false;
        if (refreshAgain && $('#sources-disclosure').open) window.setTimeout(refreshSourceSnapshot, 0);
      }
    });
    sourcesState.pending = pending;
    return pending;
  }
  function scheduleSourcesRefresh() {
    if (!$('#sources-disclosure').open) return;
    window.clearTimeout(sourcesState.debounceTimer);
    sourcesState.debounceTimer = window.setTimeout(() => {
      sourcesState.debounceTimer = 0;
      if ($('#sources-disclosure').open) refreshSourceSnapshot();
    }, 120);
  }
  function updateSourcesTimers() {
    window.clearInterval(sourcesState.clockTimer);
    window.clearInterval(sourcesState.pollTimer);
    window.clearTimeout(sourcesState.debounceTimer);
    sourcesState.debounceTimer = 0;
    if (!$('#sources-disclosure').open) return;
    refreshSourceClock();
    scheduleSourcesRefresh();
    sourcesState.clockTimer = window.setInterval(refreshSourceClock, 1000);
    sourcesState.pollTimer = window.setInterval(refreshSourceSnapshot, 15_000);
  }
  function selectInventorySession(key) {
    if (!key) return;
    setFeedView('console');
    selectConsoleSession(key);
    consoleState.inventorySelection = key;
    if (!state.sessions.some(session => responseKey(session) === key)) {
      loadSessions({ includeAll: true }).catch(() => {
        if (consoleState.selectedKey === key) $('#console-selection-status').textContent = 'Selected session could not be loaded; the inventory may be out of date.';
      });
    }
  }
  function projectFilterMatches(session) {
    const selected = $('#project-filter').value;
    return repositoryFilterMatches(session, selected);
  }
  function refreshProjectFilter() { refreshSessionFilters(); }
  function restoreProjectFilter() {
    try {
      const saved = localStorage.getItem('dash.filter.project');
      if (!saved || saved.length > 8192) return;
      const parsed = JSON.parse(saved);
      if (typeof parsed !== 'string' && !Array.isArray(parsed)) return;
      const select = $('#project-filter');
      select.add(new Option(typeof parsed === 'string' ? `${parsed || 'Unassigned project'} (all folders)` : 'Saved repository filter (not currently available)', saved));
      select.value = saved;
    } catch {}
  }
  function persistProjectFilter() {
    try {
      const selected = $('#project-filter').value;
      if (selected) localStorage.setItem('dash.filter.project', selected);
      else localStorage.removeItem('dash.filter.project');
    } catch {}
  }
  let sessionFetchVersion = 0;
  async function loadSessions(options = {}) {
    const version = ++sessionFetchVersion;
    const includeAll = options.includeAll === true || Boolean(consoleState.inventorySelection && consoleState.inventorySelection === consoleState.selectedKey);
    const params=new URLSearchParams({headless:includeAll?'1':$('#headless-filter').checked?'1':'0',ended:includeAll?'1':$('#ended-filter').checked?'1':'0'});
    const response=await fetch(`/api/sessions?${params}`); if(!response.ok) throw Error(`sessions ${response.status}`);
    const payload=await response.json(), rows=Array.isArray(payload)?payload:(payload.sessions||[]);
    if (version !== sessionFetchVersion) return false;
    if (includeAll) {
      consoleState.allSessions = new Map(rows.map(session => [responseKey(session), session]));
      consoleState.pinInventoryError = '';
    }
    for (const s of rows) {
      recordCapabilityReceipt(s?.capabilities);
      const key=responseKey(s), prior=state.priorStatus.get(key), current=statusOf(s);
      if (prior && prior!=='needs_input' && current==='needs_input' && notificationPreference('needs')) notify(nameOf(s),'Needs your input');
      const oldIds=new Set(responsesOf(state.sessions.find(x=>responseKey(x)===key)||{}).map(r=>String(byId(r,'id'))));
      if (state.priorStatus.has(key) && notificationPreference('response') && responsesOf(s).some(r=>!oldIds.has(String(byId(r,'id'))))) notify(nameOf(s),'New response');
      state.priorStatus.set(key,current);
    }
    const target = consoleState.historicalTarget;
    const targetSession = target && rows.find(session => responseKey(session) === target.key);
    if (targetSession) {
      target.session = targetSession;
      if (target.response) consoleState.reading.set(target.key, historicalReading(targetSession, target.response));
    }
    state.sessions=rows; prunePicks(); refreshSessionFilters(); renderSessions();
    renderPinnedSessions();
    syncIdeaSessions();
    if (state.repliesEnabled) refreshVisibleReplyLists();
    if (target?.status === 'loading' && !target.requested) startHistoricalResponse(target);
    return true;
  }
  async function markSeen(key) {
    stopPendingUnreadResume(key);
    await postJson(`/api/sessions/${encodeURIComponent(key)}/seen`);
    await loadSessions();
    if (consoleState.selectedKey === key) fetchReadPosition(key, consoleState.selectionVersion);
  }
  async function markAll() {
    if (consoleState.selectedKey) stopPendingUnreadResume(consoleState.selectedKey);
    await postJson('/api/seen-all');
    await loadSessions();
    if (consoleState.selectedKey) fetchReadPosition(consoleState.selectedKey, consoleState.selectionVersion);
  }

  const timelineTargets = () => [
    { list: timelineNode, empty: $('#timeline-empty'), more: $('#timeline-more') },
    { list: $('#console-timeline'), empty: $('#console-timeline-empty'), more: $('#console-timeline-more') },
    { list: $('#console-pane-timeline-list'), empty: $('#console-pane-timeline-empty'), more: $('#console-pane-timeline-more') },
  ].filter(target => target.list && target.empty && target.more);
  function updateTimelineSummary() {
    const summary = $('#console-timeline-summary-help');
    if (!summary) return;
    const count = state.timeline.length;
    const clients = new Set(state.timeline.map(row => `${byId(row, 'host') || 'local'}|${byId(row, 'harness') || 'claude'}`)).size;
    summary.textContent = count
      ? `${count}${state.timelineDone ? '' : '+'} output${count === 1 ? '' : 's'} · ${clients} client${clients === 1 ? '' : 's'} · chronological order`
      : 'All clients · chronological order';
  }
  function renderTimeline(append=false) {
    // Timeline is filtered by machine, harness and headless only (see #timeline-filter-note), never by project.
    const visible = state.timeline;
    for (const { list, empty, more } of timelineTargets()) {
      if (!append) list.replaceChildren();
      const existing = new Set([...list.children].map(item => item.dataset.responseId));
      for (const row of visible) {
        const id = String(byId(row, 'id') ?? '');
        if (append && existing.has(id)) continue;
        list.append(timelineItem(row));
        existing.add(id);
      }
      empty.textContent = state.timeline.length && !visible.length
        ? 'No responses in the loaded timeline match these filters.' : 'No responses yet.';
      empty.hidden = visible.length > 0;
      more.hidden = state.timelineDone || state.timeline.length === 0;
    }
    updateTimelineSummary();
  }
  function timelineItem(row) {
    const item=el('article','timeline-item'), header=el('div','timeline-header');
    const key = String(byId(row, 'sessionKey', 'session_key') ?? '');
    const name = row.displayName||row.display_name||row.title||row.cwd?.split('/').filter(Boolean).pop()||'Session';
    item.dataset.responseId = String(byId(row, 'id') ?? '');
    if (key) item.dataset.sessionKey = key;
    if (key) {
      const button = el('button', 'timeline-session-button');
      button.type = 'button';
      button.title = `Open ${name} in Console`;
      button.append(el('strong', '', name));
      button.addEventListener('click', () => {
        setConsolePaneMode('session', false);
        setFeedView('console', true);
        selectConsoleSession(key);
      });
      header.append(button);
    } else {
      header.append(el('strong', '', name));
    }
    const meta = el('span', 'timeline-meta');
    const parts = [row.project || '', row.host || '', row.accountAlias || 'Unassigned account', row.harness === 'omp' ? 'OMP' : 'Claude'].filter(Boolean);
    meta.textContent = `${parts.join(' · ')} · `;
    const ts = Number(byId(row, 'ts')), date = new Date(ts);
    const time = el('time', 'timeline-time', relative(ts));
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.title = date.toLocaleString();
    }
    meta.append(time);
    header.append(meta);
    item.append(header);
    item.append(responseBlock(row,row)); return item;
  }
  function prependTimelineResponses(dto, previous) {
    if ((!$('#headless-filter').checked && (byId(dto,'interactive') === false || byId(dto,'interactive') === 0)) ||
        ($('#host-filter').value && byId(dto,'host') !== $('#host-filter').value) ||
        ($('#harness-filter').value && byId(dto,'harness') !== $('#harness-filter').value)) return;
    const known=new Set(state.timeline.map(r=>String(byId(r,'id'))));
    const previousIds=new Set(responsesOf(previous||{}).map(r=>String(byId(r,'id'))));
    const newest=state.timeline.length ? Number(byId(state.timeline[0],'ts')) : -Infinity;
    const fresh=responsesOf(dto).filter(r=>byId(r,'id') != null && !known.has(String(byId(r,'id'))) &&
      !previousIds.has(String(byId(r,'id'))) && Number(byId(r,'ts'))>=newest);
    if (!fresh.length) return;
    const rows=fresh.map(r=>({...r, sessionKey:responseKey(dto), host:byId(dto,'host'), harness:byId(dto,'harness'), accountAlias:byId(dto,'accountAlias'), displayName:nameOf(dto), title:byId(dto,'title'), cwd:byId(dto,'cwd'), project:byId(dto,'project')})).sort((a,b)=>Number(byId(b,'ts'))-Number(byId(a,'ts')));
    state.timeline.unshift(...rows);
    const oldY=window.scrollY;
    for (const { list, empty, more } of timelineTargets()) {
      list.prepend(...rows.map(timelineItem));
      empty.textContent = state.timeline.length && !list.childElementCount
        ? 'No responses in the loaded timeline match these filters.' : 'No responses yet.';
      empty.hidden = list.childElementCount > 0;
      more.hidden = state.timelineDone===true;
    }
    updateTimelineSummary();
    if (state.view==='timeline') window.scrollTo(0,oldY);
  }
  async function loadTimeline(append=false, preserveLoadedPages=false) {
    if(state.timelineLoading || (append && state.timelineDone)) return;
    state.timelineLoading=true;
    try {
      const params=new URLSearchParams({limit:'100',headless:$('#headless-filter').checked?'1':'0',ended:'1',host:$('#host-filter').value,harness:$('#harness-filter').value}); if(append&&state.before) params.set('before',state.before);
      const response=await fetch(`/api/timeline?${params}`); if(!response.ok) throw Error(`timeline ${response.status}`);
      const payload=await response.json(), rows=Array.isArray(payload)?payload:(payload.responses||payload.timeline||[]);
      if(!append && preserveLoadedPages) {
        const previous=state.timeline, previousDone=state.timelineDone, fetchedIds=new Set(rows.map(r=>String(byId(r,'id'))));
        state.timeline=[...rows,...previous.filter(r=>!fetchedIds.has(String(byId(r,'id'))))].sort((a,b)=>Number(byId(b,'ts'))-Number(byId(a,'ts')));
        state.before=state.timeline.length?String(byId(state.timeline[state.timeline.length-1],'ts')):state.before;
        state.timelineDone=previousDone||rows.length<100;
      } else {
        if(!append) state.timeline=[];
        state.timeline.push(...rows); state.before=rows.length?String(byId(rows[rows.length-1],'ts')):state.before; state.timelineDone=rows.length<100;
      }
      refreshProjectFilter();
      renderTimeline(append && !preserveLoadedPages);
    } finally { state.timelineLoading=false; }
  }
  // Ideas inbox (AXI-445 step 5, C6). Its routes return 404 while replies are off, so the header button stays hidden then.
  const ideasState = { open: 0, failed: false, showAll: false, items: [], version: 0, busy: new Set(), adding: false, picks: new Map() };
  const ideaSessions = () => state.sessions.filter(session => messageCapability(session).allowed);
  const ideaOptionLabel = session => `${nameOf(session)} · ${byId(session, 'host') || 'Unknown host'}`;
  const ideaSignature = (sessions) => sessions.map(session => `${responseKey(session)}\u0001${ideaOptionLabel(session)}`).join('\u0002');
  function ideaNotice(text, error = false) {
    const node = $('#ideas-status');
    node.textContent = text; node.classList.toggle('ideas-error', error);
  }
  function ideaErrorText(response, payload) {
    const detail = typeof payload?.error === 'string' ? payload.error : typeof payload?.reason === 'string' ? payload.reason : '';
    return detail || `HTTP ${response.status}`;
  }
  function paintIdeasBadge() {
    $('#ideas-badge').textContent = ideasState.failed ? '!' : String(ideasState.open);
    $('#ideas-badge').classList.toggle('ideas-failed', ideasState.failed);
    $('#ideas-open').title = ideasState.failed ? 'Ideas could not be loaded' : `Ideas: ${ideasState.open} open`;
  }
  function ideaRow(idea, sessions) {
    const row = el('li', 'idea-row'), busy = ideasState.busy.has(idea.id);
    const sourceText = idea.source === 'telegram' ? 'Telegram' : 'Dashboard';
    const stateText = idea.state === 'open' ? '' : idea.state === 'sent' ? ' · sent' : ' · archived';
    row.append(el('p', 'idea-text', idea.text), el('p', 'idea-meta', `${relative(idea.createdAt)} · from ${sourceText}${stateText}`));
    if (idea.state === 'sent') {
      const named = state.sessions.find(session => responseKey(session) === idea.sentSessionKey);
      row.append(el('p', 'idea-meta', named ? `Sent to ${nameOf(named)}` : 'Sent to a session'));
    }
    if (idea.state === 'open') {
      const select = el('select', 'idea-target'), actions = el('div', 'idea-actions');
      const send = el('button', 'button button-secondary idea-send', 'Send'), archive = el('button', 'button button-secondary', 'Archive');
      select.setAttribute('aria-label', `Session for idea ${idea.id}`);
      for (const session of sessions) select.append(new Option(ideaOptionLabel(session), responseKey(session)));
      if (!sessions.length) select.append(new Option('No session can take a message right now', ''));
      const wanted = ideasState.picks.get(idea.id);
      select.value = sessions.some(session => responseKey(session) === wanted) ? wanted : (sessions.length ? responseKey(sessions[0]) : '');
      select.disabled = busy || !sessions.length;
      send.type = 'button'; archive.type = 'button';
      send.disabled = busy || !sessions.length; archive.disabled = busy;
      select.addEventListener('change', () => ideasState.picks.set(idea.id, select.value));
      send.addEventListener('click', () => sendIdea(idea, select.value));
      archive.addEventListener('click', () => archiveIdea(idea));
      actions.append(select, send, archive); row.append(actions);
    }
    return row;
  }
  function renderIdeas() {
    const list = $('#ideas-list'), sessions = ideaSessions();
    list.dataset.sessions = ideaSignature(sessions);
    list.replaceChildren(...ideasState.items.map(idea => ideaRow(idea, sessions)));
    $('#ideas-empty').hidden = ideasState.items.length > 0;
    $('#ideas-empty').textContent = ideasState.showAll ? 'No ideas yet.' : 'No open ideas.';
    $('#ideas-show-all').setAttribute('aria-pressed', String(ideasState.showAll));
  }
  // Session changes can alter the picker's options; rebuild only when the deliverable set changes, so an open select is not reset.
  function syncIdeaSessions() {
    if ($('#ideas-list').dataset.sessions !== ideaSignature(ideaSessions())) renderIdeas();
  }
  async function refreshIdeas(clearStatus = false) {
    if (!state.repliesEnabled) return;
    const version = ++ideasState.version, filter = ideasState.showAll ? 'all' : 'open';
    try {
      const response = await fetch(`/api/ideas?state=${filter}`, { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (version !== ideasState.version) return;
      if (!response.ok) throw new Error(ideaErrorText(response, payload));
      if (clearStatus || ideasState.failed) ideaNotice('');
      ideasState.failed = false; ideasState.items = Array.isArray(payload.ideas) ? payload.ideas : [];
      if (Number.isInteger(payload.open) && payload.open >= 0) ideasState.open = payload.open;
      paintIdeasBadge(); renderIdeas();
    } catch (error) {
      if (version !== ideasState.version) return;
      ideasState.failed = true; paintIdeasBadge();
      ideaNotice(`Ideas could not be loaded: ${error.message || 'network error'}`, true);
    }
  }
  async function runIdeaAction(id, request) {
    ideasState.busy.add(id); renderIdeas();
    try { await request(); }
    catch (error) { ideaNotice(`Request failed: ${error.message || 'network error'}`, true); }
    finally { ideasState.busy.delete(id); await refreshIdeas(); }
  }
  function sendIdea(idea, key) {
    if (!key) return;
    const target = state.sessions.find(session => responseKey(session) === key);
    return runIdeaAction(idea.id, async () => {
      const response = await postJson(`/api/ideas/${encodeURIComponent(idea.id)}/send`, { key });
      const payload = await response.json().catch(() => ({}));
      ideaNotice(response.ok ? `Sent to ${nameOf(target)}.` : `Could not send: ${ideaErrorText(response, payload)}`, !response.ok);
    });
  }
  function archiveIdea(idea) {
    return runIdeaAction(idea.id, async () => {
      const response = await postJson(`/api/ideas/${encodeURIComponent(idea.id)}/archive`);
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) ideaNotice('That idea was already sent or archived.', true);
      else ideaNotice(response.ok ? 'Idea archived.' : `Could not archive: ${ideaErrorText(response, payload)}`, !response.ok);
    });
  }
  async function addIdea(event) {
    event.preventDefault();
    const box = $('#idea-text'), text = box.value.trim();
    if (!text) { ideaNotice('Type an idea first.', true); return; }
    if (text.length > 4000) { ideaNotice('Ideas can be up to 4000 characters.', true); return; }
    if (ideasState.adding) return;
    ideasState.adding = true; $('#idea-add').disabled = true;
    try {
      const response = await postJson('/api/ideas', { text });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) { box.value = ''; ideaNotice('Saved to Ideas.'); }
      else ideaNotice(`Could not add the idea: ${ideaErrorText(response, payload)}`, true);
    } catch (error) { ideaNotice(`Could not add the idea: ${error.message || 'network error'}`, true); }
    finally { ideasState.adding = false; $('#idea-add').disabled = false; await refreshIdeas(); }
  }
  $('#ideas-open').addEventListener('click', () => { showNavigationDialog('ideas-dialog'); refreshIdeas(true); });
  $('#ideas-show-all').addEventListener('click', () => { ideasState.showAll = !ideasState.showAll; refreshIdeas(true); });
  $('#idea-form').addEventListener('submit', addIdea);

  function connect() {
    state.source?.close(); const source=new EventSource('/api/stream'); state.source=source;
    source.onopen=()=>{ setConnection('Live',true); loadConsolePreferencesRemote(); scheduleSourcesRefresh(); refreshReplyAvailability().catch(()=>{}).then(()=>loadSessions().catch(()=>{})).then(()=>{ if(consoleState.selectedKey) fetchReadPosition(consoleState.selectedKey,consoleState.selectionVersion); }); refreshTelegram().catch(()=>{}); refreshIdeas(true); loadTimeline(false,true).catch(()=>{}); }; source.onerror=()=>setConnection('Reconnecting',false);
    source.addEventListener('console-preferences', event => {
      try {
        if (acceptConsolePreferences(JSON.parse(event.data), 'remote')) updateConsolePinButtons();
      } catch (error) {
        consolePreferences.error = error.message || 'Shared preferences update could not be read.';
        consolePreferences.errorSource = 'stream';
        renderConsolePreferences();
      }
    });
    source.addEventListener('session',event=>{ try {
      const dto=JSON.parse(event.data); recordCapabilityReceipt(dto?.capabilities); scheduleSourcesRefresh(); const key=responseKey(dto), i=state.sessions.findIndex(s=>responseKey(s)===key), previous=i<0?null:state.sessions[i];
      if(previous && statusOf(previous)!=='needs_input' && statusOf(dto)==='needs_input' && notificationPreference('needs')) notify(nameOf(dto),'Needs your input');
      const oldIds=new Set(responsesOf(previous||{}).map(r=>String(byId(r,'id'))));
      if(previous && notificationPreference('response') && responsesOf(dto).some(r=>!oldIds.has(String(byId(r,'id'))))) notify(nameOf(dto),'New response');
      state.priorStatus.set(key,statusOf(dto));
      if(i<0) state.sessions.push(dto); else state.sessions[i]=dto;
      const historicalTarget = consoleState.historicalTarget;
      if (historicalTarget?.key === key) {
        historicalTarget.session = dto;
        if (historicalTarget.response) consoleState.reading.set(key, historicalReading(dto, historicalTarget.response));
      }
      if (consoleState.allSessions?.has(key)) consoleState.allSessions.set(key, dto);
      prunePicks();
      refreshSessionFilters(); patchSessionCard(dto,previous); prependTimelineResponses(dto,previous);
      renderPinnedSessions(); syncIdeaSessions();
      if (key === consoleState.selectedKey) fetchReadPosition(key, consoleState.selectionVersion);
    } catch {} });
    source.addEventListener('sources',()=>scheduleSourcesRefresh());
    source.addEventListener('identity',event=>{ try { const dto=JSON.parse(event.data); recordCapabilityReceipt(dto?.capabilities); } catch {} scheduleSourcesRefresh(); });
    source.addEventListener('reply',event=>{ try {
      const update=JSON.parse(event.data);
      if (typeof update?.key === 'string' && state.repliesEnabled) refreshReplyList(update.key);
    } catch {} });
    source.addEventListener('ideas',event=>{ try { const update=JSON.parse(event.data); if (Number.isInteger(update?.open) && update.open >= 0) ideasState.open = update.open; } catch {} paintIdeasBadge(); refreshIdeas(); });
  }
  function notificationPreference(which) { try { return localStorage.getItem(`dash.notify.${which}`)==='1' && Notification.permission==='granted'; } catch { return false; } }
  function notify(title,body) { try { if('Notification' in window && Notification.permission==='granted') new Notification(title,{body}); } catch {} }
  function loadNotificationPrefs() { try { $('#notify-needs').checked=localStorage.getItem('dash.notify.needs')==='1'; $('#notify-response').checked=localStorage.getItem('dash.notify.response')==='1'; } catch {} }

  function setFeedView(view, pushUrl = false) {
    state.view = ['console', 'sessions', 'timeline'].includes(view) ? view : 'console';
    setViewUrl(state.view, pushUrl);
    const isTimeline = state.view === 'timeline';
    ['console', 'sessions', 'timeline'].forEach(name => {
      const id = `${name}-tab`, selected = state.view === name;
      const tab = $('#'+id);
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    for (const name of ['console', 'sessions', 'timeline']) $(`#${name}-view`).hidden = state.view !== name;
    renderSessions();
    $('#ended-filter-label').hidden = isTimeline;
    for (const node of document.querySelectorAll('.session-filter')) node.hidden = isTimeline;
    $('#output-search-disclosure').hidden = isTimeline;
    $('#timeline-filter-note').hidden = !isTimeline;
    refreshVisibleReplyLists();
    if (isTimeline) loadTimeline(false).catch(()=>{});
  }
  $('#console-tab').addEventListener('click',()=>setFeedView('console',true));
  $('#sessions-tab').addEventListener('click',()=>setFeedView('sessions',true));
  $('#timeline-tab').addEventListener('click',()=>setFeedView('timeline',true));
  $('#console-pane-session').addEventListener('click',()=>setConsolePaneMode('session'));
  $('#console-pane-timeline').addEventListener('click',()=>setConsolePaneMode('timeline'));
  $('#feed-tabs').addEventListener('keydown',event=>{
    const tabs = [$('#console-tab'), $('#sessions-tab'), $('#timeline-tab')], current = tabs.indexOf(event.target?.closest?.('[role="tab"]'));
    if (current < 0) return;
    let next;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });
  $('#session-search').addEventListener('input', () => { renderSessions(); refreshVisibleReplyLists(); });
  $('#output-search-form').addEventListener('submit', event => { event.preventDefault(); runOutputSearch(); });
  $('#output-search-query').addEventListener('input', () => invalidateOutputSearch('Query changed. Search again to view matching output.'));
  $('#output-search-more').addEventListener('click', () => runOutputSearch(true));
  ['host-filter','harness-filter'].forEach(id=>$('#'+id).addEventListener('change',()=>{
    invalidateOutputSearch('Output filters changed. Search again to apply them.');
    renderSessions();refreshVisibleReplyLists();loadTimeline(false).catch(()=>{});
  }));
  ['project-filter', 'account-filter', 'status-filter'].forEach(id => $('#'+id).addEventListener('change', () => {
    if ($('#status-filter').value === 'ended' && !$('#ended-filter').checked) {
      $('#ended-filter').checked = true;
      invalidateOutputSearch('Output filters changed. Search again to apply them.');
      loadSessions().catch(()=>{});
    } else if (id !== 'status-filter') invalidateOutputSearch('Output filters changed. Search again to apply them.');
    renderSessions(); refreshVisibleReplyLists();
    if (id === 'project-filter') { persistProjectFilter(); if (state.view === 'timeline') renderTimeline(); }
  }));
  $('.filters').addEventListener('change', renderConsolePreferences);
  $('#group-filter').addEventListener('change', () => { renderConsole(); renderConsolePreferences(); });
  $('#sources-disclosure').addEventListener('toggle', updateSourcesTimers);
  $('#sources-refresh').addEventListener('click', refreshSourceSnapshot);
  $('#next-unresolved').addEventListener('click', nextUnresolved);
  for (const [id, status] of [['needs', 'needs_input'], ['unread', 'unread'], ['working', 'working']]) {
    $(`#${id}-filter-toggle`).addEventListener('click', () => {
      $('#status-filter').value = $('#status-filter').value === status ? '' : status; setFeedView('console');
    });
  }
  $('#clear-filters').addEventListener('click', () => {
    for (const id of ['project', 'host', 'account', 'harness', 'status']) $(`#${id}-filter`).value = '';
    persistProjectFilter();
    $('#session-search').value = '';
    $('#headless-filter').checked = false; $('#ended-filter').checked = false;
    invalidateOutputSearch('Output filters changed. Search again to apply them.');
    renderSessions(); refreshVisibleReplyLists(); loadSessions().catch(()=>{});
    renderConsolePreferences();
    loadTimeline(false).catch(()=>{});
  });
  $('#headless-filter').addEventListener('change',()=>{invalidateOutputSearch('Output filters changed. Search again to apply them.');loadSessions().catch(()=>{});loadTimeline(false).catch(()=>{});});
  $('#ended-filter').addEventListener('change',()=>{invalidateOutputSearch('Output filters changed. Search again to apply them.');loadSessions().catch(()=>{});});
  $('#mark-all').addEventListener('click',markAll);
  ['timeline-more','console-timeline-more','console-pane-timeline-more'].forEach(id=>$('#'+id).addEventListener('click',()=>loadTimeline(true).catch(()=>{})));
  window.addEventListener('scroll',()=>{if(state.view==='timeline'&&!state.timelineDone&&!state.timelineLoading&&window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-600) loadTimeline(true).catch(()=>{});},{passive:true});
  $('#notification-settings').addEventListener('click',()=>$('#notifications-dialog').showModal());
  $('#notification-enable').addEventListener('click',()=>$('#notifications-dialog').showModal());
  $('#notify-needs').addEventListener('change',e=>{try{localStorage.setItem('dash.notify.needs',e.target.checked?'1':'0')}catch{}});
  $('#notify-response').addEventListener('change',e=>{try{localStorage.setItem('dash.notify.response',e.target.checked?'1':'0')}catch{}});
  $('#enable-notifications').addEventListener('click',async()=>{const status=$('#notification-status');try{if(!('Notification'in window)){status.textContent='Notifications are not supported in this browser.';return}const permission=await Notification.requestPermission();status.textContent=permission==='granted'?'Notifications enabled.':'Permission was not granted.';}catch{status.textContent='Could not request notification permission.'}});
  $('#project-rule-add').addEventListener('click',()=>{if(projectRulesState.rows.length>=32)return;projectRulesState.rows.push({pattern:'',project:''});projectRuleRowsChanged();renderProjectRuleRows();});
  $('#project-rule-save').addEventListener('click',saveProjectRules);
  $('#project-test-path').addEventListener('input',scheduleProjectPreview);
  $('#console-density').addEventListener('change', () => { saveConsolePreferences(); renderConsolePreferences(); });
  for (const input of document.querySelectorAll('[data-console-column]')) input.addEventListener('change', () => {
    saveConsolePreferences(); renderConsolePreferences();
  });
  $('#console-view-select').addEventListener('change', event => {
    const id = event.target.value;
    if (id) applyConsoleView(id);
    else {
      consolePreferences.selectedViewId = null;
      consolePreferences.appliedViewConfig = null;
      consolePreferences.viewChangedElsewhere = false;
      consolePreferences.notice = 'Custom filters selected. Current filters, session selection and drafts were kept.';
      renderConsolePreferences();
    }
  });
  $('#console-view-apply').addEventListener('click', () => {
    if (consolePreferences.selectedViewId) applyConsoleView(consolePreferences.selectedViewId);
  });
  $('#console-view-create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const captured = captureConsoleViewConfig();
    if (captured.error) {
      consolePreferences.notice = captured.error;
      renderConsolePreferences();
      return;
    }
    const result = await mutateConsolePreferences({
      action: 'create', name: $('#console-view-create-name').value, config: captured.config,
    });
    if (result) {
      $('#console-view-create-name').value = '';
      consolePreferences.notice = 'Saved view created. Select it from View when you want to apply it.';
      renderConsolePreferences();
    }
  });
  $('#console-view-name').addEventListener('input', event => { consolePreferences.renameDraft = event.target.value; });
  $('#console-view-rename').addEventListener('click', async () => {
    const id = consolePreferences.selectedViewId;
    if (!id) return;
    const result = await mutateConsolePreferences({ action: 'update', id, name: $('#console-view-name').value });
    if (result) {
      const renamed = consolePreferences.views.find(view => view.id === id);
      if (renamed) {
        consolePreferences.renameDraftViewId = id;
        consolePreferences.renameDraft = renamed.name;
      }
      consolePreferences.notice = 'Saved view renamed.';
      renderConsolePreferences();
    }
  });
  $('#console-view-update').addEventListener('click', async () => {
    const id = consolePreferences.selectedViewId;
    if (!id) return;
    const captured = captureConsoleViewConfig();
    if (captured.error) {
      consolePreferences.notice = captured.error;
      renderConsolePreferences();
      return;
    }
    const result = await mutateConsolePreferences({ action: 'update', id, config: captured.config });
    if (result) {
      const latest = consolePreferences.views.find(view => view.id === id);
      if (latest && consoleConfigSignature(latest.config) === consoleConfigSignature(captured.config)) {
        consolePreferences.appliedViewConfig = copyConsoleConfig(captured.config);
        consolePreferences.viewChangedElsewhere = false;
      }
      consolePreferences.notice = 'Saved view updated from the current filters.';
      renderConsolePreferences();
    }
  });
  $('#console-view-delete').addEventListener('click', async () => {
    const id = consolePreferences.selectedViewId;
    if (!id) return;
    const result = await mutateConsolePreferences({ action: 'delete', id });
    if (result) {
      consolePreferences.notice = 'Saved view deleted. Current filters, session selection and drafts were kept.';
      renderConsolePreferences();
    }
  });
  $('#console-pins-disclosure').addEventListener('toggle', event => {
    if (event.target.open) refreshPinnedAvailability();
  });
  $('#console-pins-refresh').addEventListener('click', refreshPinnedAvailability);
  $('#console-views-close').addEventListener('click', () => { $('#console-views-management').open = false; });
  $('#console-pins-close').addEventListener('click', () => { $('#console-pins-disclosure').open = false; });
  $('#console-pin-selected').addEventListener('click', () => {
    const key = consoleState.selectedKey;
    toggleConsolePin(key, !consolePreferences.pins.includes(key));
  });
  $('#console-sort').addEventListener('click', () => { consoleState.order = sortSessions(state.sessions).map(responseKey); renderConsole(); });
  $('#console-update').addEventListener('click', applyConsoleLatest);
  $('#console-next-unread').addEventListener('click', nextUnreadResponse);
  $('#console-mark-response-read').addEventListener('click', markDisplayedResponseRead);
  $('#console-follow').addEventListener('change', event => { consoleState.follow = event.target.checked; if (consoleState.follow) applyConsoleLatest(); });
  $('#console-history-more').addEventListener('click', loadConsoleHistory);
  $('#console-copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('#console-selection-status').textContent = 'Session link copied.'; }
    catch { $('#console-selection-status').textContent = 'Copy the session URL from the address bar.'; }
  });
  for (const button of document.querySelectorAll('[data-comparison-set]')) {
    button.addEventListener('click', () => setComparison(button.dataset.comparisonSet));
  }
  for (const button of document.querySelectorAll('[data-comparison-copy]')) {
    button.addEventListener('click', () => copyComparison(button.dataset.comparisonCopy));
  }
  for (const button of document.querySelectorAll('[data-comparison-clear]')) {
    button.addEventListener('click', () => {
      const side = button.dataset.comparisonClear;
      comparisonSlots[side] = null;
      renderComparisonSide(side);
    });
  }
  $('#selective-add').addEventListener('click', addSelectiveTarget);
  $('#selective-prompt').addEventListener('input', renderSelectiveSend);
  $('#selective-preview').addEventListener('click', previewSelectiveSend);
  $('#selective-confirm').addEventListener('click', confirmSelectiveSend);
  $('#selective-edit').addEventListener('click', () => {
    if (selectiveSendState.phase !== 'preview') return;
    selectiveSendState.phase = 'draft'; renderSelectiveSend(); $('#selective-prompt').focus();
  });
  $('#selective-refresh').addEventListener('click', () => {
    for (const [key, target] of selectiveSendState.targets) if (target.replyId) {
      stopReplyRefresh(key); refreshReplyList(key);
    }
  });
  $('#selective-new').addEventListener('click', () => {
    if (selectiveSendState.phase !== 'complete') return;
    selectiveSendState.targets.clear(); selectiveSendState.text = ''; selectiveSendState.submitted = 0;
    selectiveSendState.phase = 'draft'; $('#selective-prompt').value = '';
    renderSelectiveSend(); refreshVisibleReplyLists(); $('#selective-add').focus();
  });
  function restoreConsoleLocation() {
    const locationState = readConsoleLocation(), previous = consoleState.historicalTarget;
    if (previous) {
      consoleState.reading.delete(previous.key);
      consoleState.history.delete(previous.key);
    }
    consoleState.selectedKey = locationState.key;
    consoleState.inventorySelection = '';
    const target = historicalTargetFromLocation(locationState);
    consoleState.historicalTarget = target;
    if (target) {
      consoleState.reading.delete(target.key);
      consoleState.history.delete(target.key);
      target.session = state.sessions.find(session => responseKey(session) === target.key) || null;
      consoleState.follow = false;
      $('#console-follow').checked = false;
    }
    beginConsoleSelection(locationState.key, Boolean(locationState.key) && !target, Boolean(locationState.key));
    setFeedView(locationState.view);
    renderConsoleHistory();
    if (target?.status === 'loading') startHistoricalResponse(target);
    else if (locationState.key && !state.sessions.some(session => responseKey(session) === locationState.key)) {
      loadSessions({ includeAll: true }).catch(() => {
        if (consoleState.selectedKey === locationState.key) $('#console-selection-status').textContent = 'Selected session could not be loaded; the link may be out of date.';
      });
    }
  }
  window.addEventListener('popstate', restoreConsoleLocation);
  if (consoleState.selectedKey) { $('#headless-filter').checked = true; $('#ended-filter').checked = true; }
  loadDraftRecovery();
  window.setInterval(expireDraftRecovery, 1000);
  window.addEventListener('pagehide', () => { if (draftRecovery.timer !== null) persistDraftRecovery(); });
  window.addEventListener('pageshow', expireDraftRecovery);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) expireDraftRecovery();
    else if (draftRecovery.timer !== null) persistDraftRecovery();
  });
  restoreProjectFilter();
  loadConsolePreferences();
  loadConsolePreferencesRemote();
  if (initialConsoleLocation.view !== 'console') setFeedView(initialConsoleLocation.view);
  loadNotificationPrefs(); refreshSourceSnapshot(); refreshReplyAvailability().catch(()=>{}).then(()=>loadSessions({includeAll:Boolean(consoleState.selectedKey)}).catch(()=>setConnection('Offline',false))); loadTimeline(false).catch(()=>{}); refreshTelegram().catch(()=>{}); window.setInterval(refreshTelegram, 30000); connect();
})();
