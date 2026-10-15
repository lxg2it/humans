/*
 * The console.
 *
 * Plain DOM, no framework and no build step, because the interesting part of
 * this service is the wait and a build pipeline would only obscure it. Every
 * value that comes from a caller is written with textContent: a prompt, a tool
 * description and a tool result are all text written by a stranger, and none of
 * them should be able to become markup in somebody else's browser.
 */
(() => {
  'use strict';

  const KEY_STORE = 'humans.responder.key';
  const POLL_MS = 4000;
  const HEARTBEAT_MS = 25000;
  const PARTIAL_DEBOUNCE_MS = 300;

  let key = localStorage.getItem(KEY_STORE) || '';
  let me = null;
  let queue = [];
  let currentId = null;
  let detail = null;
  let calls = [];
  let callSeq = 0;
  let submitting = false;
  let fieldIndex = new Map();

  let pollTimer = null;
  let heartbeatTimer = null;
  let partialTimer = null;
  // Reset whenever a request is loaded or claimed: the warning describes this
  // caller, not the last one.
  let goneShown = false;
  let clockTimer = null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  // ---- transport -----------------------------------------------------------

  /** Throws { message, details } so callers can render the server's own words. */
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-human-key': key, ...(options.headers || {}) },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      if (response.status === 401) signOut('your key was not accepted');
      const error = new Error(body?.error?.message || `${response.status} ${response.statusText}`);
      error.details = body?.error?.details || [];
      error.status = response.status;
      throw error;
    }
    return body;
  }

  // ---- session -------------------------------------------------------------

  function signOut(reason) {
    localStorage.removeItem(KEY_STORE);
    key = '';
    me = null;
    stopTimers();
    $('main').hidden = true;
    $('who').hidden = true;
    $('gate').hidden = false;
    $('gate-error').hidden = !reason;
    if (reason) $('gate-error').textContent = reason;
    $('conn').className = 'dot';
  }

  async function signIn(candidate) {
    const previous = key;
    key = candidate;
    try {
      me = await api('/api/me');
      localStorage.setItem(KEY_STORE, key);
      $('gate').hidden = true;
      $('gate-error').hidden = true;
      $('main').hidden = false;
      $('who').hidden = false;
      $('responder-name').textContent = me.name;
      $('instance').textContent = document.title = location.host;
      $('conn').className = 'dot live';
      renderEarnings(me.earnings);
      renderPoolNote();
      await refreshQueue();
      startPolling();
    } catch (error) {
      key = previous;
      $('gate-error').hidden = false;
      $('gate-error').textContent = error.message;
      $('gate-key').value = '';
    }
  }

  function renderEarnings(earnings) {
    if (!earnings) return;
    const owed = earnings.owedSats;
    const rated = earnings.averageRating === null ? '' : ` · rated ${earnings.averageRating.toFixed(1)}/5`;
    $('earnings').textContent =
      `${earnings.replies} answered · ${owed.toLocaleString()} sats owed${rated}`;
    $('earnings').title = `earned ${earnings.earnedSats} · paid ${earnings.paidSats} · owed ${owed}`;
  }

  function renderPoolNote() {
    if (!me) return;
    const note = $('pool-note');
    note.textContent = '';
    if (me.pool_sats <= 0) {
      note.textContent =
        `The guarantee is ${me.guarantee_sats} sats per reply, and the pool is empty: the promise is recorded but unfunded.`;
      note.className = 'warn';
    } else if (me.pool_sats < me.earnings.owedSats) {
      note.textContent = `Pool ${me.pool_sats} sats, already owed ${me.earnings.owedSats}. The guarantee is not fully covered.`;
      note.className = 'warn';
    } else {
      note.textContent = `Guaranteed ${me.guarantee_sats} sats per answered reply, from a pool of ${me.pool_sats}.`;
      note.className = '';
    }
  }

  // ---- queue ---------------------------------------------------------------

  function startPolling() {
    stopTimers();
    pollTimer = setInterval(refreshQueue, POLL_MS);
    clockTimer = setInterval(tickClock, 1000);
  }

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    if (clockTimer) clearInterval(clockTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (partialTimer) clearTimeout(partialTimer);
    pollTimer = clockTimer = heartbeatTimer = partialTimer = null;
  }

  async function refreshQueue() {
    try {
      const data = await api('/api/queue');
      queue = data.requests || [];
      $('conn').className = 'dot live';
      renderQueue();
      if (currentId && !queue.some((row) => row.id === currentId) && !detail) {
        // It was answered or expired while we were looking at it.
        selectRequest(currentId);
      }
    } catch (error) {
      $('conn').className = 'dot';
      if (error.status !== 401) $('submit-state').textContent = error.message;
    }
  }

  function renderQueue() {
    const list = $('queue');
    list.textContent = '';
    $('queue-count').textContent = queue.length === 0 ? '' : `${queue.length}`;
    $('queue-empty').hidden = queue.length > 0;

    for (const row of queue) {
      const item = el('li');
      if (row.id === currentId) item.classList.add('sel');
      if (row.status === 'claimed' && !row.mine) item.classList.add('taken');

      const top = el('div', 'q-top');
      const left = el('span', 'age');
      const remaining = Math.max(0, Math.round((row.deadline_at - Date.now()) / 1000));
      left.textContent = `${formatDuration(remaining)} left`;
      if (remaining < 90) item.classList.add('urgent');
      const right = el('span');
      right.textContent = row.stream ? 'stream' : 'json';
      top.append(left, right);

      const sum = el('div', 'q-sum', row.summary || '(no summary)');
      const snip = el('div', 'q-snip');
      snip.textContent =
        row.status === 'claimed' ? (row.mine ? 'you have this one' : `taken by ${row.claimed_by}`) : 'waiting';

      item.append(top, sum, snip);
      item.addEventListener('click', () => selectRequest(row.id));
      list.append(item);
    }
  }

  function formatDuration(seconds) {
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  function tickClock() {
    if (!detail) return;
    const box = $('req-clock');
    const remaining = Math.max(0, Math.round((detail.deadline_at - Date.now()) / 1000));
    box.textContent = formatDuration(remaining);
    box.className = 'clock' + (remaining < 90 ? ' bad' : remaining < 240 ? ' warn' : '');
  }

  // ---- reading a request ---------------------------------------------------

  async function selectRequest(id) {
    currentId = id;
    try {
      detail = await api(`/api/requests/${id}`);
    } catch (error) {
      detail = null;
      $('request').hidden = true;
      $('empty').hidden = false;
      $('empty').lastElementChild.textContent = error.message;
      return;
    }
    renderDetail();
    $('empty').hidden = true;
    $('request').hidden = false;
    renderQueue();
  }

  function renderDetail() {
    $('req-summary').textContent = detail.summary || detail.id;
    const meta = $('req-meta');
    meta.textContent = '';
    meta.append(
      el('span', null, `id ${detail.id}`),
      el('span', 'sep', ' · '),
      el('span', null, detail.stream ? 'streaming' : 'single response'),
      el('span', 'sep', ' · '),
      el('span', null, `max_tokens ${detail.max_tokens}`),
      el('span', 'sep', ' · '),
      el('span', null, `~${detail.input_tokens} input tokens (estimate)`),
      el('span', 'sep', ' · '),
      el('span', null, `from ${detail.caller || 'an unauthenticated caller'}`),
    );
    if (detail.model) {
      meta.append(
        el('span', 'sep', ' · '),
        el('span', null, `asked for ${detail.model}`),
      );
    }

    tickClock();

    // The claim bar.
    const mine = detail.mine;
    const free = detail.status === 'queued';
    $('claim-bar').hidden = false;
    $('claim-bar').className = 'bar' + (mine ? ' mine' : '');
    $('claim').hidden = mine;
    $('claim').disabled = !free;
    $('abandon').hidden = !mine;
    goneShown = false;
    if (mine) {
      $('claim-msg').textContent = 'This one is yours';
      $('claim-sub').textContent = 'Send the answer, or put it back for someone else.';
    } else if (free) {
      $('claim-msg').textContent = 'Waiting for someone to answer it';
      $('claim-sub').textContent = 'Taking it removes it from everyone else’s queue.';
    } else {
      $('claim-msg').textContent = `${detail.claimed_by || 'someone'} has this one`;
      $('claim-sub').textContent = 'It is not yours to answer.';
    }

    // Transcript.
    const systemWrap = $('system-wrap');
    if (detail.system) {
      $('system').textContent = typeof detail.system === 'string' ? detail.system : JSON.stringify(detail.system, null, 2);
      systemWrap.hidden = false;
    } else {
      systemWrap.hidden = true;
    }
    renderMessages($('messages'), detail.messages || []);
    renderTools();
    renderAnswerSection();
  }

  function renderMessages(container, messages) {
    container.textContent = '';
    messages.forEach((message, index) => {
      const wrapper = el('div', `msg ${message.role}`);
      wrapper.append(el('div', 'msg-role', `${message.role} · ${index}`));
      const content = message.content;
      if (typeof content === 'string') {
        wrapper.append(el('div', 'transcript', content));
      } else if (Array.isArray(content)) {
        for (const block of content) wrapper.append(renderBlock(block));
      } else {
        wrapper.append(el('div', 'transcript', JSON.stringify(content)));
      }
      container.append(wrapper);
    });
  }

  function renderBlock(block) {
    if (!block || typeof block !== 'object') return el('div', 'transcript', String(block));
    switch (block.type) {
      case 'text':
        return el('div', 'transcript', block.text);
      case 'thinking':
        return el('div', 'transcript block-thinking', `[reasoning from the previous turn] ${block.thinking}`);
      case 'tool_use': {
        const box = el('div', 'transcript block-tools');
        box.append(el('div', null, `${block.name}(${JSON.stringify(block.input ?? {})})`));
        box.append(el('div', 'call-id', `id ${block.id} — the result below refers to this id`));
        return box;
      }
      case 'tool_result': {
        const box = el('div', 'transcript block-tools');
        const label = block.is_error ? 'tool error' : 'tool result';
        box.append(el('div', 'call-id', `${label} for ${block.tool_use_id}`));
        const content = block.content;
        if (typeof content === 'string') box.append(el('div', null, content));
        else if (Array.isArray(content)) {
          for (const inner of content) {
            if (inner?.type === 'text') box.append(el('div', null, inner.text));
            else if (inner?.type === 'image') box.append(el('div', 'muted', `[image ${inner.source?.media_type || ''}]`));
            else box.append(el('div', 'muted', `[${inner?.type}]`));
          }
        } else if (content !== undefined) {
          box.append(el('div', null, JSON.stringify(content)));
        }
        return box;
      }
      case 'image':
        return el('div', 'transcript muted', `[image ${block.source?.media_type || ''}, not shown here]`);
      default:
        return el('div', 'transcript', JSON.stringify(block));
    }
  }

  function renderTools() {
    const container = $('tools');
    container.textContent = '';
    const tools = detail.tools || [];
    $('tools-count').textContent = tools.length === 0 ? '(none)' : `(${tools.length})`;
    $('tools-details').open = tools.length > 0 && (detail.tool_choice.mode === 'tool' || detail.tool_choice.mode === 'any');

    for (const tool of tools) {
      const box = el('div', 'tool');
      const head = el('div', 'tool-name', tool.name);
      box.append(head);
      if (tool.description) box.append(el('div', 'tool-desc', tool.description));

      const details = el('details');
      details.append(el('summary', null, 'input schema'));
      details.append(el('pre', 'transcript', JSON.stringify(tool.input_schema, null, 2)));
      box.append(details);

      if (tool.plan && tool.plan.mode === 'raw') {
        const plan = el('details');
        plan.append(el('summary', null, 'why this one needs JSON'));
        plan.append(el('div', 'muted small', tool.plan.reason || 'this schema cannot be shown as a form'));
        box.append(plan);
      }
      container.append(box);
    }
  }

  // ---- answering -----------------------------------------------------------

  function renderAnswerSection() {
    const canAnswer = detail.mine;
    $('answer').hidden = !canAnswer;
    if (!canAnswer) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      return;
    }

    if (!me.claim_lease_ms) me.claim_lease_ms = 180000;
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
      heartbeat();
    }

    detail.answer = detail.answer || { reasoning: '', response: '', calls: [], stopReason: 'end_turn', stopSequence: '' };
    $('reasoning').value = detail.answer.reasoning;
    $('response').value = detail.answer.response;
    calls = detail.answer.calls;
    $('answer-errors').hidden = true;

    // tool_choice decides what the responder is allowed to do.
    const choice = detail.tool_choice.mode;
    const note = $('tool-choice-note');
    const addRow = $('add-call-row');
    const addSelect = $('add-call');
    const declared = detail.tools || [];

    addSelect.textContent = '';
    addSelect.append(new Option('Add a tool call…', ''));
    for (const tool of declared) addSelect.append(new Option(tool.name, tool.name));

    if (choice === 'none') {
      $('tools-answer').hidden = true;
    } else {
      $('tools-answer').hidden = false;
      const required = detail.tool_choice.name;
      if (choice === 'tool') {
        note.textContent = `the caller requires ${required}, and only that`;
        addRow.hidden = true;
        if (!calls.some((call) => call.name === required)) calls.push(newCall(required));
      } else if (choice === 'any') {
        note.textContent = parallelAllowed()
          ? 'the caller requires at least one tool call'
          : 'the caller requires exactly one tool call';
        addRow.hidden = false;
      } else {
        note.textContent = 'optional — the caller will run whatever you choose';
        addRow.hidden = false;
      }
    }

    renderCalls();
    renderStopReasons();
    updateMeter();
  }

  /** tool_choice.disable_parallel_tool_use === true means one call, not several. */
  function parallelAllowed() {
    return detail.tool_choice.mode !== 'tool' && detail.tool_choice.parallel !== false;
  }

  function newCall(name) {
    const tool = (detail.tools || []).find((candidate) => candidate.name === name);
    const call = {
      uid: `call-${++callSeq}`,
      name,
      id: '',
      mode: tool && tool.plan.mode === 'raw' ? 'raw' : 'fields',
      raw: '{}',
      values: {},
      plan: tool ? tool.plan : { mode: 'raw', fields: [], reason: 'this request declares no such tool' },
    };
    if (call.mode === 'fields') {
      for (const field of call.plan.fields) call.values[field.name] = defaultValue(field);
    }
    return call;
  }

  function defaultValue(field) {
    if (field.kind === 'boolean') return field.default === undefined && !field.required ? '__unset__' : field.default === true ? 'true' : field.default === false ? 'false' : '';
    if (field.kind === 'string-list') return Array.isArray(field.default) ? field.default.join('\n') : '';
    if (field.default !== undefined) return Array.isArray(field.default) ? field.default.join('\n') : String(field.default);
    return '';
  }

  function renderCalls() {
    const container = $('calls');
    container.textContent = '';
    fieldIndex = new Map();

    calls.forEach((call, index) => {
      const box = el('div', 'call');
      const head = el('div', 'call-head');
      head.append(el('div', 'tool-name', call.name));
      const right = el('div', 'row');
      if (call.id) right.append(el('span', 'call-id', call.id));
      if (!(detail.tool_choice.mode === 'tool')) {
        const remove = el('button', 'link', 'remove');
        remove.addEventListener('click', () => {
          calls.splice(index, 1);
          renderCalls();
          queuePartial();
          updateMeter();
        });
        right.append(remove);
      }
      head.append(right);
      box.append(head);

      const idField = el('div', 'field');
      idField.append(el('div', 'field-label muted', 'tool_use id — leave empty to have one generated'));
      const idInput = el('input');
      idInput.type = 'text';
      idInput.placeholder = 'toolu_…';
      idInput.value = call.id;
      idInput.addEventListener('input', () => {
        call.id = idInput.value.trim();
      });
      idField.append(idInput);
      box.append(idField);
      fieldIndex.set(`tool.${index}.id`, idInput);

      if (call.mode === 'raw') {
        const field = el('div', 'field');
        field.append(el('div', 'field-label', 'input (JSON object)'));
        const textarea = el('textarea');
        textarea.rows = 6;
        textarea.spellcheck = false;
        textarea.value = call.raw;
        textarea.addEventListener('input', () => {
          call.raw = textarea.value;
          updateMeter();
        });
        field.append(textarea);
        if (call.plan.reason) field.append(el('div', 'field-help', call.plan.reason));
        fieldIndex.set(`tool.${index}.input`, field);
        box.append(field);
      } else if (call.plan.fields.length === 0) {
        box.append(el('div', 'field-help muted', 'this tool takes no arguments'));
      } else {
        for (const spec of call.plan.fields) {
          box.append(renderField(call, index, spec));
        }
      }

      container.append(box);
    });
  }

  function renderField(call, index, spec) {
    const field = el('div', 'field');
    const label = el('div', 'field-label');
    label.append(el('span', spec.required ? 'req' : null, spec.required ? `${spec.label} *` : spec.label));
    field.append(label);

    const path = `tool.${index}.input.${spec.name}`;
    let control;

    if (spec.kind === 'enum') {
      control = el('select');
      control.append(new Option(spec.required ? 'choose…' : 'leave out', ''));
      for (const option of spec.options) control.append(new Option(option.label, option.value));
      control.value = call.values[spec.name] ?? '';
      control.addEventListener('change', () => {
        call.values[spec.name] = control.value;
        updateMeter();
      });
    } else if (spec.kind === 'boolean') {
      control = el('select');
      if (!spec.required) control.append(new Option('leave out', '__unset__'));
      control.append(new Option('yes', 'true'), new Option('no', 'false'));
      control.value = call.values[spec.name] ?? (spec.required ? 'true' : '__unset__');
      call.values[spec.name] = control.value;
      control.addEventListener('change', () => {
        call.values[spec.name] = control.value;
        updateMeter();
      });
    } else if (spec.kind === 'number') {
      control = el('input');
      control.type = 'number';
      if (spec.integer) control.step = '1';
      if (spec.minimum !== undefined) control.min = String(spec.minimum);
      if (spec.maximum !== undefined) control.max = String(spec.maximum);
      control.value = call.values[spec.name] ?? '';
      control.addEventListener('input', () => {
        call.values[spec.name] = control.value;
        updateMeter();
      });
    } else if (spec.kind === 'string-list') {
      control = el('textarea');
      control.rows = 3;
      control.placeholder = spec.itemLabel || 'one value per line';
      control.value = call.values[spec.name] ?? '';
      control.addEventListener('input', () => {
        call.values[spec.name] = control.value;
        updateMeter();
      });
    } else {
      control = el('textarea');
      control.rows = spec.multiline ? 4 : 1;
      control.spellcheck = false;
      if (spec.maxLength !== undefined) control.maxLength = spec.maxLength;
      if (spec.example) control.placeholder = spec.example;
      control.value = call.values[spec.name] ?? '';
      control.addEventListener('input', () => {
        call.values[spec.name] = control.value;
        updateMeter();
      });
    }

    if (spec.description) field.append(el('div', 'field-help', spec.description));
    fieldIndex.set(path, field);
    field.append(control);
    return field;
  }

  /** The submitted input for one call, or { error } if it cannot be built. */
  function callInput(call, index) {
    if (call.mode === 'raw') {
      const trimmed = (call.raw || '').trim();
      if (trimmed === '') return { input: {}, error: 'empty JSON object expected' };
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { error: 'the input must be a JSON object' };
        }
        return { input: parsed };
      } catch (error) {
        return { error: `not valid JSON: ${error.message}` };
      }
    }

    const input = {};
    for (const spec of call.plan.fields) {
      const raw = call.values[spec.name];
      const empty = raw === undefined || raw === '' || raw === '__unset__';
      if (empty) {
        if (!spec.required) continue;
        if (spec.kind === 'boolean') {
          input[spec.name] = spec.default === true;
          continue;
        }
        return { error: `"${spec.label}" is required`, path: `tool.${index}.input.${spec.name}` };
      }
      if (spec.kind === 'number') {
        const value = Number(raw);
        if (!Number.isFinite(value)) return { error: `"${spec.label}" must be a number`, path: `tool.${index}.input.${spec.name}` };
        if (spec.integer && !Number.isInteger(value)) {
          return { error: `"${spec.label}" must be a whole number`, path: `tool.${index}.input.${spec.name}` };
        }
        if (spec.minimum !== undefined && value < spec.minimum) {
          return { error: `"${spec.label}" must be at least ${spec.minimum}`, path: `tool.${index}.input.${spec.name}` };
        }
        if (spec.maximum !== undefined && value > spec.maximum) {
          return { error: `"${spec.label}" must be at most ${spec.maximum}`, path: `tool.${index}.input.${spec.name}` };
        }
        input[spec.name] = value;
        continue;
      }
      if (spec.kind === 'boolean') {
        input[spec.name] = raw === 'true';
        continue;
      }
      if (spec.kind === 'string-list') {
        input[spec.name] = String(raw)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
        continue;
      }
      input[spec.name] = String(raw);
    }
    return { input };
  }

  function currentPayload() {
    const errors = [];
    const details = [];
    const toolCalls = [];

    calls.forEach((call, index) => {
      const built = callInput(call, index);
      if (built.error) {
        errors.push(`${call.name}: ${built.error}`);
        details.push({ field: built.path || `tool.${index}.input`, message: built.error });
        return;
      }
      const entry = { name: call.name, input: built.input };
      if (call.id) entry.id = call.id;
      toolCalls.push(entry);
    });

    if (detail.tool_choice.mode === 'tool' && toolCalls.length === 0) {
      errors.push(`the caller requires a call to ${detail.tool_choice.name}`);
    }
    if (detail.tool_choice.mode === 'any' && toolCalls.length === 0) {
      errors.push('the caller requires at least one tool call');
    }
    if (detail.tool_choice.mode === 'none') toolCalls.length = 0;

    const body = {
      thinking: $('reasoning').value,
      text: $('response').value,
      tools: toolCalls,
    };
    if (toolCalls.length === 0) {
      body.stop_reason = $('stop-reason').value;
      if (body.stop_reason === 'stop_sequence') body.stop_sequence = $('stop-sequence').value;
    }
    return { body, errors, details, toolCalls };
  }

  function renderStopReasons() {
    const select = $('stop-reason');
    select.textContent = '';
    for (const reason of me.stop_reasons || ['end_turn']) {
      if (reason === 'tool_use') continue;
      select.append(new Option(reason, reason));
    }
    select.value = detail.answer.stopReason || 'end_turn';
    select.addEventListener('change', () => {
      detail.answer.stopReason = select.value;
      $('stop-sequence').hidden = select.value !== 'stop_sequence';
    });
    $('stop-sequence').hidden = select.value !== 'stop_sequence';
    $('stop-sequence').value = detail.answer.stopSequence || '';
    updateStopVisibility();
  }

  function updateStopVisibility() {
    const hasCalls = calls.length > 0 && detail.tool_choice.mode !== 'none';
    $('stop-reason').parentElement.hidden = hasCalls;
    if (hasCalls && $('stop-reason').value === 'stop_sequence') $('stop-sequence').hidden = true;
  }

  function updateMeter() {
    if (!detail || !me) return;
    const { body } = currentPayload();
    const chars =
      (body.thinking || '').length +
      (body.text || '').length +
      JSON.stringify((body.tools || []).map((call) => call.input)).length;
    const estimated = chars === 0 ? 0 : Math.max(1, Math.ceil(chars / (me.chars_per_token || 4)));
    const max = detail.max_tokens || 0;
    const ratio = max > 0 ? estimated / max : 0;
    const fill = $('meter-fill');
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    fill.className = ratio > 1 ? 'over' : '';
    $('meter-note').textContent =
      `~${estimated} of ${max} output tokens (estimated from ${chars} characters, ~${me.chars_per_token} per token)`;
    $('meter-note').className = ratio > 1 ? 'error small' : 'muted small';
    updateStopVisibility();
  }

  // ---- actions -------------------------------------------------------------

  async function heartbeat() {
    if (!currentId || !detail || !detail.mine) return;
    try {
      await api(`/api/requests/${currentId}/heartbeat`, { method: 'POST', body: '{}' });
    } catch (error) {
      if (error.status === 409) {
        detail.mine = false;
        $('answer').hidden = true;
        $('claim-msg').textContent = 'Your hold on this one lapsed';
        $('claim-sub').textContent = 'It went back to the queue. Reload it to try again.';
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        refreshQueue();
      }
    }
  }

  function queuePartial() {
    if (!detail || !detail.mine || !detail.stream) return;
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = setTimeout(() => {
      api(`/api/requests/${currentId}/partial`, {
        method: 'POST',
        body: JSON.stringify({ thinking: $('reasoning').value, text: $('response').value }),
      })
        .then((result) => {
          // A partial can reach nobody: the caller may have closed the stream.
          // Typing into a closed socket should not look like being read.
          if (result && result.delivered === false) callerGone();
        })
        .catch(() => {});
    }, PARTIAL_DEBOUNCE_MS);
  }

  function callerGone() {
    if (!detail || !detail.mine || goneShown) return;
    goneShown = true;
    $('claim-msg').textContent = 'The caller has disconnected';
    $('claim-sub').textContent = 'Nothing you type now reaches them. Submit anyway: the answer is still recorded and still paid.';
  }

  function showErrors(message, details) {
    const box = $('answer-errors');
    box.textContent = '';
    box.hidden = false;
    box.append(el('div', null, message));
    for (const detailEntry of details || []) {
      const line = el('div', 'small');
      line.textContent = `${detailEntry.field}: ${detailEntry.message}`;
      box.append(line);
    }
    for (const node of fieldIndex.values()) node.classList.remove('invalid');
    let first = null;
    for (const entry of details || []) {
      const node = fieldIndex.get(entry.field) || fieldIndex.get(String(entry.field).replace(/\.input\./, '.input.'));
      if (node) {
        node.classList.add('invalid');
        first = first || node;
      }
    }
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const focusable = first.querySelector('input, textarea, select');
      if (focusable) focusable.focus();
    }
  }

  async function submit() {
    if (submitting) return;
    const { body, errors, details } = currentPayload();
    if (errors.length > 0) {
      showErrors('Fix these before sending:', details);
      return;
    }
    if (!body.thinking && !body.text && (body.tools || []).length === 0) {
      showErrors('An answer has to contain something.', []);
      return;
    }
    submitting = true;
    $('submit').disabled = true;
    $('submit-state').textContent = 'sending…';
    try {
      const result = await api(`/api/requests/${currentId}/submit`, { method: 'POST', body: JSON.stringify(body) });
      $('submit-state').textContent = result.delivered
        ? 'sent to the caller'
        : 'recorded — the caller had already gone';
      renderEarnings(result.earnings);
      renderPoolNote();
      if (result.unchecked_schemas && result.unchecked_schemas.length > 0) {
        $('submit-state').textContent += ` — ${result.unchecked_schemas.join(', ')} could not be checked against its schema`;
      }
      calls = [];
      detail = null;
      currentId = null;
      $('request').hidden = true;
      $('empty').hidden = false;
      await refreshQueue();
    } catch (error) {
      showErrors(error.message, error.details);
      $('submit-state').textContent = '';
    } finally {
      submitting = false;
      $('submit').disabled = false;
    }
  }

  // ---- wiring --------------------------------------------------------------

  $('gate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('gate-key').value.trim();
    if (value) signIn(value);
  });

  $('signout').addEventListener('click', () => signOut());
  $('claim').addEventListener('click', async () => {
    try {
      detail = await api(`/api/requests/${currentId}/claim`, { method: 'POST', body: '{}' });
      renderDetail();
    } catch (error) {
      showErrors(error.message, error.details);
      refreshQueue();
    }
  });
  $('abandon').addEventListener('click', async () => {
    try {
      await api(`/api/requests/${currentId}/abandon`, { method: 'POST', body: '{}' });
      detail = null;
      currentId = null;
      $('request').hidden = true;
      $('empty').hidden = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      await refreshQueue();
    } catch (error) {
      showErrors(error.message, error.details);
    }
  });
  $('add-call').addEventListener('change', (event) => {
    const name = event.target.value;
    event.target.value = '';
    if (!name) return;
    if (!parallelAllowed() && calls.length >= 1) {
      showErrors('This caller set disable_parallel_tool_use, so an answer carries one tool call at most.', []);
      return;
    }
    if (detail.tool_choice.mode === 'tool') calls.length = 0;
    calls.push(newCall(name));
    renderCalls();
    queuePartial();
    updateMeter();
  });
  $('reasoning').addEventListener('input', () => {
    queuePartial();
    updateMeter();
  });
  $('response').addEventListener('input', () => {
    queuePartial();
    updateMeter();
  });
  $('submit').addEventListener('click', submit);

  // ---- boot ----------------------------------------------------------------

  if (key) signIn(key);
  else signOut('');
})();
