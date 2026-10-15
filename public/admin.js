/*
 * The operator page. Same discipline as the console: everything from the
 * database or from a responder is written as text, never as markup.
 */
(() => {
  'use strict';

  const KEY_STORE = 'humans.admin.key';
  let key = localStorage.getItem(KEY_STORE) || '';
  let overview = null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-admin-key': key, ...(options.headers || {}) },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(body?.error?.message || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function signIn(candidate) {
    key = candidate;
    try {
      overview = await api('/api/admin/overview');
      localStorage.setItem(KEY_STORE, key);
      $('gate').hidden = true;
      $('app').hidden = false;
      $('who-label').textContent = 'signed in';
      $('conn').className = 'dot live';
      render();
    } catch (error) {
      $('gate-error').hidden = false;
      $('gate-error').textContent = error.message;
      $('conn').className = 'dot';
    }
  }

  async function refresh() {
    overview = await api('/api/admin/overview');
    render();
  }

  function stat(label, value, extra) {
    const box = el('div', 'stat', null);
    box.append(el('div', 'muted small', label));
    box.append(el('div', 'n', value));
    if (extra) box.append(el('div', 'muted small', extra));
    return box;
  }

  function render() {
    const stats = overview.stats;
    const statsBox = $('stats');
    statsBox.textContent = '';
    statsBox.append(
      stat('waiting', stats.waiting),
      stat('claimed', stats.claimed),
      stat('answered', stats.answered, `${stats.answeredLast24h} in 24h`),
      stat('expired', stats.expired),
      stat(
        'median answer',
        stats.medianResponseMs === null ? '—' : `${Math.round(stats.medianResponseMs / 1000)}s`,
      ),
      stat('responders', stats.responders),
      stat('sats earned', stats.earnedSats),
      stat('sats paid', stats.paidSats),
      stat('sats owed', stats.owedSats),
      stat('pool', stats.poolSats),
    );

    const pool = $('pool-note');
    if (stats.poolSats === 0) {
      pool.textContent =
        'The pool is empty, so every guarantee written is unfunded and nothing is paid. Top the fund up, or set HUMANS_GUARANTEE_SATS=0 if you mean to pay nobody.';
      pool.className = 'warn small';
    } else if (stats.poolSats < stats.owedSats) {
      pool.textContent =
        `Owed ${stats.owedSats} sats against a pool of ${stats.poolSats}: ${stats.owedSats - stats.poolSats} sats of what has been promised is uncovered and unpaid.`;
      pool.className = 'warn small';
    } else {
      pool.textContent = `Pool covers what is owed (${stats.owedSats} of ${stats.poolSats} sats).`;
      pool.className = 'muted small';
    }

    const config = overview.config;
    $('config-note').textContent =
      `${config.public_name} · ${config.public_url || 'no public url set'} · operator: ${config.operator} · ` +
      `call deadline ${Math.round(config.call_timeout_ms / 1000)}s · hold ${Math.round(config.claim_lease_ms / 1000)}s · ` +
      `guarantee ${config.guarantee_sats} sats · caller keys ${config.require_caller_key ? 'required' : 'not required'}`;

    const credentials = $('credentials');
    credentials.textContent = '';
    for (const credential of overview.credentials) {
      const row = el('tr');
      row.append(el('td', null, credential.id));
      row.append(el('td', null, credential.kind));
      row.append(el('td', null, credential.name));
      row.append(el('td', credential.active === 1 ? '' : 'muted', credential.active === 1 ? 'active' : 'revoked'));
      row.append(el('td', 'muted', credential.last_used_at ? new Date(credential.last_used_at).toLocaleString() : 'never'));
      const action = el('td');
      if (credential.active === 1) {
        const button = el('button', 'link', 'revoke');
        button.addEventListener('click', async () => {
          await api(`/api/admin/credentials/${credential.id}/revoke`, { method: 'POST', body: '{}' });
          await refresh();
        });
        action.append(button);
      }
      row.append(action);
      credentials.append(row);
    }

    const owing = $('owing');
    owing.textContent = '';
    for (const responder of overview.responders) {
      const row = el('tr');
      row.append(el('td', null, responder.responder));
      row.append(el('td', null, responder.replies));
      row.append(el('td', null, responder.earnedSats));
      row.append(el('td', null, responder.paidSats));
      row.append(el('td', responder.owedSats > 0 ? 'warn' : '', responder.owedSats));
      row.append(
        el(
          'td',
          responder.payoutAddress ? 'muted mono' : 'warn',
          responder.payoutAddress || 'no address given',
        ),
      );
      row.append(el('td', 'muted', responder.averageRating === null ? 'unrated' : `${responder.averageRating.toFixed(1)}/5 (${responder.ratings})`));

      // Paying someone is the one thing on this page that moves money, and the
      // three fields it needs are already in this row. Asking for them again by
      // hand is how a payment goes to the address of whoever paid last.
      const pay = el('button', 'link', 'settle');
      pay.type = 'button';
      pay.addEventListener('click', () => {
        $('settle-responder').value = responder.responder;
        $('settle-sats').value = responder.owedSats > 0 ? responder.owedSats : '';
        $('settle-address').value = responder.payoutAddress || '';
        $('settle-txid').value = '';
        $('settle-form').scrollIntoView({ block: 'nearest' });
        ($('settle-txid').value === '' ? $('settle-txid') : $('settle-sats')).focus();
      });
      row.append(el('td', null, pay));
      owing.append(row);
    }

    const requests = $('requests');
    requests.textContent = '';
    for (const request of overview.requests) {
      const row = el('tr');
      row.append(el('td', 'muted', new Date(request.created_at).toLocaleString()));
      row.append(el('td', null, request.status));
      row.append(el('td', null, request.summary || ''));
      row.append(el('td', 'muted', request.claimed_by || request.caller || ''));
      row.append(el('td', 'muted', request.id));
      requests.append(row);
    }
  }

  async function loadLedger() {
    const data = await api('/api/admin/ledger?limit=200');
    const body = $('ledger');
    body.textContent = '';
    for (const entry of data.entries) {
      const row = el('tr');
      row.append(el('td', 'muted', new Date(entry.created_at).toLocaleString()));
      row.append(el('td', null, entry.responder));
      row.append(el('td', entry.kind === 'settlement' ? 'warn' : '', entry.kind));
      row.append(el('td', null, entry.sats));
      row.append(el('td', 'muted', entry.txid ? `${entry.address} · ${entry.txid}` : entry.note || ''));
      body.append(row);
    }
  }

  $('gate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('gate-key').value.trim();
    if (value) signIn(value);
  });

  $('mint-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const kind = $('mint-kind').value;
    const name = $('mint-name').value.trim();
    if (!name) return;
    const out = $('mint-out');
    out.textContent = '';
    try {
      const minted = await api('/api/admin/credentials', { method: 'POST', body: JSON.stringify({ kind, name }) });
      out.append(el('p', 'warn', 'Copy it now. It is stored hashed and cannot be shown again.'));
      out.append(el('div', 'key-out', minted.key));
      $('mint-name').value = '';
      await refresh();
    } catch (error) {
      out.append(el('p', 'error', error.message));
    }
  });

  $('settle-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = $('settle-error');
    errorBox.hidden = true;
    try {
      await api('/api/admin/settlements', {
        method: 'POST',
        body: JSON.stringify({
          responder: $('settle-responder').value.trim(),
          sats: Number($('settle-sats').value),
          address: $('settle-address').value.trim(),
          txid: $('settle-txid').value.trim(),
        }),
      });
      $('settle-sats').value = '';
      $('settle-txid').value = '';
      await refresh();
      await loadLedger();
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message;
    }
  });

  document.addEventListener('toggle', (event) => {
    if (event.target.tagName === 'DETAILS' && event.target.open) loadLedger().catch(() => {});
  }, true);

  if (key) signIn(key);
})();
