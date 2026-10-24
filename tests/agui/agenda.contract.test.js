/**
 * Owner's agenda contract (ASISaga/boardroom.asisaga.com#73; boardroom-
 * orchestration spec 21): the proposed F endpoints GET {api}/agenda and
 * POST {api}/agenda/veto through CopilotKitClient, and the view model that
 * derives each decision's status, veto window and the consent digest.
 *
 * Run: npm run test:agui
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CopilotKitClient } from '../../assets/js/copilotkit-client.js';
import {
  normalizeAgendaView,
  vetoWindowLeftMs,
  canVeto,
  formatWindowLeft,
  digestLine,
  digestMoreLine,
  vetoReason,
} from '../../assets/js/boardroom-app/agenda-model.js';

const HOUR = 60 * 60 * 1000;
const NOW = '2026-10-24T12:00:00Z';
const NOW_MS = Date.parse(NOW);

function decision(overrides = {}) {
  return {
    item: 'item.7',
    title: 'Hire a <b>second</b> engineer',
    text: 'Hire one senior engineer',
    reason: 'Roadmap needs it',
    forecast: 'Release ships by Q1',
    level: 'pair',
    deciders: ['CTO', 'CFO'],
    decided_at: '2026-10-24T06:00:00Z',
    effective_at: '2026-10-25T06:00:00Z',
    status: 'pending',
    vetoed: null,
    called_in: null,
    ...overrides,
  };
}

function ownerView(overrides = {}) {
  return {
    schema: 'boardroom.agenda.owner_view.v1',
    enabled: true,
    now: NOW,
    veto_window_hours: 24,
    decisions: [decision()],
    consent_digest: { decisions: [decision({ level: 'one', deciders: ['CTO'], status: 'effective' })], more: 3 },
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('CopilotKitClient owner agenda endpoints', () => {
  test('the agenda URL is a sibling of /ag-ui', () => {
    assert.equal(CopilotKitClient.agendaUrlFor('https://api.boardroom.asisaga.com/ag-ui'),
      'https://api.boardroom.asisaga.com/agenda');
    assert.equal(new CopilotKitClient({ runtimeUrl: '/api/ag-ui' }).agendaUrl, '/api/agenda');
  });

  test('fetchAgenda GETs the view with the bearer token and no cache', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json(ownerView()); };
    const client = new CopilotKitClient({ runtimeUrl: '/ag-ui', getAccessToken: async () => 'tok' });
    const body = await client.fetchAgenda();
    assert.equal(body.decisions[0].item, 'item.7');
    assert.equal(requests[0].url, '/agenda');
    assert.equal(requests[0].init.method, 'GET');
    assert.equal(requests[0].init.cache, 'no-store');
    assert.match(requests[0].init.headers.Authorization, /tok$/);
    assert.equal(requests[0].init.headers['Content-Type'], undefined);
    assert.equal(requests[0].init.body, undefined, 'the company comes from the token, never the page');
  });

  test('vetoDecision POSTs the item, reason and decided_at', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return json({ ...decision(), status: 'vetoed', vetoed: { by: 'owner', at: NOW, reason: 'Too early' } });
    };
    const client = new CopilotKitClient({ runtimeUrl: '/ag-ui' });
    const body = await client.vetoDecision('item.7', 'Too early', '2026-10-24T06:00:00Z');
    assert.equal(body.status, 'vetoed');
    assert.equal(requests[0].url, '/agenda/veto');
    assert.equal(requests[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].init.body),
      { item: 'item.7', reason: 'Too early', decided_at: '2026-10-24T06:00:00Z' });
  });

  test('a veto outside the window is refused with code veto_window_closed', async () => {
    globalThis.fetch = async () => json({
      detail: 'the veto window for item.7 has closed', code: 'veto_window_closed', action: 'none',
    }, 409);
    const client = new CopilotKitClient({ runtimeUrl: '/ag-ui' });
    await assert.rejects(client.vetoDecision('item.7', 'Too late'), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'veto_window_closed');
      return true;
    });
  });

  test('an agenda error carries the structured error body', async () => {
    globalThis.fetch = async () => json({ detail: 'admin role required', code: 'role_missing', action: 'request_role' }, 403);
    const client = new CopilotKitClient({ runtimeUrl: '/ag-ui' });
    await assert.rejects(client.fetchAgenda(), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'role_missing');
      return true;
    });
  });
});

describe('owner agenda view model', () => {
  test('the view is normalised: decisions, digest and its overflow count', () => {
    const view = normalizeAgendaView(ownerView());
    assert.equal(view.enabled, true);
    assert.equal(view.now, NOW_MS);
    assert.equal(view.vetoWindowHours, 24);
    assert.equal(view.decisions.length, 1);
    const [d] = view.decisions;
    assert.equal(d.title, 'Hire a <b>second</b> engineer', 'untrusted text is kept verbatim, never parsed');
    assert.deepEqual(d.deciders, ['CTO', 'CFO']);
    assert.equal(d.status, 'pending');
    assert.equal(view.digest.decisions.length, 1);
    assert.equal(view.digest.more, 3);
  });

  test('malformed entries are dropped; a switched-off agenda is reported', () => {
    const view = normalizeAgendaView({
      enabled: false,
      decisions: [null, { item: 'not-a-handle' }, decision({ item: 'item.9' })],
      consent_digest: { decisions: 'x', more: -1 },
    });
    assert.equal(view.enabled, false);
    assert.deepEqual(view.decisions.map((d) => d.item), ['item.9']);
    assert.deepEqual(view.digest, { decisions: [], more: 0 });
    assert.equal(view.vetoWindowHours, 24, 'the placeholder window when the view omits it');
    assert.deepEqual(normalizeAgendaView(null).decisions, []);
  });

  test('a missing status is derived as in spec 21 R22', () => {
    const view = normalizeAgendaView(ownerView({
      decisions: [
        decision({ item: 'item.1', status: undefined }),
        decision({ item: 'item.2', status: undefined, effective_at: '2026-10-24T06:00:00Z' }),
        decision({ item: 'item.3', status: undefined, vetoed: { by: 'owner', at: NOW, reason: 'No' } }),
        decision({ item: 'item.4', status: undefined, called_in: { by: 'CFO', at: NOW, reason: 'Board' } }),
      ],
    }));
    assert.deepEqual(view.decisions.map((d) => d.status), ['pending', 'effective', 'vetoed', 'called_in']);
    assert.equal(view.decisions[2].vetoed.reason, 'No');
  });

  test('the veto window runs from decided_at, or ends at veto_window_ends_at', () => {
    const [d] = normalizeAgendaView(ownerView()).decisions;
    assert.equal(vetoWindowLeftMs(d, NOW_MS, 24), 18 * HOUR);
    assert.equal(vetoWindowLeftMs(d, NOW_MS + 19 * HOUR, 24), 0);
    const [e] = normalizeAgendaView(ownerView({
      decisions: [decision({ veto_window_ends_at: '2026-10-24T13:30:00Z' })],
    })).decisions;
    assert.equal(vetoWindowLeftMs(e, NOW_MS, 24), 1.5 * HOUR);
  });

  test('a veto is offered only inside the window, and never twice', () => {
    const view = normalizeAgendaView(ownerView({
      decisions: [
        decision({ item: 'item.1' }),
        decision({ item: 'item.2', status: 'effective', effective_at: '2026-10-24T06:00:00Z' }),
        decision({ item: 'item.3', decided_at: '2026-10-22T06:00:00Z', status: 'effective' }),
        decision({ item: 'item.4', status: 'vetoed' }),
        decision({ item: 'item.5', status: 'called_in' }),
        decision({ item: 'item.6', decided_at: 'garbage' }),
      ],
    }));
    assert.deepEqual(view.decisions.map((d) => canVeto(d, NOW_MS, view.vetoWindowHours)),
      [true, true, false, false, false, false]);
  });

  test('time left, digest lines and the veto reason', () => {
    assert.equal(formatWindowLeft(0), 'closed');
    assert.equal(formatWindowLeft(30000), 'under 1 min left');
    assert.equal(formatWindowLeft(4 * 60000 + 59000), '4 min left', 'rounded down, never overstated');
    assert.equal(formatWindowLeft(23 * HOUR + 5 * 60000), '23 h 5 min left');
    assert.equal(formatWindowLeft(24 * HOUR), '24 h left');

    const [d] = normalizeAgendaView(ownerView()).digest.decisions;
    assert.equal(digestLine(d), '[item.7] Hire a <b>second</b> engineer: Hire one senior engineer (CTO, one CXO)');
    assert.equal(digestMoreLine(3), '… and 3 more not shown.');
    assert.equal(digestMoreLine(0), '');

    assert.equal(vetoReason('  Too early  '), 'Too early');
    assert.equal(vetoReason('   '), null, 'a reason is required');
    assert.equal(vetoReason('x'.repeat(8001)), null);
  });
});
