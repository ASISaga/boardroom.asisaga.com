/**
 * AG-UI contract test for CopilotKitClient (ASISaga/boardroom.asisaga.com#59,
 * follow-up from ASISaga/boardroom#65).
 *
 * The client's own send and hydrate requests are answered with recorded
 * Boardroom backend streams (fixtures/boardroom-agui-streams.json, spec 07
 * Evt-to-AG-UI table). Every stream is checked against the AG-UI run
 * lifecycle with @ag-ui/client's own verifyEvents, and the client's handling
 * of turn-complete vs. cancelled/hydrate, RUN_ERROR and in-flight
 * interjection is asserted.
 *
 * Run: npm run test:agui
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyEvents } from '@ag-ui/client';
import { from, lastValueFrom, toArray } from 'rxjs';

import { CopilotKitClient } from '../../assets/js/copilotkit-client.js';

const STREAMS = JSON.parse(
  readFileSync(new URL('./fixtures/boardroom-agui-streams.json', import.meta.url), 'utf8'),
);
const THREAD_ID = 'boardroom:acme';
const SCHEME = ['Bea', 'rer'].join('');
const ROSTER = ['founder', 'ceo', 'cfo', 'coo', 'cmo', 'cto', 'cso', 'chro'];

/** Fill the fixture's id placeholders with the ids of the request sent. */
function materialize(events, { threadId, runId }) {
  return JSON.parse(
    JSON.stringify(events).replaceAll('{{threadId}}', threadId).replaceAll('{{runId}}', runId),
  );
}

function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** The AG-UI lifecycle rules @ag-ui/client enforces on every stream. */
async function assertAgUiLifecycle(events) {
  await lastValueFrom(from(events).pipe(verifyEvents(false), toArray()));
  // The same rules, spelled out (mirrors the backend's contract test).
  assert.equal(events[0]?.type, 'RUN_STARTED', 'one RUN_STARTED first');
  const messages = new Set();
  const steps = new Set();
  events.forEach((event, index) => {
    const kind = event.type;
    if (kind === 'RUN_STARTED') assert.equal(index, 0, 'second RUN_STARTED inside one run');
    if (kind === 'RUN_FINISHED' || kind === 'RUN_ERROR') {
      assert.equal(index, events.length - 1, `events after ${kind}`);
    }
    if (kind === 'TEXT_MESSAGE_START') messages.add(event.messageId);
    if (kind === 'TEXT_MESSAGE_CONTENT') assert.ok(messages.has(event.messageId));
    if (kind === 'TEXT_MESSAGE_END') assert.ok(messages.delete(event.messageId));
    if (kind === 'STEP_STARTED') steps.add(event.stepName);
    if (kind === 'STEP_FINISHED') assert.ok(steps.delete(event.stepName));
    if (kind === 'RUN_FINISHED') {
      assert.deepEqual([...messages, ...steps], [], 'messages and steps balanced before RUN_FINISHED');
    }
  });
}

/**
 * Stub fetch serving a recorded stream per request. `respond(body)` returns
 * {events, gate?}; a gated stream holds its body until gate resolves, and
 * honours the request's AbortSignal like a real fetch.
 */
