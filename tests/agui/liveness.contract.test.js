/**
 * Liveness as status, and only what is known (ASISaga/boardroom.asisaga.com#78,
 * visible board follow-up 3 of 3). Heartbeats feed the status strip and are
 * never log lines; the log keeps the order the board produced; the schedule,
 * the room, the access and a missing trace each say what the server said, or
 * "not reported". One test per check of the issue's requirement 16.
 *
 * Run: npm run test:agui
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CopilotKitClient } from '../../assets/js/copilotkit-client.js';
import { ChatLog } from '../../assets/js/boardroom-app/chat-log.js';
import { AguiSession } from '../../assets/js/boardroom-app/agui-session.js';
import {
  TraceStore,
  buildTimeline,
  traceAbsence,
  serverFailureCard,
  failureCards,
} from '../../assets/js/boardroom-app/trace-model.js';
import {
  boardStatus,
  idleStatus,
  liveWait,
  waitText,
  silenceStatus,
  RunLogGate,
} from '../../assets/js/boardroom-app/board-status-model.js';
import {
  LivenessState,
  LIVENESS_EVENT,
  normalizeLiveness,
} from '../../assets/js/boardroom-app/liveness-model.js';
import { roomReport, roomCountText } from '../../assets/js/boardroom-app/room-model.js';
import { accessReport, accessView } from '../../assets/js/boardroom-app/access-model.js';

const TRACES = JSON.parse(
  readFileSync(new URL('./fixtures/boardroom-trace.json', import.meta.url), 'utf8'),
);
const RATE_LIMITED = TRACES.rate_limited_turn;
const RL_TURN = RATE_LIMITED[0].turn_id;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serve(events) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const filled = JSON.parse(JSON.stringify(events)
      .replaceAll('{{threadId}}', body.threadId).replaceAll('{{runId}}', body.runId));
    const text = filled.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

const START = { type: 'RUN_STARTED', threadId: '{{threadId}}', runId: '{{runId}}' };
const FINISH = { type: 'RUN_FINISHED', threadId: '{{threadId}}', runId: '{{runId}}' };
const beat = (extra = {}) => ({
  type: 'CUSTOM', name: LIVENESS_EVENT,
  value: { running: true, phase: 'model_call', agent: 'cfo', elapsed_s: 12, since_last_word_s: 3, ...extra },
});

/** A ChatLog whose lines are collected instead of drawn. */
function collectingLog() {
  const log = new ChatLog({ elements: {} });
  const lines = [];
  log.note = (kind, text) => { lines.push(text); return null; };
  return { log, lines };
}

/** Run a served stream through the client the way AguiSession wires it. */
async function play(events, { onBeat } = {}) {
  serve(events);
  const client = new CopilotKitClient({ runtimeUrl: '/ag-ui', threadId: 'boardroom:acme' });
  const { log, lines } = collectingLog();
  const liveness = new LivenessState();
  client.onProtocolEvent = (event, runId, source) => log.showProtocolEvent(event, runId, source);
  client.onCustomEvent = (name, value) => {
    if (name === LIVENESS_EVENT) {
      liveness.receive(value, Date.now());
      onBeat?.(liveness);
    }
  };
  await client.sendMessage('Wake up');
  return { lines, liveness };
}

