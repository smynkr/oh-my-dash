(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const sessionsNode = $('#sessions');
  const timelineNode = $('#timeline');
  const state = { sessions: [], timeline: [], before: null, timelineDone: false, timelineLoading: false, expanded: new Set(), priorStatus: new Map(), view: 'sessions', source: null, drafts: new Map(), replyStates: new Map(), replyFetchVersion: new Map(), replyNotices: new Map(), replyPending: new Set(), cancelPending: new Set(), replyRefreshTimers: new Map(), replyRefreshUntil: new Map(), picks: new Map(), repliesEnabled: false };
  const byId = (o, camel, snake = camel) => o?.[camel] ?? o?.[snake];
  const esc = (value) => String(value ?? '');
  const responseKey = (s) => String(byId(s, 'key', 'key') ?? `${byId(s,'host')}|${byId(s,'harness')}|${byId(s,'sessionId','session_id')}`);
  const responsesOf = (s) => byId(s, 'lastResponses', 'responses') ?? [];
  const projectRulesState = { rows: [], storedIssue: '', version: 0, previewTimer: 0, previewRequest: 0 };
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
    const response = await fetch('/api/projects/rules');
    if (!response.ok) throw new Error('Project rules unavailable');
    const payload = await response.json();
    projectRulesState.rows = (Array.isArray(payload.rules) ? payload.rules : []).map((rule) => ({ pattern: String(rule?.pattern ?? ''), project: String(rule?.project ?? '') }));
    projectRulesState.storedIssue = (payload.errors || []).some((item) => item?.index === -1)
      ? 'Stored project rules are malformed. Defaults are shown; saving will replace the stored value.' : '';
    $('#project-rules-notice').textContent = projectRulesState.storedIssue;
    $('#project-rules-panel').hidden = false;
    $('#project-rules-disclosure').hidden = false;
    $('#project-rules-status').textContent = '';
    renderProjectRuleRows(payload.errors || []);
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

  function replyDialogCopy(s) {
    if (statusOf(s) !== 'needs_input') return '';
    const reason = byId(s, 'needsReason', 'needs_reason');
    if (byId(s, 'harness') === 'claude' && ['question','permission','permission_prompt','elicitation_dialog','elicitation_url_dialog'].includes(reason)) return 'Answer in the terminal or Remote Control (dialog answering: Step 6)';
    if (byId(s, 'harness') === 'omp' && reason === 'permission') return 'Approve in the terminal (dialog answering: Step 6)';
    return '';
  }
  function replyNotice(key, message) {
    if (message) state.replyNotices.set(key, message); else state.replyNotices.delete(key);
    const session = state.sessions.find(item => responseKey(item) === key);
    if (session) patchSessionCard(session, session);
  }
  function replyApiPath(key, suffix = '') { return `/api/sessions/${encodeURIComponent(key)}/replies${suffix}`; }
  async function refreshReplyAvailability() {
    const response = await fetch('/healthz');
    if (!response.ok) throw new Error('Reply status unavailable');
    const payload = await response.json(), enabled = payload?.replies?.enabled === true;
    if (enabled === state.repliesEnabled) return enabled;
    state.repliesEnabled = enabled;
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
    const visible = state.repliesEnabled && state.view === 'sessions' && visibleSessions().some(session => responseKey(session) === key && statusOf(session) !== 'ended');
    const hasLeased = (state.replyStates.get(key) || []).some(reply => reply.state === 'leased');
    if (!visible || !hasLeased) { stopReplyRefresh(key); return; }
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
      const payload = await response.json();
      if (state.replyFetchVersion.get(key) !== version) return;
      state.replyStates.set(key, Array.isArray(payload?.replies) ? payload.replies : []);
      const session = state.sessions.find(item => responseKey(item) === key);
      if (session) patchSessionCard(session, session);
      scheduleReplyRefresh(key);
    } catch { scheduleReplyRefresh(key); }
  }
  function refreshVisibleReplyLists() {
    const visible = state.repliesEnabled && state.view === 'sessions' ? visibleSessions().filter(session => statusOf(session) !== 'ended') : [];
    const visibleKeys = new Set(visible.map(responseKey));
    for (const key of new Set([...state.replyRefreshTimers.keys(), ...state.replyRefreshUntil.keys()])) if (!visibleKeys.has(key)) stopReplyRefresh(key);
    for (const session of visible) refreshReplyList(responseKey(session));
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
  async function submitReply(key, text, answersTurn, answersQuestion) {
    if (state.replyPending.has(key)) return;
    const session = state.sessions.find(item => responseKey(item) === key);
    if (!session || statusOf(session) === 'ended' || replyDialogCopy(session)) return;
    if (answersQuestion !== undefined && (session.pendingQuestion?.id ?? session.pendingQuestionId) !== answersQuestion) {
      replyNotice(key, 'Out of date: the question has been answered or replaced');
      await loadSessions().catch(() => {});
      return;
    }
    state.replyPending.add(key);
    state.replyNotices.delete(key);
    patchSessionCard(session, session);
    try {
      const body = { text, ...(answersTurn === undefined ? {} : { answersTurn }), ...(answersQuestion === undefined ? {} : { answersQuestion }) };
      const response = await postJson(`/api/sessions/${encodeURIComponent(key)}/reply`, body);
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        if (response.status === 404 && payload.error === 'not found') {
          await refreshReplyAvailability().catch(() => {});
          return;
        }
        if (response.status === 409 && ['stale_turn', 'stale_question'].includes(payload?.reason)) {
          await loadSessions().catch(() => {});
          replyNotice(key, payload.reason === 'stale_question' ? 'Out of date: the question has been answered or replaced' : 'Out of date: the session has moved on');
        } else replyNotice(key, payload?.reason === 'invalid_question' ? 'Could not send this answer. Keep it under 4,000 characters and refresh the question.' : 'Could not send this reply.');
        return;
      }
      const draftKey = answersQuestion === undefined ? key : `${key}#${answersQuestion}`;
      if (answersTurn === undefined && state.drafts.get(draftKey) === text) state.drafts.delete(draftKey);
      if (answersTurn !== undefined) state.picks.delete(`${key}#${answersTurn}`);
      await refreshReplyList(key);
    } catch { replyNotice(key, 'Could not send this reply.'); }
    finally {
      state.replyPending.delete(key);
      const current = state.sessions.find(item => responseKey(item) === key);
      if (current) patchSessionCard(current, current);
    }
  }

  function renderReplyControls(s, key, status, responses) {
    if (!state.repliesEnabled || status === 'ended') return null;
    const controls = el('section', 'reply-controls');
    const dialogCopy = replyDialogCopy(s), busy = state.replyPending.has(key);
    const pendingId = byId(s, 'harness') === 'omp' && status === 'needs_input' && !dialogCopy ? s.pendingQuestion?.id ?? s.pendingQuestionId : undefined;
    const pending = pendingId ? s.pendingQuestion : undefined;
    const draftKey = pendingId ? `${key}#${pendingId}` : key;
    if (pending) controls.append(renderPendingQuestion(key, pending, busy));
    const reason = byId(s, 'needsReason', 'needs_reason');
    const hint = dialogCopy || (byId(s, 'harness') === 'claude' && status === 'working' ? 'Queues until the next safe point' : byId(s, 'harness') === 'omp' && status === 'needs_input' && reason === 'question' ? "Answers omp's pending question" : 'Cmd/Ctrl+Enter to send');
    const label = el('label', 'reply-label', `Reply to ${nameOf(s)}`), textarea = el('textarea', 'reply-input');
    textarea.rows = 3; textarea.value = state.drafts.get(draftKey) ?? ''; textarea.disabled = Boolean(dialogCopy);
    textarea.setAttribute('aria-label', `Reply to ${nameOf(s)}`); textarea.dataset.replyFocus = 'input';
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!textarea.disabled && textarea.value.trim()) submitReply(key, textarea.value, undefined, pendingId);
      }
    });
    label.append(textarea); controls.append(label, el('p', `reply-hint${dialogCopy ? ' reply-dialog-note' : ''}`, hint));
    const actions = el('div', 'reply-actions'), send = el('button', 'button button-primary', 'Send reply');
    send.type = 'button'; send.disabled = Boolean(dialogCopy) || busy || !textarea.value.trim(); send.dataset.replyFocus = 'send';
    textarea.addEventListener('input', () => {
      state.drafts.set(draftKey, textarea.value);
      send.disabled = Boolean(dialogCopy) || state.replyPending.has(key) || !textarea.value.trim();
    });
    send.addEventListener('click', () => submitReply(key, textarea.value, undefined, pendingId)); actions.append(send);
    const turnSeq = Number(byId(s, 'turnSeq', 'turn_seq') || 0), current = currentTurnResponse(responses, turnSeq);
    if (!pendingId && responses.length > 0 && turnSeq > 0) {
      const ready = status === 'your_turn' && !dialogCopy && !busy && Boolean(current);
      if (current) controls.append(...renderDecisions(key, current, turnSeq, ready));
      else controls.append(el('p', 'reply-hint reply-dialog-note', "Quick actions are off: the latest response isn't this turn's. Reply with text."));
      const continueButton = el('button', 'button button-secondary', '▶️ Continue');
      continueButton.type = 'button'; continueButton.disabled = !ready; continueButton.dataset.replyFocus = 'continue';
      continueButton.addEventListener('click', () => submitReply(key, 'Continue with the next step you recommended.', turnSeq));
      const recommendationButton = el('button', 'button button-secondary', "⭐ Rec · auth'd");
      recommendationButton.type = 'button'; recommendationButton.disabled = !ready; recommendationButton.dataset.replyFocus = 'recommendation';
      recommendationButton.addEventListener('click', () => submitReply(key, 'Go with your recommendation(s) in your last message. You are authorized for the action(s) you asked about there, including any approval, additional review waves, or destructive steps they require. This authorization covers only what your last message asked about.', turnSeq));
      actions.append(continueButton, recommendationButton);
    }
    controls.append(actions);
    const replies = state.replyStates.get(key) || [];
    if (replies.length) {
      const list = el('ul', 'reply-history'); list.setAttribute('aria-label', 'Recent replies');
      for (const reply of replies) {
        const item = el('li', 'reply-history-item'), stateName = String(reply.state || 'unknown');
        const stateLabel = stateName === 'cancelled' ? 'Cancelled' : stateName.charAt(0).toUpperCase() + stateName.slice(1);
        item.append(el('span', 'reply-history-state', stateLabel), el('span', 'reply-history-source', String(reply.source || 'unknown')));
        if (reply.state === 'leased' && reply.committed === true) item.append(el('span', 'reply-history-committed', 'Committed'));
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

  function renderPendingQuestion(key, pending, busy) {
    const pickKey = `${key}#${pending.id}`, questions = pending.questions;
    let answers = questionPicks.get(pickKey);
    if (!answers) {
      answers = questions.map(() => ({ selected: new Set(), other: false, custom: '' }));
      questionPicks.set(pickKey, answers);
    }
    const box = el('div', 'decisions');
    box.dataset.ompQuestionId = pending.id;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Pending OMP questions');
    const send = el('button', 'button button-primary', questions.length === 1 ? 'Send answer' : 'Send answers');
    send.type = 'button'; send.dataset.ompSubmit = ''; send.dataset.replyFocus = `question-${pending.id}-send`;
    const ready = () => questions.every((question, index) => question.multi === true ||
      answers[index].selected.size === 1 || answers[index].other && answers[index].custom.trim());
    const refreshSend = () => { send.disabled = busy || !ready(); };
    const submit = () => {
      if (!ready()) return;
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
      group.dataset.ompQuestionIndex = String(index);
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
        button.type = 'button'; button.disabled = busy; button.dataset.ompOptionIndex = String(optionIndex);
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
      other.type = 'button'; other.disabled = busy; other.dataset.ompOther = '';
      other.dataset.replyFocus = `question-${pending.id}-${index}-other`;
      other.setAttribute('aria-pressed', String(answer.other));
      const custom = el('textarea', 'reply-input');
      custom.rows = 2; custom.value = answer.custom; custom.hidden = !answer.other; custom.disabled = busy;
      custom.dataset.ompCustom = ''; custom.dataset.replyFocus = `question-${pending.id}-${index}-custom`;
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

  function renderCard(s) {
    const key = responseKey(s), responses = responsesOf(s), status = statusOf(s);
    const card = el('article', `session-card status-${status}`); card.dataset.key = key;
    const header = el('div','card-header');
    const title = el('div','session-title');
    title.append(el('h2','',nameOf(s)));
    if ((byId(s,'unreadCount','unread_count') || 0) > 0) { const dot=el('span','unread-dot'); dot.title='Unread responses'; title.append(dot); }
    header.append(title);
    const badges = el('div','badges');
    appendPill(badges, `status-pill ${status}`, status === 'needs_input' ? 'Needs you' : status === 'your_turn' ? 'Your turn' : status === 'working' ? 'Working' : status === 'ended' ? 'Ended' : 'Unknown');
    appendPill(badges,'host-pill',byId(s,'host') || 'local'); appendPill(badges,`harness-pill ${byId(s,'harness')}`,byId(s,'harness') === 'omp' ? 'OMP' : 'Claude');
    if (byId(s,'sessionKind','session_kind') === 'bg') appendPill(badges,'kind-pill','bg');
    header.append(badges); card.append(header);
    const meta = el('div','card-meta'), resolvedProject = byId(s,'project');
    const projectLabel = resolvedProject === undefined || resolvedProject === null ? (byId(s,'cwd') || '').split('/').filter(Boolean).pop() || 'Project unknown' : String(resolvedProject) || 'Project unknown';
    meta.append(el('span','project-name',projectLabel));
    meta.append(el('span','activity-time',relative(byId(s,'lastActivity','last_activity')))); card.append(meta);
    if (status === 'needs_input') {
      const box = el('div','needs-box');
      box.append(el('strong','',byId(s,'needsReason','needs_reason') === 'permission' ? 'Permission requested' : 'Waiting for your input'));
      const needText = byId(s,'needsText','needs_text'); if (needText) { const content = el('div','needs-text'); appendMarkdown(content,needText); box.append(content); }
      card.append(box);
    }
    const promptText = byId(s,'lastPrompt','last_prompt');
    if (promptText) {
      const prompt = el('details','prompt-details'); prompt.open = state.expanded.has(`${key}:prompt`);
      prompt.addEventListener('toggle', () => prompt.open ? state.expanded.add(`${key}:prompt`) : state.expanded.delete(`${key}:prompt`));
      prompt.append(el('summary','','Last prompt')); const p = el('div','prompt-text'); p.textContent = promptText; prompt.append(p); card.append(prompt);
    }
    if (responses.length) {
      const latest = responses[0], expanded = state.expanded.has(`${key}:latest`);
      const wrap = el('div',`latest-response${expanded ? ' expanded' : ''}`); wrap.append(responseBlock(latest,s));
      const toggle = el('button','text-button',expanded ? 'Collapse response' : 'Expand response'); toggle.type = 'button';
      toggle.addEventListener('click', () => { state.expanded.has(`${key}:latest`) ? state.expanded.delete(`${key}:latest`) : state.expanded.add(`${key}:latest`); renderSessions(); });
      wrap.append(toggle); card.append(wrap);
      if (responses.length > 1) {
        const earlierOpen = state.expanded.has(`${key}:earlier`), details = el('details','earlier-details'); details.open = earlierOpen;
        details.addEventListener('toggle', () => details.open ? state.expanded.add(`${key}:earlier`) : state.expanded.delete(`${key}:earlier`));
        details.append(el('summary','',`Show ${responses.length - 1} earlier`));
        responses.slice(1).forEach((r) => details.append(responseBlock(r,s,'earlier-response'))); card.append(details);
      }
    } else card.append(el('p','muted no-response','No responses yet.'));
    const actions = el('div','card-actions');
    const read = el('button','button button-secondary','Mark read'); read.type='button'; read.disabled = !(byId(s,'unreadCount','unread_count') || 0); read.addEventListener('click', () => markSeen(key)); actions.append(read);
    const copy = el('button','button button-secondary','Copy resume cmd'); copy.type='button'; copy.addEventListener('click', async () => {
      const id = byId(s,'sessionId','session_id') || ''; const command = `${byId(s,'harness') === 'omp' ? 'omp' : 'claude'} --resume ${JSON.stringify(String(id))}`;
      try { await navigator.clipboard.writeText(command); copy.textContent='Copied'; setTimeout(() => copy.textContent='Copy resume cmd',1200); } catch { copy.textContent='Clipboard unavailable'; setTimeout(() => copy.textContent='Copy resume cmd',1600); }
    }); actions.append(copy); card.append(actions);
    const replyControls = renderReplyControls(s, key, status, responses);
    if (replyControls) card.append(replyControls);
    cardSizes.observe(card, { box: 'border-box' });
    return card;
  }

  function sortSessions(list) {
    const rank = (s) => { const status=statusOf(s), unread=Number(byId(s,'unreadCount','unread_count')||0); return status==='needs_input'?0:status==='your_turn'&&unread?1:status==='working'?2:status==='your_turn'?3:status==='ended'?4:5; };
    return [...list].sort((a,b) => { const d=rank(a)-rank(b); if(d) return d; const at=Number(byId(a,'lastActivity','last_activity')||0),bt=Number(byId(b,'lastActivity','last_activity')||0); return rank(a)===0?at-bt:bt-at; });
  }
  function renderSessions() {
    const host=$('#host-filter').value, harness=$('#harness-filter').value, headless=$('#headless-filter').checked, ended=$('#ended-filter').checked;
    const filtered=sortSessions(state.sessions.filter(s => projectFilterMatches(s) && (headless || byId(s,'interactive') !== false && byId(s,'interactive') !== 0) && (ended || statusOf(s)!=='ended') && (!host || byId(s,'host')===host) && (!harness || byId(s,'harness')===harness)));
    const activeCard = document.activeElement?.closest?.('.session-card'), focus = focusSnapshot(activeCard), oldScroll=window.scrollY;
    cardSizes.disconnect();
    sessionsNode.replaceChildren(...filtered.map(renderCard));
    sizeSessionCards([...sessionsNode.children]);
    $('#sessions-empty').hidden=filtered.length>0; window.scrollTo(0,oldScroll);
    if (focus) restoreCardFocus(focus, sessionsNode.querySelector(`[data-key="${CSS.escape(focus.key)}"]`));
    updateCounts();
  }
  function visibleSessions() {
    const host=$('#host-filter').value, harness=$('#harness-filter').value, headless=$('#headless-filter').checked, ended=$('#ended-filter').checked;
    return sortSessions(state.sessions.filter(s => projectFilterMatches(s) && (headless || byId(s,'interactive') !== false && byId(s,'interactive') !== 0) && (ended || statusOf(s)!=='ended') && (!host || byId(s,'host')===host) && (!harness || byId(s,'harness')===harness)));
  }
  function patchSessionCard(dto, prior) {
    const key=responseKey(dto), old=sessionsNode.querySelector(`[data-key="${CSS.escape(key)}"]`);
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
    $('#needs-count').textContent=state.sessions.filter(s=>statusOf(s)==='needs_input').length;
    $('#unread-count').textContent=state.sessions.reduce((n,s)=>n+Number(byId(s,'unreadCount','unread_count')||0),0);
    $('#working-count').textContent=state.sessions.filter(s=>statusOf(s)==='working').length;
  }
  function refreshHosts() {
    const select=$('#host-filter'), selected=select.value, hosts=[...new Set(state.sessions.map(s=>byId(s,'host')).filter(Boolean))].sort();
    select.replaceChildren(new Option('All hosts',''),...hosts.map(h=>new Option(h,h))); select.value=hosts.includes(selected)?selected:'';
  }

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
  function projectFilterMatches(session) {
    const selected = $('#project-filter').value;
    return !selected || projectFilterIdentity(session) === selected;
  }
  function projectFilterLabel(session) {
    const project = byId(session, 'project');
    if (typeof project === 'string' && project) return project;
    return projectFolderOf(session).split(/[\\/]/).filter(Boolean).pop() || 'Project unknown';
  }
  function refreshProjectFilter() {
    const select = $('#project-filter'), selected = select.value, entries = new Map();
    const addSession = session => {
      const id = projectFilterIdentity(session);
      if (!entries.has(id)) entries.set(id, {
        id, name: projectFilterLabel(session), cwd: projectFolderOf(session), host: String(byId(session, 'host') ?? '')
      });
    };
    for (const session of state.sessions) addSession(session);
    for (const row of state.timeline) addSession(row);
    const counts = new Map();
    for (const entry of entries.values()) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    const options = [...entries.values()].map(entry => {
      let label = entry.name;
      if (counts.get(entry.name) > 1) label += ` — ${entry.cwd || entry.host || 'unknown folder'}`;
      return { ...entry, label };
    });
    const labelCounts = new Map();
    for (const entry of options) labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);
    options.sort((a, b) => a.label.localeCompare(b.label));
    select.replaceChildren(new Option('All repositories', ''), ...options.map(entry => {
      const label = labelCounts.get(entry.label) > 1 ? `${entry.label} (${entry.host || 'unknown host'})` : entry.label;
      return new Option(label, entry.id);
    }));
    if (selected && !entries.has(selected)) select.add(new Option('Saved repository filter (not currently available)', selected));
    select.value = selected;
  }
  function restoreProjectFilter() {
    try {
      const saved = localStorage.getItem('dash.filter.project');
      if (!saved || saved.length > 8192) return;
      const select = $('#project-filter');
      select.add(new Option('Saved repository filter (not currently available)', saved));
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

  async function loadSessions() {
    const params=new URLSearchParams({headless:$('#headless-filter').checked?'1':'0',ended:$('#ended-filter').checked?'1':'0'});
    const response=await fetch(`/api/sessions?${params}`); if(!response.ok) throw Error(`sessions ${response.status}`);
    const payload=await response.json(), rows=Array.isArray(payload)?payload:(payload.sessions||[]);
    for (const s of rows) {
      const key=responseKey(s), prior=state.priorStatus.get(key), current=statusOf(s);
      if (prior && prior!=='needs_input' && current==='needs_input' && notificationPreference('needs')) notify(nameOf(s),'Needs your input');
      const oldIds=new Set(responsesOf(state.sessions.find(x=>responseKey(x)===key)||{}).map(r=>String(byId(r,'id'))));
      if (state.priorStatus.has(key) && notificationPreference('response') && responsesOf(s).some(r=>!oldIds.has(String(byId(r,'id'))))) notify(nameOf(s),'New response');
      state.priorStatus.set(key,current);
    }
    state.sessions=rows; prunePicks(); refreshHosts(); refreshProjectFilter(); renderSessions();
    if (state.repliesEnabled) refreshVisibleReplyLists();
  }
  async function markSeen(key) { await postJson(`/api/sessions/${encodeURIComponent(key)}/seen`); await loadSessions(); }
  async function markAll() { await postJson('/api/seen-all'); await loadSessions(); }

  function renderTimeline(append=false) {
    const visible = state.timeline.filter(projectFilterMatches);
    if (!append) timelineNode.replaceChildren();
    const existing = new Set([...timelineNode.children].map(item => item.dataset.responseId));
    for (const row of visible) {
      const id = String(byId(row, 'id') ?? '');
      if (append && existing.has(id)) continue;
      timelineNode.append(timelineItem(row));
      existing.add(id);
    }
    $('#timeline-empty').textContent = state.timeline.length && !visible.length
      ? 'No responses in the loaded timeline match these filters.' : 'No responses yet.';
    $('#timeline-empty').hidden = visible.length > 0;
    $('#timeline-more').hidden = state.timelineDone || state.timeline.length === 0;
  }
  function timelineItem(row) {
    const item=el('article','timeline-item'), header=el('div','timeline-header');
    item.dataset.responseId = String(byId(row, 'id') ?? '');
    header.append(el('strong','',row.displayName||row.display_name||row.title||row.cwd?.split('/').filter(Boolean).pop()||'Session'));
    header.append(el('span','',`${row.host||''} · ${row.harness==='omp'?'OMP':'Claude'} · ${relative(row.ts)}`)); item.append(header);
    item.append(responseBlock(row,row)); return item;
  }
  function prependTimelineResponses(dto, previous) {
    if (!state.timeline.length || (!$('#headless-filter').checked && (byId(dto,'interactive') === false || byId(dto,'interactive') === 0)) ||
        ($('#host-filter').value && byId(dto,'host') !== $('#host-filter').value) ||
        ($('#harness-filter').value && byId(dto,'harness') !== $('#harness-filter').value)) return;
    const known=new Set(state.timeline.map(r=>String(byId(r,'id'))));
    const previousIds=new Set(responsesOf(previous||{}).map(r=>String(byId(r,'id'))));
    const newest=Number(byId(state.timeline[0],'ts'));
    const fresh=responsesOf(dto).filter(r=>byId(r,'id') != null && !known.has(String(byId(r,'id'))) &&
      !previousIds.has(String(byId(r,'id'))) && Number(byId(r,'ts'))>=newest);
    if (!fresh.length) return;
    const rows=fresh.map(r=>({...r, host:byId(dto,'host'), harness:byId(dto,'harness'), displayName:nameOf(dto), title:byId(dto,'title'), cwd:byId(dto,'cwd'), project:byId(dto,'project')})).sort((a,b)=>Number(byId(b,'ts'))-Number(byId(a,'ts')));
    state.timeline.unshift(...rows);
    if (state.view==='timeline') {
      const oldY=window.scrollY, visible = rows.filter(projectFilterMatches);
      if (visible.length) timelineNode.prepend(...visible.map(timelineItem));
      $('#timeline-empty').textContent = state.timeline.length && !timelineNode.childElementCount
        ? 'No responses in the loaded timeline match these filters.' : 'No responses yet.';
      $('#timeline-empty').hidden = timelineNode.childElementCount > 0;
      $('#timeline-more').hidden = state.timelineDone===true;
      window.scrollTo(0,oldY);
    }
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
  function connect() {
    state.source?.close(); const source=new EventSource('/api/stream'); state.source=source;
    source.onopen=()=>{ setConnection('Live',true); refreshReplyAvailability().catch(()=>{}).then(()=>loadSessions().catch(()=>{})); refreshTelegram().catch(()=>{}); if(state.view==='timeline') loadTimeline(false,true).catch(()=>{}); }; source.onerror=()=>setConnection('Reconnecting',false);
    source.addEventListener('session',event=>{ try {
      const dto=JSON.parse(event.data), key=responseKey(dto), i=state.sessions.findIndex(s=>responseKey(s)===key), previous=i<0?null:state.sessions[i];
      if(previous && statusOf(previous)!=='needs_input' && statusOf(dto)==='needs_input' && notificationPreference('needs')) notify(nameOf(dto),'Needs your input');
      const oldIds=new Set(responsesOf(previous||{}).map(r=>String(byId(r,'id'))));
      if(previous && notificationPreference('response') && responsesOf(dto).some(r=>!oldIds.has(String(byId(r,'id'))))) notify(nameOf(dto),'New response');
      state.priorStatus.set(key,statusOf(dto));
      if(i<0) state.sessions.push(dto); else state.sessions[i]=dto;
      prunePicks();
      refreshHosts(); refreshProjectFilter(); patchSessionCard(dto,previous); prependTimelineResponses(dto,previous);
    } catch {} });
    source.addEventListener('reply',event=>{ try {
      const update=JSON.parse(event.data);
      if (typeof update?.key === 'string' && state.repliesEnabled) refreshReplyList(update.key);
    } catch {} });
  }
  function notificationPreference(which) { try { return localStorage.getItem(`dash.notify.${which}`)==='1' && Notification.permission==='granted'; } catch { return false; } }
  function notify(title,body) { try { if('Notification' in window && Notification.permission==='granted') new Notification(title,{body}); } catch {} }
  function loadNotificationPrefs() { try { $('#notify-needs').checked=localStorage.getItem('dash.notify.needs')==='1'; $('#notify-response').checked=localStorage.getItem('dash.notify.response')==='1'; } catch {} }

  function setFeedView(view) {
    const isTimeline = view === 'timeline';
    state.view = isTimeline ? 'timeline' : 'sessions';
    [['sessions-tab', !isTimeline], ['timeline-tab', isTimeline]].forEach(([id, selected]) => {
      const tab = $('#'+id);
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    $('#sessions-view').hidden = isTimeline;
    $('#timeline-view').hidden = !isTimeline;
    $('#ended-filter-label').hidden = isTimeline;
    refreshVisibleReplyLists();
    if (isTimeline) loadTimeline(false).catch(()=>{});
  }
  $('#sessions-tab').addEventListener('click',()=>setFeedView('sessions'));
  $('#timeline-tab').addEventListener('click',()=>setFeedView('timeline'));
  $('#feed-tabs').addEventListener('keydown',event=>{
    const tabs = [$('#sessions-tab'), $('#timeline-tab')], current = tabs.indexOf(event.target?.closest?.('[role="tab"]'));
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
  ['host-filter','harness-filter'].forEach(id=>$('#'+id).addEventListener('change',()=>{renderSessions();refreshVisibleReplyLists();if(state.view==='timeline')loadTimeline(false).catch(()=>{});}));
  $('#project-filter').addEventListener('change',()=>{persistProjectFilter();renderSessions();refreshVisibleReplyLists();if(state.view==='timeline')renderTimeline();});
  $('#headless-filter').addEventListener('change',()=>{loadSessions().catch(()=>{});if(state.view==='timeline')loadTimeline(false).catch(()=>{});});
  $('#ended-filter').addEventListener('change',()=>loadSessions().catch(()=>{}));
  $('#mark-all').addEventListener('click',markAll); $('#timeline-more').addEventListener('click',()=>loadTimeline(true).catch(()=>{}));
  window.addEventListener('scroll',()=>{if(state.view==='timeline'&&!state.timelineDone&&!state.timelineLoading&&window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-600) loadTimeline(true).catch(()=>{});},{passive:true});
  $('#notification-settings').addEventListener('click',()=>$('#notifications-dialog').showModal());
  $('#notification-enable').addEventListener('click',()=>$('#notifications-dialog').showModal());
  $('#notify-needs').addEventListener('change',e=>{try{localStorage.setItem('dash.notify.needs',e.target.checked?'1':'0')}catch{}});
  $('#notify-response').addEventListener('change',e=>{try{localStorage.setItem('dash.notify.response',e.target.checked?'1':'0')}catch{}});
  $('#enable-notifications').addEventListener('click',async()=>{const status=$('#notification-status');try{if(!('Notification'in window)){status.textContent='Notifications are not supported in this browser.';return}const permission=await Notification.requestPermission();status.textContent=permission==='granted'?'Notifications enabled.':'Permission was not granted.';}catch{status.textContent='Could not request notification permission.'}});
  $('#project-rule-add').addEventListener('click',()=>{if(projectRulesState.rows.length>=32)return;projectRulesState.rows.push({pattern:'',project:''});projectRuleRowsChanged();renderProjectRuleRows();});
  $('#project-rule-save').addEventListener('click',saveProjectRules);
  $('#project-test-path').addEventListener('input',scheduleProjectPreview);
  restoreProjectFilter();
  loadNotificationPrefs(); refreshReplyAvailability().catch(()=>{}).then(()=>loadSessions().catch(()=>setConnection('Offline',false))); refreshTelegram().catch(()=>{}); loadProjectRules().catch(()=>{}); window.setInterval(refreshTelegram, 30000); connect();
})();