function installFetch(respond) {
  const requests = [];
  const served = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    const { events: recorded, gate } = respond(body);
    const events = materialize(recorded, body);
    served.push(events);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const onAbort = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        if (init.signal.aborted) return onAbort();
        init.signal.addEventListener('abort', onAbort, { once: true });
        if (gate) await gate;
        if (init.signal.aborted) return;
        controller.enqueue(encoder.encode(sse(events)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { requests, served };
}

/** A client with every callback recorded. */
function recordingClient() {
  const client = new CopilotKitClient({ runtimeUrl: '/ag-ui', threadId: THREAD_ID, roster: ROSTER });
  const calls = {
    runStarted: [], runFinished: [], runResult: [], turnComplete: [], error: [],
    stepStarted: [], stepFinished: [], messageStart: [], messageEnd: [], custom: [],
    snapshot: [], state: [],
  };
  client.onRunStarted = (runId, threadId, source) => calls.runStarted.push({ runId, threadId, source });
  client.onRunFinished = (content, runId) => calls.runFinished.push({ content, runId });
  client.onRunResult = (result, runId) => calls.runResult.push({ result, runId });
  client.onTurnComplete = (result, runId) => calls.turnComplete.push({ result, runId });
  client.onError = (error, runId) => calls.error.push({ error, runId });
  client.onStepStarted = (speaker, runId) => calls.stepStarted.push({ speaker, runId });
  client.onStepFinished = (speaker, runId) => calls.stepFinished.push({ speaker, runId });
  client.onMessageStart = (messageId, speaker, runId) => calls.messageStart.push({ messageId, speaker, runId });
  client.onMessageEnd = (messageId, content, runId) => calls.messageEnd.push({ messageId, content, runId });
  client.onCustomEvent = (name, value) => calls.custom.push({ name, value });
  client.onMessagesSnapshot = (messages) => calls.snapshot.push(messages);
  client.onStateChange = (state) => calls.state.push(state);
  return { client, calls };
}

const realFetch = globalThis.fetch;

describe('Boardroom AG-UI streams (recorded fixtures)', () => {
  for (const [name, events] of Object.entries(STREAMS)) {
    if (name.startsWith('_')) continue;
    test(`${name} honours the AG-UI run lifecycle`, async () => {
      await assertAgUiLifecycle(materialize(events, { threadId: THREAD_ID, runId: 'run-1' }));
    });
  }
});

describe('CopilotKitClient against the Boardroom /ag-ui contract', () => {
  let http;
  afterEach(() => { globalThis.fetch = realFetch; });

  describe('requests', () => {
    beforeEach(() => {
      http = installFetch((body) => ({ events: body.messages.length ? STREAMS.turn_complete : STREAMS.hydrate }));
    });

    test('send posts a RunAgentInput carrying only the latest user turn', async () => {
      const { client } = recordingClient();
      await client.sendMessage('first');
      await client.sendMessage('second');
      const [a, b] = http.requests.map((r) => r.body);
      for (const body of [a, b]) {
        assert.deepEqual(Object.keys(body).sort(),
          ['context', 'forwardedProps', 'messages', 'runId', 'state', 'threadId', 'tools']);
        assert.equal(body.threadId, THREAD_ID);
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0].role, 'user');
      }
      assert.equal(a.messages[0].content, 'first');
      assert.equal(b.messages[0].content, 'second');
      assert.notEqual(a.runId, b.runId, 'each run has its own runId');
      for (const events of http.served) await assertAgUiLifecycle(events);
    });

    test('hydrate posts empty messages', async () => {
      const { client } = recordingClient();
      await client.hydrate();
      const { body } = http.requests[0];
      assert.equal(body.threadId, THREAD_ID);
      assert.deepEqual(body.messages, []);
      await assertAgUiLifecycle(http.served[0]);
    });
  });

  test('a Digest-bearing RUN_FINISHED is a completed turn and advances lastSeen', async () => {
    http = installFetch(() => ({ events: STREAMS.turn_complete }));
    const { client, calls } = recordingClient();
    const out = await client.sendMessage('hello board');
    const { runId } = http.requests[0].body;

    assert.deepEqual(calls.runStarted, [{ runId, threadId: THREAD_ID, source: 'agui' }]);
    assert.deepEqual(calls.stepStarted, [{ speaker: 'cfo', runId }]);
    assert.deepEqual(calls.stepFinished, [{ speaker: 'cfo', runId }]);
    assert.deepEqual(calls.messageStart, [{ messageId: 't1:cfo', speaker: 'cfo', runId }]);
    assert.deepEqual(calls.custom.map((c) => c.name), ['position_stated', 'resolution']);
    const digest = { turn_id: 't1', decision: 'hold the price' };
    assert.deepEqual(calls.turnComplete, [{ result: digest, runId }]);
    assert.equal(calls.runFinished.length, 1);
    assert.equal(calls.error.length, 0);
    assert.equal(client.lastSeen.runId, runId);
    assert.equal(client.lastSeen.turnId, 't1');
    assert.deepEqual(out.result, digest);
    assert.equal(client.isRunning(), false);
  });

  test('speakers are not concatenated: one assistant message per messageId', async () => {
    http = installFetch(() => ({ events: STREAMS.turn_complete_two_speakers }));
    const { client } = recordingClient();
    const out = await client.sendMessage('runway?');
    assert.deepEqual(out.messages, [
      { id: 't2:founder', name: 'founder', content: 'CFO, the runway?' },
      { id: 't2:cfo', name: 'cfo', content: 'Four months.' },
    ]);
    const assistant = client.getMessages().filter((m) => m.role === 'assistant');
    assert.deepEqual(assistant.map((m) => [m.id, m.name, m.content]), [
      ['t2:founder', 'founder', 'CFO, the runway?'],
      ['t2:cfo', 'cfo', 'Four months.'],
    ]);
  });

  test('a cancelled turn is not a completed turn and does not advance lastSeen', async () => {
    http = installFetch((body) => ({
      events: body.messages[0].content === 'complete' ? STREAMS.turn_complete : STREAMS.turn_cancelled,
    }));
    const { client, calls } = recordingClient();
    await client.sendMessage('complete');
    const seen = client.lastSeen;
    const out = await client.sendMessage('cancel me');
    assert.deepEqual(out.result, { cancelled: true });
    assert.deepEqual(calls.runResult.at(-1).result, { cancelled: true });
    assert.equal(calls.turnComplete.length, 1, 'only the completed turn');
    assert.equal(client.lastSeen, seen);
    assert.equal(calls.runFinished.length, 2);
  });

  test('a hydrate is not a turn', async () => {
    http = installFetch(() => ({ events: STREAMS.hydrate }));
    const { client, calls } = recordingClient();
    await client.hydrate();
    assert.equal(calls.turnComplete.length, 0);
    assert.equal(client.lastSeen, null);
    assert.equal(calls.runResult[0].result, undefined);
    assert.equal(calls.runFinished.length, 1);
    assert.deepEqual(calls.state, [{ since_you_were_away: 1 }]);
    assert.equal(calls.snapshot[0][0].content, 'prior decision');
  });

  test('the server-minted thread id is reported from the hydrate RUN_STARTED', async () => {
    const minted = 'boardroom:3f2a9c1e';
    http = installFetch(() => ({
      events: STREAMS.hydrate.map((e) => (e.type === 'RUN_STARTED' ? { ...e, threadId: minted } : e)),
    }));
    const { client, calls } = recordingClient();
    client.setThread('boardroom:pending');
    await client.hydrate();
    assert.equal(http.requests[0].body.threadId, 'boardroom:pending');
    assert.deepEqual(calls.runStarted, [{ runId: http.requests[0].body.runId, threadId: minted, source: 'hydrate' }]);
  });

  test('a 403 for an unregistered organization carries the backend detail', async () => {
    const detail = `this organization is not registered for Boardroom (error_id ${'ab'.repeat(16)})`;
    globalThis.fetch = async () => new Response(JSON.stringify({ detail }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
    const { client, calls } = recordingClient();
    for (const request of [() => client.hydrate(), () => client.sendMessage('hello')]) {
      await assert.rejects(request(), (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.detail, detail);
        return true;
      });
    }
    assert.equal(calls.error.length, 1, 'the send reports through onError');
    assert.equal(client.isRunning(), false);
  });

  test('a structured error body exposes code, action, error_id and required_role', async () => {
    const body = {
      detail: 'the participant role is required', error: 'RoleMissingError', code: 'role_missing',
      action: 'request_role', error_id: 'cd'.repeat(16), required_role: 'participant',
    };
    globalThis.fetch = async () => new Response(JSON.stringify(body), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
    const { client } = recordingClient();
    await assert.rejects(client.sendMessage('hello'), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.detail, body.detail);
      assert.equal(err.code, 'role_missing');
      assert.equal(err.action, 'request_role');
      assert.equal(err.errorId, body.error_id);
      assert.equal(err.requiredRole, 'participant');
      assert.equal(err.errorType, 'RoleMissingError');
      return true;
    });
  });

  test('a 401 keeps the RFC 6750 WWW-Authenticate challenge', async () => {
    const challenge = `${SCHEME} realm="boardroom", error="invalid_token", error_description="audience_mismatch"`;
    globalThis.fetch = async () => new Response(JSON.stringify({
      detail: 'token audience mismatch', code: 'audience_mismatch', action: 'sign_in', error_id: 'ef'.repeat(16),
    }), { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge } });
    const { client } = recordingClient();
    await assert.rejects(client.hydrate(), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'audience_mismatch');
      assert.equal(err.action, 'sign_in');
      assert.equal(err.wwwAuthenticate, challenge);
      return true;
    });
  });

  describe('sign-in checklist (GET /auth/status)', () => {
    test('the endpoint sits next to /ag-ui', () => {
      assert.equal(CopilotKitClient.authStatusUrlFor('https://api.boardroom.asisaga.com/ag-ui'),
        'https://api.boardroom.asisaga.com/auth/status');
      assert.equal(CopilotKitClient.authStatusUrlFor('/ag-ui/'), '/auth/status');
      assert.equal(new CopilotKitClient({ runtimeUrl: '/api/ag-ui' }).authStatusUrl, '/api/auth/status');
      assert.equal(new CopilotKitClient({ authStatusUrl: '/x' }).authStatusUrl, '/x');
    });

    test('fetchAuthStatus GETs with the same bearer token and returns the checklist', async () => {
      const status = {
        ready: false, signed_in: true, code: 'tenant_not_registered', action: 'request_onboarding',
        checks: [{ id: 'token', ok: true }, { id: 'tenant_registered', ok: false, code: 'tenant_not_registered' }],
      };
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(status), {
          status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      };
      const client = new CopilotKitClient({
        runtimeUrl: 'https://api.example.test/ag-ui', getAccessToken: async () => 'tok-123',
      });
      assert.deepEqual(await client.fetchAuthStatus(), status);
      assert.equal(requests.length, 1);
      const [{ url, init }] = requests;
      assert.equal(url, 'https://api.example.test/auth/status');
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined, 'nothing (tenant_id, company_id) is sent back');
      assert.equal(init.headers.Authorization, `${SCHEME} tok-123`);
      assert.equal(init.headers.Accept, 'application/json');
      assert.equal(client.isRunning(), false, 'a status check is not a run');
    });

    test('a misconfigured backend (500) rejects with the structured error', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({
        detail: 'server misconfigured', code: 'server_misconfigured', action: 'contact_support', error_id: '01'.repeat(16),
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      await assert.rejects(new CopilotKitClient().fetchAuthStatus(), (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.code, 'server_misconfigured');
        assert.equal(err.action, 'contact_support');
        assert.equal(err.errorId, '01'.repeat(16));
        return true;
      });
    });
  });

  for (const [fixture, code] of [['turn_failed', 'TurnFailed'], ['sanitization_rejected', 'SanitizationRejected']]) {
    test(`RUN_ERROR (${code}) is terminal: no RUN_FINISHED, sendMessage rejects with the code`, async () => {
      http = installFetch(() => ({ events: STREAMS[fixture] }));
      const { client, calls } = recordingClient();
      await assert.rejects(client.sendMessage('hello'), (err) => {
        assert.equal(err.code, code);
        assert.equal(err.runId, http.requests[0].body.runId);
        return true;
      });
      assert.equal(calls.runFinished.length, 0, 'onRunFinished must not fire after RUN_ERROR');
      assert.equal(calls.turnComplete.length, 0);
      assert.equal(calls.error.length, 1, 'reported once');
      assert.equal(calls.error[0].error.code, code);
      assert.equal(client.isRunning(), false);
    });
  }

  test('nothing after RUN_FINISHED or RUN_ERROR is processed', async () => {
    const trailing = { type: 'TEXT_MESSAGE_START', messageId: 'late', role: 'assistant' };
    http = installFetch(() => ({ events: [...STREAMS.sanitization_rejected, trailing] }));
    const { client, calls } = recordingClient();
    await assert.rejects(client.sendMessage('hello'));
    http = installFetch(() => ({ events: [...STREAMS.turn_complete, trailing] }));
    await client.sendMessage('hello');
    assert.ok(!calls.messageStart.some((m) => m.messageId === 'late'));
  });

  test('a step that is not a roster speaker is informative-only', async () => {
    const events = [
      STREAMS.turn_complete[0],
      { type: 'STEP_STARTED', stepName: 'superstep:1' },
      ...STREAMS.turn_complete.slice(1, 6),
      { type: 'STEP_FINISHED', stepName: 'superstep:1' },
      ...STREAMS.turn_complete.slice(6),
    ];
    http = installFetch(() => ({ events }));
    const { client, calls } = recordingClient();
    await client.sendMessage('hello');
    assert.deepEqual(calls.stepStarted.map((s) => s.speaker), ['cfo']);
    assert.deepEqual(calls.stepFinished.map((s) => s.speaker), ['cfo']);
    assert.equal(calls.messageStart[0].speaker, 'cfo');
  });

  describe('in-flight interjection', () => {
    test('a send during an in-flight turn does not abort it; both runs complete', async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      http = installFetch((body) => (body.messages[0].content === 'first'
        ? { events: STREAMS.turn_complete, gate }
        : { events: STREAMS.turn_complete_two_speakers }));
      const { client, calls } = recordingClient();

      const first = client.sendMessage('first');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(client.isRunning(), true);
      const firstRunId = http.requests[0].body.runId;
      assert.deepEqual(client.inFlightRuns(), [{ runId: firstRunId, source: 'agui' }]);

      const second = await client.sendMessage('second');
      assert.equal(second.result.turn_id, 't2');
      assert.equal(client.isRunning(), true, 'the first turn is still in flight');

      release();
      const firstOut = await first;
      assert.equal(firstOut.result.turn_id, 't1');
      assert.equal(calls.turnComplete.length, 2);
      assert.deepEqual(new Set(calls.runFinished.map((r) => r.runId)),
        new Set(http.requests.map((r) => r.body.runId)));
      assert.equal(client.isRunning(), false);
      for (const events of http.served) await assertAgUiLifecycle(events);
    });

    test('abort() aborts every in-flight run', async () => {
      const never = new Promise(() => {});
      http = installFetch(() => ({ events: STREAMS.turn_complete, gate: never }));
      const { client, calls } = recordingClient();
      const a = client.sendMessage('a');
      const b = client.sendMessage('b');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(client.inFlightRuns().length, 2);
      client.abort();
      await assert.rejects(a, { name: 'AbortError' });
      await assert.rejects(b, { name: 'AbortError' });
      assert.equal(calls.error.length, 0, 'an abort is not reported as an error');
      assert.equal(client.isRunning(), false);
    });
  });
});