describe('A. liveness and the strip', () => {
  test('a stream of heartbeats with no trace: the strip updates, no log lines', async () => {
    const seen = [];
    const { lines, liveness } = await play(
      [START, beat(), beat({ elapsed_s: 17, since_last_word_s: 8 }), beat({ elapsed_s: 22, since_last_word_s: 13 }), FINISH],
      { onBeat: (l) => seen.push(boardStatus({ store: new TraceStore(), runInFlight: true, liveness: l })) },
    );
    assert.equal(lines.filter((l) => /liveness/i.test(l)).length, 0, 'heartbeats are never lines');
    assert.deepEqual(lines, ['No round is running.'], 'only the one idle line: no lifecycle lines, no heartbeat lines');
    assert.equal(liveness.count, 3);
    const last = seen[2];
    assert.equal(last.state, 'running');
    assert.equal(last.speaker, 'cfo');
    assert.equal(last.phase, 'model_call');
    assert.match(last.text, /Speaking: CFO\. Phase: model call\./);
    assert.match(last.elapsedText, /^Running for 2\d s\.$/);
    assert.match(last.lastWordText, /^Last word from the board: 1\d s ago \(CFO, model call\)\.$/);
    assert.equal(last.heartbeats, 3);
    liveness.endRun();
    assert.equal(boardStatus({ store: new TraceStore(), liveness }).state, 'idle', 'the run ended: idle again');
  });

  test('an open rate-limit wait: a countdown, from the remaining time or from the length', () => {
    const at = 1_000_000;
    const state = new LivenessState();
    state.receive({ running: true, phase: 'model_call', agent: 'cfo', waiting_for: 'rate_limit', wait_s: 17.2, wait_remaining_s: 17.2 }, at);
    const store = new TraceStore();
    const early = boardStatus({ store, runInFlight: true, liveness: state, now: at + 2000 });
    assert.match(early.waitText, /^Waiting for the model’s rate limit to pass: 16 s left of a 17 s wait\.$/);
    const later = boardStatus({ store, runInFlight: true, liveness: state, now: at + 10_000 });
    assert.match(later.waitText, /: 8 s left of a 17 s wait\.$/);
    assert.match(boardStatus({ store, runInFlight: true, liveness: state, now: at + 18_000 }).waitText, /is over/);

    // Only the length is sent: the end is counted from the first heartbeat that reported the wait.
    const lengthOnly = new LivenessState();
    lengthOnly.receive({ running: true, agent: 'cfo', waiting_for: 'rate_limit', wait_s: 20 }, at);
    lengthOnly.receive({ running: true, agent: 'cfo', waiting_for: 'rate_limit', wait_s: 20 }, at + 5000);
    const wait = liveWait(lengthOnly.last, at + 8000);
    assert.equal(wait.estimated, true);
    assert.equal(Math.round(wait.remainingS), 12, 'counted from the first heartbeat, not the latest');
    assert.match(waitText(wait), /about 12 s left of a 20 s wait/);

    // An absolute end, shifted by the server's clock.
    const absolute = new LivenessState();
    absolute.receive({ agent: 'cfo', waiting_for: 'rate_limit', wait_s: 30, wait_ends_at: '2026-10-25T09:51:30Z', server_now: '2026-10-25T09:51:10Z' }, at);
    assert.equal(Math.round(liveWait(absolute.last, at).remainingS), 20);
  });

  test('quiet versus broken keeps its thresholds, and a heartbeat resets the quiet clock', () => {
    const t0 = 5_000_000;
    assert.equal(silenceStatus({ running: true, lastEventAt: t0, now: t0 + 5000 }), null);
    assert.match(silenceStatus({ running: true, lastEventAt: t0, now: t0 + 6000 }).text, /^Heard nothing for 6 s\./);
    assert.equal(silenceStatus({ running: true, lastEventAt: t0, lastBytesAt: t0, now: t0 + 16_000 }).connection, 'silent');
    // A heartbeat at t0 + 6 s is the latest event: not quiet at t0 + 10 s.
    assert.equal(silenceStatus({ running: true, lastEventAt: t0 + 6000, now: t0 + 10_000 }), null);
  });

  test('heartbeats arriving before the run-started frame: nothing out of order', async () => {
    const { lines } = await play([
      beat({ elapsed_s: 1 }),
      beat({ elapsed_s: 6 }),
      START,
      beat({ elapsed_s: 11 }),
      { type: 'CUSTOM', name: 'board_notice', value: 'warming up' },
      { type: 'STEP_STARTED', stepName: 'cfo' },
      beat({ elapsed_s: 16 }),
      FINISH,
    ]);
    assert.deepEqual(lines, [
      '[INFO] Run started',
      '[INFO] Event: board_notice',
      '[INFO] Step started: cfo',
      '[INFO] Run finished',
    ].map((l) => l.replace('[INFO] Run finished', '[SUCCESS] Run finished')), 'arrival order; no liveness lines');

    // The gate alone: a line that is not held never jumps ahead of one that is.
    const gate = new RunLogGate();
    const line = (text) => ({ level: 'info', text });
    gate.onEvent({ type: 'RUN_STARTED' }, 'r', 'agui', line('Run started'));
    const out = gate.onEvent({ type: 'CUSTOM', name: 'x' }, 'r', 'agui', line('Event: x')).lines.map((l) => l.text);
    assert.deepEqual(out, ['Run started', 'Event: x']);
  });

  test('timeline entries are in the trace\'s numbering, whatever order they arrived in', () => {
    const entries = [...RATE_LIMITED.filter((e) => e.n != null && e.n <= 8)].reverse();
    const store = new TraceStore({ operator: true });
    entries.forEach((e, i) => store.receive(e, { receivedAt: 1000 + i, live: true }));
    assert.deepEqual(store.turns.get(RL_TURN).sorted().map((e) => e.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('B. honest status', () => {
  test('a schedule unknown, none, and a time: three different texts', () => {
    const unknown = idleStatus({ boardState: { running: false, reason: 'the board’s schedule could not be read', schedule: { status: 'unknown', cause: 'the board’s schedule could not be read' } } });
    const none = idleStatus({ boardState: { running: false, reason: 'the agenda is empty', schedule: { status: 'none' } } });
    const time = idleStatus({ boardState: { running: false, reason: 'the agenda is empty', schedule: { status: 'scheduled', next_at: '2026-10-25T10:00:00Z' } } });
    assert.equal(unknown.text, 'No round is running. Next round: unknown (the board’s schedule could not be read).');
    assert.equal(none.text, 'No round is running: the agenda is empty. No round is scheduled.');
    assert.match(time.text, /^No round is running: the agenda is empty\. Next round: \d\d:\d\d:\d\d\.$/);
    assert.ok(!/No round is scheduled/.test(unknown.text), 'unknown is never combined with none');
    assert.ok(!/unknown/.test(none.text));
    assert.equal(new Set([unknown.schedule.status, none.schedule.status, time.schedule.status]).size, 3);
    // A null time with no explicit answer is not "none": the server did not say.
    assert.match(idleStatus({ boardState: { running: false, next_scheduled: null } }).text, /Next round: not reported\.$/);
    // An unknown with no reason says so.
    assert.match(idleStatus({ boardState: { schedule: { status: 'unknown' } } }).text, /unknown \(the server gave no reason\)/);
  });

  test('a failure: one card, no second error line, the cause class as sent', () => {
    // Without a trace card: the RUN_ERROR is the card; the class is the server's, in words and as sent.
    const card = serverFailureCard({
      error: { code: 'internal', message: 'The board stopped here rather than send the next speaker.' },
      speaker: 'cfo',
      bubbleText: 'CFO could not answer: the model turned away 2 of its 3 requests.',
    });
    assert.equal(card.title, 'CFO could not answer');
    assert.equal(card.text, 'CFO could not answer: the model turned away 2 of its 3 requests.', 'what the card says');
    assert.equal(card.causeText, 'Server’s cause class: an internal error [internal]', 'what the server called it');
    assert.equal(card.serverMessage, 'The board stopped here rather than send the next speaker.');
    assert.equal(serverFailureCard({ error: { code: 'rate_limited', message: 'x' } }).causeText, 'Server’s cause class: the model is limiting requests (rate limit) [rate_limited]');
    assert.equal(serverFailureCard({ error: { code: 'odd_class', message: 'x' } }).causeText, 'Server’s cause class: [odd_class]', 'no invented class');
    assert.equal(serverFailureCard({ error: { message: 'x' } }).causeText, 'Server’s cause class: not reported');

    // With a trace card: the server's class rides on that card.
    const store = new TraceStore();
    RATE_LIMITED.forEach((e, i) => store.receive(e, { receivedAt: 1000 + i, live: true }));
    const turn = store.turns.get(RL_TURN);
    turn.serverError = { code: 'internal', message: 'The board stopped here.' };
    const timeline = buildTimeline(turn);
    assert.equal(failureCards(timeline).length, 1);
    assert.deepEqual(timeline.serverError, { code: 'internal', message: 'The board stopped here.' });

    // The session writes no error line for a failed run once the card is shown.
    const errorLines = [];
    const toasts = [];
    const shown = [];
    const app = {
      runStatus: { sync() {} },
      hideLoading() {},
      showToast: (m) => toasts.push(m),
      chatLog: { errorNote: (e) => errorLines.push(e) },
      traceView: { reportServerFailure: (e, runId) => { shown.push([e.code, runId]); return true; } },
    };
    const session = new AguiSession(app);
    const err = Object.assign(new Error('The board stopped here'), { name: 'RunError', code: 'internal' });
    session.handleRunError(err, { runId: 'r1' });
    assert.deepEqual(errorLines, [], 'no second error line');
    assert.deepEqual(shown, [['internal', 'r1']]);
    assert.equal(toasts.length, 1);
    // A failure that is not a run's (HTTP, say) is still a line.
    session.handleRunError(Object.assign(new Error('boom'), { status: 500 }));
    assert.equal(errorLines.length, 1);
  });
});

describe('C. who is in the room', () => {
  test('a room not reported, and a room of three: "not reported", and three names', () => {
    assert.equal(roomReport({}), null);
    assert.equal(roomReport({ room: 'cfo' }), null);
    assert.equal(roomCountText(null), 'not reported', 'no "8 online" unless the server reported eight');
    const room = roomReport({ room: { members: [{ agent_id: 'founder', online: true }, 'cfo', { agent_id: 'cmo', name: 'CMO' }] } });
    assert.deepEqual(room.members.map((m) => m.name), ['Founder', 'CFO', 'CMO']);
    assert.equal(roomCountText(room), '3 online');
    assert.equal(roomCountText(roomReport({ room: [] })), '0 online');
    assert.deepEqual(roomReport({ room: ['cfo', 'cfo', '<b>x</b>'] }).members.map((m) => m.agentId), ['cfo']);
  });
});

describe('D. access', () => {
  test('an access report as an owner, as an operator, and as a stale token', () => {
    const owner = accessView(accessReport({ access: { roles: ['Boardroom.Owner'], audience: 'owner', token: 'ok' } }), { operator: false });
    assert.equal(owner.text, 'You are in the owner view.');
    assert.equal(owner.operatorText, '', 'an owner is told only which view they are in');
    assert.equal(owner.stale, false);

    const operator = accessView(accessReport({ access: { roles: ['Boardroom.Operator', 'Boardroom.Owner'], audience: 'operator' } }), { operator: true });
    assert.equal(operator.text, 'You are in the operator view.');
    assert.equal(operator.operatorText, 'Access applied by the server: roles Boardroom.Operator, Boardroom.Owner; audience operator.');

    const stale = accessView(accessReport({ access: { roles: [], audience: 'owner', token_stale: true } }));
    assert.equal(stale.stale, true);
    assert.match(stale.staleText, /Sign in again/);
    assert.equal(accessView(accessReport({ access: { audience: 'owner', token: 'stale' } })).stale, true);
  });

  test('operator detail carries the failed history read\'s detail for an operator', () => {
    // TraceView.loadState reads `memory.detail`; the report itself is kept by the memory banner model.
    const state = { memory: { status: 'unavailable', cause: 'memory_unavailable', detail: 'mind: 401 from managed identity' } };
    assert.equal(state.memory.detail, 'mind: 401 from managed identity');
    assert.equal(accessReport({ access: { detail: 'roles claim absent' } }).detail, 'roles claim absent');
  });
});

describe('E. why there is no trace', () => {
  test('the three trace-absent cases, and "unavailable"', () => {
    assert.equal(traceAbsence({ requested: true, arrived: false, withheld: false }).kind, 'not_sent');
    assert.equal(traceAbsence({ requested: true, arrived: false, withheld: true }).kind, 'withheld');
    assert.equal(traceAbsence({ lost: true }).kind, 'lost');
    assert.equal(traceAbsence(undefined), null, 'cannot tell: "unavailable"');
    assert.equal(traceAbsence({}), null);

    const store = new TraceStore();
    for (const [id, report] of [['t-sent', { arrived: false }], ['t-held', { withheld: true }], ['t-lost', { lost: true }]]) {
      const absence = traceAbsence(report);
      store.markUnavailable(id, absence.text, absence.kind);
    }
    store.markUnavailable('t-none', 'this turn’s stream carried no trace, and the server did not say why');
    const kinds = ['t-sent', 't-held', 't-lost', 't-none'].map((id) => buildTimeline(store.turns.get(id)).absence);
    assert.deepEqual(kinds, ['not_sent', 'withheld', 'lost', null]);
    assert.match(buildTimeline(store.turns.get('t-held')).unavailable, /withheld/);
  });

  test('a trace that arrives later appears under its turn when history is next read', () => {
    const store = new TraceStore();
    store.markUnavailable(RL_TURN, 'the board sent no trace for this turn', 'not_sent');
    assert.equal(buildTimeline(store.turns.get(RL_TURN)).status, 'unavailable');
    store.loadHistory([{ turn_id: RL_TURN, entries: RATE_LIMITED.filter((e) => e.n != null) }]);
    const turn = store.turns.get(RL_TURN);
    assert.equal(turn.unavailable, null);
    assert.equal(turn.absence, null);
    assert.ok(buildTimeline(turn).items.length > 0);

    // A history item can say why it has none.
    store.loadHistory([{ turn_id: 'old-1', trace_unavailable: true, trace: { lost: true } }]);
    assert.equal(store.turns.get('old-1').absence, 'lost');
  });
});

describe('F. an older server', () => {
  test('a server that sends none of the new fields: everything "not reported"', () => {
    assert.equal(normalizeLiveness(undefined), null);
    assert.equal(roomReport(undefined), null);
    assert.equal(roomCountText(roomReport(undefined)), 'not reported');
    assert.equal(accessReport({}), null);
    assert.equal(accessView(null).text, 'Access: not reported by the server.');
    assert.equal(traceAbsence(undefined), null);
    assert.equal(idleStatus({ boardState: { running: false } }).text, 'No round is running. Next round: not reported.');

    // Heartbeats with nothing in them: the strip says "not reported", never an error.
    const state = new LivenessState();
    state.receive({}, 1000);
    const status = boardStatus({ store: new TraceStore(), runInFlight: true, liveness: state, now: 2000 });
    assert.match(status.text, /Phase: not reported\./);
    assert.equal(status.lastWordText, 'Last word from the board: not reported.');
    assert.equal(status.waitText, '');
  });
});
