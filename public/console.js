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

  // Reading a request is its own file, and it is loaded before this one. It is
  // pure data in and pure data out, so the decisions about what a block is and
  // what a tool permits are tested without a browser. Failing loudly here is
  // better than rendering a request as raw JSON again: a console that shows the
  // caller's shape instead of its meaning looks like it is working.
  const Reading = window.HumansReading;
  if (!Reading) throw new Error('console-reading.js did not load: the console cannot read a request without it');

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
  // Which channel of the answer the composer is writing into. View state, not
  // answer state: the draft itself lives on detail.answer, so switching back and
  // forth cannot lose or duplicate what was typed.
  let channel = 'response';
  let declared = false;

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
      $('payout-line').hidden = false;
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

    // Where it would go, said next to how much there is, so a person notices a
    // missing or stale address at the moment they are thinking about the money
    // rather than when a settlement fails to arrive.
    const payout = $('payout');
    if (me.payout_address) {
      payout.textContent = `paid to ${me.payout_address}`;
      payout.className = 'muted small';
    } else {
      payout.textContent = 'no payout address set — anything owed is held, not lost';
      payout.className = 'muted small warn';
    }
  }

  /**
   * Setting the address you would be paid at.
   *
   * Deliberately a small form rather than a browser prompt: an address is 42-62
   * characters of a script with no redundancy in it, and a prompt gives you one
   * line to paste into with no way to see what you have. The server validates;
   * this only shows what it says.
   */
  function initPayoutEditor() {
    const form = $('payout-form');
    const input = $('payout-input');
    const edit = $('payout-edit');

    edit.addEventListener('click', () => {
      input.value = me.payout_address || '';
      form.hidden = false;
      edit.hidden = true;
      input.focus();
    });

    $('payout-cancel').addEventListener('click', () => {
      form.hidden = true;
      edit.hidden = false;
      renderEarnings(me.earnings);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        // api() passes the body through to fetch untouched, so it is stringified
        // here. The first version of this line did not, and the only way it was
        // found was by using the form against the running service: every unit
        // test passed, because none of them exercise the browser's own fetch.
        const result = await api('/api/me/payout-address', {
          method: 'POST',
          body: JSON.stringify({ address: input.value.trim() }),
        });
        me.payout_address = result.payout_address;
        form.hidden = true;
        edit.hidden = false;
        renderEarnings(me.earnings);
      } catch (error) {
        $('payout').textContent = error.message;
        $('payout').className = 'muted small warn';
      }
    });
  }

  /** "4 minutes ago", for a reading whose age is part of what it means. */
  function age(at) {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 90) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  /**
   * The state of the fund, said before anybody picks up a call.
   *
   * The order of these branches is the whole function. `pool_sats` is null when
   * the instance reads its balance from the chain and the chain could not be
   * reached, and null must not fall through to the empty-pool sentence: "nobody
   * knows" told as "there is nothing" is the one lie this service cannot afford,
   * because it is the sentence a person reads while deciding whether to work.
   */
  function renderPoolNote() {
    if (!me) return;
    const note = $('pool-note');
    note.textContent = '';
    const owed = me.earnings.owedSats;
    const reading = me.pool_read_at === null ? '' : ` (read ${age(me.pool_read_at)})`;

    if (me.pool_sats === null) {
      note.textContent =
        `The guarantee is ${me.guarantee_sats} sats per reply. The pool balance could not be read` +
        `${me.pool_error ? ` — ${me.pool_error}` : ''}, so whether it is funded is unknown right now. ` +
        `That is a missing figure, not an empty one: while the pool holds something the guarantee is paid, and ` +
        `when it is empty nothing is paid.`;
      note.className = 'warn';
    } else if (me.pool_sats <= 0) {
      note.textContent =
        `${me.guarantee_sats} sats per reply, paid from the pool — and the pool is empty${reading}. Nothing is ` +
        `paid while it is empty: the promise is recorded and unfunded, and it is paid if the pool gets topped up.`;
      note.className = 'warn';
    } else if (me.pool_sats < owed) {
      note.textContent =
        `Paid ${me.guarantee_sats} sats per answered reply, from a pool of ${me.pool_sats.toLocaleString()} sats` +
        `${reading}. Already owed ${owed.toLocaleString()}, so ${(owed - me.pool_sats).toLocaleString()} of what has ` +
        `been promised is recorded and unpaid.`;
      note.className = 'warn';
    } else {
      note.textContent =
        `Paid ${me.guarantee_sats} sats per answered reply, from a pool of ${me.pool_sats.toLocaleString()} sats` +
        `${reading}. The pool is the only place payment comes from: while there is something in it the guarantee ` +
        `is paid, and when it is empty nothing is paid.`;
      note.className = '';
    }
  }

  initPayoutEditor();

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

  /**
   * Whether the person holding this key still has to say that they are one.
   *
   * Read from the server's record, never from this browser: the declaration is a
   * fact about the key, so it survives a cleared cache, a different machine, and
   * the operator reading the row. A console that remembered it locally would ask
   * nobody again and would be believed.
   */
  function needsDeclaration() {
    return me.declared_at === null || me.declared_at === undefined;
  }

  /**
   * The state of the take button, written in one place because three callers
   * write it and they have to agree.
   *
   * The button is the only thing that puts a claim in flight, and whether that
   * claim carries the declaration is decided by the same fact this sets: a
   * button that is live while the sentence is unticked produces a 400 that reads
   * as a fault in the service rather than as a word missing here.
   */
  function setTakeButton() {
    const needs = needsDeclaration();
    const free = detail !== null && detail.status === 'queued';
    $('claim').disabled = !free || (needs && !declared);
    $('claim').title = needs && !declared
      ? 'tick the declaration first — it is recorded once, against your key'
      : '';
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

    // The declaration sits on the take button, because a claim is the moment
    // somebody becomes an answerer rather than the holder of a key. It is asked
    // once in the life of the key, and the button stays disabled until the
    // sentence is ticked.
    $('declare-row').hidden = !(free && !mine && needsDeclaration());
    $('declare').checked = declared;
    $('claim').hidden = mine;
    setTakeButton();

    // Transcript. The system prompt is read, not dumped: a caller that sends
    // blocks instead of a string is the common case here, and the old rendering
    // showed that array as JSON — a paragraph of instructions as a screenful of
    // punctuation.
    const systemWrap = $('system-wrap');
    const systemParts = Reading.system(detail.system);
    $('system').textContent = '';
    if (systemParts.length > 0) {
      renderParts($('system'), systemParts, 'system');
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
      renderParts(wrapper, Reading.content(message.content), message.role);
      container.append(wrapper);
    });
  }

  /**
   * Renders a reading of a message's content.
   *
   * Every string here was written by a stranger and is set with textContent, so
   * none of it can become markup in this browser. The shapes come from
   * console-reading.js and this function only decides how they look.
   */
  function renderParts(container, parts, role) {
    for (const part of parts) {
      if (part.kind === 'text') {
        container.append(el('div', 'transcript', part.text));
      } else if (part.kind === 'reasoning') {
        const box = el('div', 'transcript block-thinking');
        box.append(el('div', 'block-kind', 'reasoning, from this conversation'));
        box.append(el('div', null, part.text));
        container.append(box);
      } else if (part.kind === 'tool-call') {
        const box = el('div', 'transcript block-tools');
        box.append(el('div', 'block-kind', `${role === 'assistant' ? 'the assistant' : 'the caller'} called a tool`));
        box.append(el('div', 'tool-name', part.name));
        if (part.takesNothing) box.append(el('div', 'field-help muted', 'no arguments'));
        for (const arg of part.args) {
          const row = el('div', 'arg');
          row.append(el('span', 'arg-name', `${arg.name}: `));
          row.append(el('span', arg.json ? 'arg-value json' : 'arg-value', arg.empty ? '(empty)' : arg.value));
          box.append(row);
        }
        box.append(el('div', 'call-id', `id ${part.id} — the result below refers to this id`));
        container.append(box);
      } else if (part.kind === 'tool-result') {
        const box = el('div', 'transcript block-tools');
        box.append(el('div', 'block-kind', `${part.label} — for id ${part.id}`));
        for (const inner of part.parts) {
          box.append(el('div', inner.kind === 'note' ? 'muted' : null, inner.text));
        }
        if (part.parts.length === 0) box.append(el('div', 'muted', '(empty result)'));
        container.append(box);
      } else {
        container.append(el('div', 'transcript muted', part.text));
      }
    }
  }

  /**
   * The tools a caller declared.
   *
   * Reading order is what a person needs: what it is called, what it is for, and
   * what it takes. The caller's own schema stays available underneath, one click
   * away, because the console's reading of a schema is a claim about the
   * caller's words and anyone should be able to check it against them.
   */
  function renderTools() {
    const container = $('tools');
    container.textContent = '';
    const tools = Reading.tools(detail.tools);
    $('tools-count').textContent = tools.length === 0 ? '(none)' : `(${tools.length})`;
    $('tools-details').open = tools.length > 0 && (detail.tool_choice.mode === 'tool' || detail.tool_choice.mode === 'any');

    for (const tool of tools) {
      const box = el('div', 'tool');
      box.append(el('div', 'tool-name', tool.name));
      if (tool.description) box.append(el('div', 'tool-desc', tool.description));

      if (tool.takesNothing) {
        box.append(el('div', 'field-help muted', 'takes no arguments'));
      }
      for (const field of tool.fields) {
        const row = el('div', 'field-line');
        const head = el('div', 'field-head');
        head.append(el('span', field.required ? 'req' : 'opt', field.required ? `${field.label} *` : field.label));
        head.append(el('span', 'field-type', [field.type, field.bounds].filter(Boolean).join(', ')));
        row.append(head);
        if (field.choices.length > 0) row.append(el('div', 'field-help', `one of: ${field.choices.join(' · ')}`));
        if (field.description) row.append(el('div', 'field-help', field.description));
        else if (field.example) row.append(el('div', 'field-help muted', `e.g. ${field.example}`));
        box.append(row);
      }

      if (tool.rawReason) {
        box.append(el('div', 'field-help muted', `shown as JSON: ${tool.rawReason}`));
      }

      const details = el('details');
      details.append(el('summary', null, "the caller's own schema"));
      details.append(el('pre', 'transcript', tool.schema));
      box.append(details);
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
    calls = detail.answer.calls;
    $('answer-errors').hidden = true;

    renderChannels();
    renderToolChoice();
    renderCalls();
    renderStopReasons();
    updateMeter();
  }

  /**
   * The composer, one channel at a time.
   *
   * The reply carries two things: a response text the caller reads, and a signed
   * reasoning block most callers ignore. Two boxes side by side implied they are
   * the same kind of thing and hid the asymmetry — that filling in the reasoning
   * and leaving the text empty produces an answer many callers will receive as
   * nothing at all. So there is one place to type, a switch for which channel it
   * goes to, and the other channel's size is always on its own tab: switching
   * channels never loses text and never hides it either.
   */
  function renderChannels() {
    const reading = Reading.channels(detail.answer);
    if (!reading.tabs.some((tab) => tab.key === channel)) channel = 'response';
    renderChannelTabs(reading);
    const active = reading.tabs.find((tab) => tab.key === channel);
    const composer = $('composer');
    composer.value = channel === 'response' ? detail.answer.response : detail.answer.reasoning;
    composer.placeholder = channel === 'response'
      ? 'what the caller receives as the answer'
      : 'optional — what you actually thought';
  }

  /** Everything about the channels except the text in the box: safe to run while typing. */
  function renderChannelTabs(reading) {
    const reading2 = reading || Reading.channels(detail.answer);
    const tabs = $('channel-switch');
    tabs.textContent = '';
    for (const tab of reading2.tabs) {
      const button = el('button', 'channel' + (tab.key === channel ? ' on' : ''), tab.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.key === channel ? 'true' : 'false');
      // The channel you are not looking at says how much is in it, so text can
      // never be sitting somewhere you have forgotten about.
      if (tab.chars > 0 && tab.key !== channel) button.append(el('span', 'count', ` · ${tab.chars} characters`));
      button.addEventListener('click', () => {
        if (tab.key === channel) return;
        channel = tab.key;
        renderChannels();
        $('composer').focus();
      });
      tabs.append(button);
    }
    const active = reading2.tabs.find((tab) => tab.key === channel) || reading2.tabs[0];
    $('channel-note').textContent = active ? active.note : '';
    $('channel-warning').hidden = reading2.warning === '';
    $('channel-warning').textContent = reading2.warning;
  }

  /** What the caller will accept, and one button per tool it declared. */
  function renderToolChoice() {
    const choice = detail.tool_choice || { mode: 'auto' };
    $('tools-answer').hidden = choice.mode === 'none';
    if (choice.mode === 'none') return;

    // tool_choice "tool" names one tool and forbids the others: its call is put
    // in place rather than offered as a choice that cannot be declined.
    if (choice.mode === 'tool' && choice.name && !calls.some((call) => call.name === choice.name)) {
      calls.push(newCall(choice.name));
    }
    renderAddButtons();
  }

  function renderAddButtons() {
    const view = Reading.toolButtons(detail.tools, calls.map((call) => call.name), detail.tool_choice);
    $('tool-choice-note').textContent = view.note;
    const row = $('add-call-row');
    const box = $('add-call-buttons');
    box.textContent = '';
    row.hidden = view.buttons.length === 0;
    for (const tool of view.buttons) {
      const button = el('button', 'add-tool');
      button.type = 'button';
      button.disabled = !tool.addable;
      if (tool.why) button.title = tool.why;
      button.append(el('span', 'add-name', tool.name));
      if (tool.description) button.append(el('span', 'add-desc', tool.description));
      else if (tool.why) button.append(el('span', 'add-desc', tool.why));
      button.addEventListener('click', () => addCall(tool.name));
      box.append(button);
    }
  }

  function addCall(name) {
    const view = Reading.toolButtons(detail.tools, calls.map((call) => call.name), detail.tool_choice);
    if (!view.canAdd) {
      showErrors(view.refusal || 'this caller does not accept another tool call.', []);
      return;
    }
    calls.push(newCall(name));
    renderCalls();
    queuePartial();
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

    // Whether a tool can still be added depends on how many calls are already
    // here (a caller that forbids parallel calls allows one), so the buttons are
    // rebuilt wherever the calls change rather than only with the request.
    renderAddButtons();
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

    // The draft, not the visible box: the composer shows one channel at a time
    // and the answer is whatever both channels hold.
    const body = {
      thinking: detail.answer.reasoning,
      text: detail.answer.response,
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
    // Character counts on the channel you are not looking at, and the warning
    // about a reasoning-only answer, both change as the answer is written.
    renderChannelTabs();
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
        body: JSON.stringify({ thinking: detail.answer.reasoning, text: detail.answer.response }),
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
  $('declare').addEventListener('change', () => {
    declared = $('declare').checked;
    setTakeButton();
  });
  $('claim').addEventListener('click', async () => {
    try {
      const declaresNow = needsDeclaration();
      detail = await api(`/api/requests/${currentId}/claim`, {
        method: 'POST',
        body: JSON.stringify(declaresNow ? { declare: true } : {}),
      });
      if (declaresNow) {
        // Read it back rather than assuming: the date the server recorded is the
        // date that matters, and it is what the console shows next time.
        me = await api('/api/me');
        renderEarnings(me.earnings);
        renderPoolNote();
      }
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
  $('composer').addEventListener('input', () => {
    if (!detail || !detail.answer) return;
    detail.answer[channel] = $('composer').value;
    queuePartial();
    updateMeter();
  });
  $('submit').addEventListener('click', submit);

  // ---- boot ----------------------------------------------------------------

  if (key) signIn(key);
  else signOut('');
})();
