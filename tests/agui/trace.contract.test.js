/**
 * The board's work on the page (ASISaga/boardroom.asisaga.com#75, visible
 * board step 4 of 4). Turn traces in the `boardroom.trace.v1` shape fixed by
 * boardroom-orchestration step 1 (fixtures/boardroom-trace.json holds step
 * 1's own whole-turn example) are checked through the client and the
 * DOM-free models behind the status strip, the turn timeline, the failure
 * card, the memory banner and the log panel. One test per check of the
 * issue's requirement 20, plus robustness.
 *
 * Run: npm run test:agui
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CopilotKitClient } from '../../assets/js/copilotkit-client.js';
import {
  TraceStore,
  buildTimeline,
  failureCards,
  repeatsFailure,
  repeatsRouting,
  contextSize,
  traceText,
  traceEntryOf,
  TRACE_EVENT,
} from '../../assets/js/boardroom-app/trace-model.js';
import {
  boardStatus,
  idleStatus,
  liveWait,
  waitText,
  silenceStatus,
  RunLogGate,
  QUIET_AFTER_MS,
  BROKEN_AFTER_MS,
} from '../../assets/js/boardroom-app/board-status-model.js';
import {
  memoryBanner,
  historyEmpty,
  autoRetryDelay,
  pageRetryText,
  PAGE_RETRY_MS,
} from '../../assets/js/boardroom-app/memory-banner-model.js';
import {
  ClientLogBuffer,
  isClientLibrarySource,
  CLIENT_LOG_STORAGE_KEY,
} from '../../assets/js/boardroom-app/client-log-model.js';

const TRACES = JSON.parse(
  readFileSync(new URL('./fixtures/boardroom-trace.json', import.meta.url), 'utf8'),
);
const RATE_LIMITED = TRACES.rate_limited_turn;
const TWO_SPEAKERS = TRACES.two_speaker_turn;
const RL_TURN = RATE_LIMITED[0].turn_id;
const TWO_TURN = TWO_SPEAKERS[0].turn_id;
const CAUSES = ['rate_limited', 'budget_exhausted', 'timed_out', 'memory_unavailable',
  'memory_conflict', 'refused', 'invalid_reply', 'internal'];

/** Feed entries into a store as a live stream, one second apart unless given. */
function live(entries, { operator, start = 1_000_000, step = 1000 } = {}) {
  const store = new TraceStore({ operator });
  entries.forEach((raw, i) => store.receive(raw, { receivedAt: start + i * step, live: true }));
  return store;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('client: trace frames are the board\'s work, not speech', () => {
  function serve(events) {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      const filled = JSON.parse(JSON.stringify(events)
        .replaceAll('{{threadId}}', body.threadId).replaceAll('{{runId}}', body.runId));
      const text = filled.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    return requests;
  }

  test('CUSTOM boardroom_trace and bare schema frames reach onTraceEntry only', async () => {
    const [opened, routingStarted] = RATE_LIMITED;
    const requests = serve([
      { type: 'RUN_STARTED', threadId: '{{threadId}}', runId: '{{runId}}' },
      opened,
      { type: 'CUSTOM', name: TRACE_EVENT, value: routingStarted },
      { type: 'TEXT_MESSAGE_START', messageId: `${RL_TURN}:cfo`, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: `${RL_TURN}:cfo`, delta: 'Hello' },
      { type: 'TEXT_MESSAGE_END', messageId: `${RL_TURN}:cfo` },
      { type: 'RUN_FINISHED', threadId: '{{threadId}}', runId: '{{runId}}' },
    ]);
    const client = new CopilotKitClient({ runtimeUrl: '/ag-ui', threadId: 'boardroom:acme' });
    const traces = [];
    const customs = [];
    let activity = 0;
    let content = '';
    client.onTraceEntry = (raw, runId, source) => traces.push({ raw, runId, source });
    client.onCustomEvent = (name) => customs.push(name);
    client.onActivity = () => { activity += 1; };
    client.onMessageEnd = (id, c) => { content = c; };
    await client.sendMessage('Hi');

    assert.deepEqual(traces.map((t) => t.raw.n), [1, 2]);
    assert.equal(traces[0].runId, requests[0].body.runId);
    assert.deepEqual(customs, [], 'a trace entry is never a custom event');
    assert.equal(content, 'Hello', 'speech is unchanged; no trace text in it');
    assert.ok(activity >= 1, 'stream bytes are reported as activity');
    // The page never asks for an audience itself: the server decides.
    const headers = Object.keys(requests[0].init.headers || {}).map((h) => h.toLowerCase());
    assert.ok(!headers.includes('x-boardroom-trace'));
  });

  test('a trace hook that throws never breaks the turn', async () => {
    serve([
      { type: 'RUN_STARTED', threadId: '{{threadId}}', runId: '{{runId}}' },
      RATE_LIMITED[0],
      { type: 'RUN_FINISHED', threadId: '{{threadId}}', runId: '{{runId}}' },
    ]);
    const client = new CopilotKitClient({ runtimeUrl: '/ag-ui', threadId: 'boardroom:acme' });
    const errors = [];
    let finished = false;
    client.onTraceEntry = () => { throw new Error('page bug'); };
    client.onError = (e) => errors.push(e);
    client.onRunFinished = () => { finished = true; };
    await client.sendMessage('Hi');
    assert.equal(finished, true);
    assert.deepEqual(errors, []);
  });

  test('traceEntryOf tells a trace frame from an Evt frame', () => {
    assert.equal(traceEntryOf({ type: 'RUN_STARTED' }), undefined);
    assert.equal(traceEntryOf({ type: 'CUSTOM', name: 'resolution', value: {} }), undefined);
    assert.equal(traceEntryOf(RATE_LIMITED[0]), RATE_LIMITED[0]);
    assert.equal(traceEntryOf({ type: 'CUSTOM', name: TRACE_EVENT, value: RATE_LIMITED[1] }), RATE_LIMITED[1]);
  });
});

describe('requirement 20', () => {
  test('a two-speaker turn: phases in order, with durations and a summary', () => {
    const store = live(TWO_SPEAKERS, { operator: true });
    const timeline = buildTimeline(store.turns.get(TWO_TURN), { operator: true });
    assert.equal(timeline.status, 'closed');
    assert.equal(timeline.opened.agendaItem, 'item.7');
    assert.deepEqual(timeline.items.map((i) => i.kind + (i.agent ? `:${i.agent}` : '')),
      ['routing', 'speaker:cfo', 'routing', 'speaker:cmo']);
    const [, cfo, , cmo] = timeline.items;
    assert.deepEqual(cfo.rows.map((r) => r.phase), ['memory_read', 'context_built', 'model_call', 'write_back']);
    assert.deepEqual(cfo.rows.map((r) => r.durationS), [0.4, 0.1, 4.0, 0.2]);
    assert.ok(cfo.rows.every((r) => r.startedAt != null && r.state === 'finished'));
    assert.equal(cfo.state, 'spoke');
    assert.equal(cfo.durationS, 4.8);
    assert.deepEqual(cmo.rows.map((r) => [r.phase, r.state, r.notReported]),
      [['memory_read', 'skipped', true], ['model_call', 'finished', false]]);
    assert.equal(timeline.summary.text,
      'Ended: the chair closed the discussion. Spoke: CFO, CMO. Model calls: 3. Waiting: 0 s. Total: 10 s.');

    // Owner session: the same order, owner lines only.
    const owner = buildTimeline(live(TWO_SPEAKERS, { operator: false }).turns.get(TWO_TURN), { operator: false });
    assert.deepEqual(owner.items.map((i) => i.kind), ['routing', 'speaker', 'routing', 'speaker']);
    assert.ok(owner.items.filter((i) => i.kind === 'speaker').every((i) => i.rows.length === 0));
    assert.equal(owner.summary.text, timeline.summary.text);
  });

  test('a running phase is shown running; prompt size is visible to operators', () => {
    const store = live(TWO_SPEAKERS.slice(0, 6), { operator: true });
    const timeline = buildTimeline(store.turns.get(TWO_TURN), { operator: true });
    assert.equal(timeline.status, 'running');
    const cfo = timeline.items.find((i) => i.kind === 'speaker');
    assert.equal(cfo.rows.at(-1).phase, 'model_call');
    assert.equal(cfo.rows.at(-1).running, true);
    assert.equal(cfo.state, 'running');
    const size = contextSize(cfo.rows.find((r) => r.phase === 'context_built').details);
    assert.equal(size.text, 'Prompt: 18000 characters, about 4500 tokens of a 8000-token budget. '
      + 'Included: commitments 6 of 9. Sections: charter 2400 characters, memory 9100 characters.');
  });

  test('a rate-limit wait: a countdown that ends when the wait ends', () => {
    // The first heartbeat of the CFO's first wait (wait_remaining_s 0.199 s, scaled).
    const upToWait = RATE_LIMITED.slice(0, RATE_LIMITED.findIndex((e) => e.details?.waiting_for === 'rate_limit') + 1);
    const t0 = 5_000_000;
    const store = live(upToWait, { operator: false, start: t0 - upToWait.length * 10, step: 10 });
    const turn = store.turns.get(RL_TURN);
    const hb = turn.heartbeat;
    assert.equal(hb.entry.details.waiting_for, 'rate_limit');
    const arrived = hb.receivedAt;

    const during = liveWait(hb, arrived + 100);
    assert.equal(during.over, false);
    assert.ok(Math.abs(during.remainingS - 0.099) < 1e-9);
    assert.match(waitText(during), /^Waiting for the model’s rate limit to pass: 1 s left of a 0\.3 s wait\.$/);
    const strip = boardStatus({ store, runInFlight: true, now: arrived + 100 });
    assert.equal(strip.state, 'running');
    assert.equal(strip.speaker, 'cfo');
    assert.match(strip.text, /Speaking: CFO\. Phase: model call\./);
    assert.equal(strip.waitText, waitText(during));

    const after = liveWait(hb, arrived + 200);
    assert.equal(after.over, true);
    assert.equal(after.remainingS, 0);
    assert.match(waitText(after), /rate-limit wait is over/);

    // A numbered entry after the heartbeat ends it: no countdown left.
    const rest = RATE_LIMITED.slice(upToWait.length);
    const next = rest.find((e) => e.n != null && e.n > hb.entry.after && e.audience === 'owner');
    store.receive(next, { receivedAt: arrived + 250 });
    assert.equal(turn.heartbeat, null);
    assert.equal(boardStatus({ store, runInFlight: true, now: arrived + 250 }).wait, null);

    // The total waiting time is in the turn's summary.
    const full = live(RATE_LIMITED, { operator: false });
    assert.match(buildTimeline(full.turns.get(RL_TURN)).summary.text, /Waiting: 0\.6 s\./);
  });

  test('no event for more than 5 s while a run is open: "heard nothing for N s"', () => {
    const t = 10_000_000;
    assert.equal(QUIET_AFTER_MS, 5000);
    assert.equal(silenceStatus({ running: true, lastEventAt: t, now: t + 5000 }), null, 'within the contract');
    assert.equal(silenceStatus({ running: false, lastEventAt: t, now: t + 60000 }), null, 'idle is not silence');

    const quiet = silenceStatus({ running: true, lastEventAt: t, now: t + 7400 });
    assert.equal(quiet.seconds, 7);
    assert.equal(quiet.connection, 'up');
    assert.equal(quiet.text, 'Heard nothing for 7 s. The connection is up; waiting for the board.');

    const keepalive = silenceStatus({ running: true, lastEventAt: t, lastBytesAt: t + 20000, now: t + 21000 });
    assert.equal(keepalive.connection, 'up');
    assert.match(keepalive.text, /^Heard nothing for 21 s\. The connection is up \(keepalives are arriving\)/);

    const broken = silenceStatus({ running: true, lastEventAt: t, now: t + BROKEN_AFTER_MS + 1000 });
    assert.equal(broken.connection, 'silent');
    assert.match(broken.text, /^Heard nothing for 16 s\. .*it may be broken\.$/);

    const offline = silenceStatus({ running: true, lastEventAt: t, online: false, now: t + 6000 });
    assert.equal(offline.connection, 'offline');
    assert.match(offline.text, /connection is down/);
  });

  test('routing: its own line, and no chair message when the chair has no speech', () => {
    const store = live(RATE_LIMITED, { operator: false });
    const timeline = buildTimeline(store.turns.get(RL_TURN), { operator: false });
    const routing = timeline.items.filter((i) => i.kind === 'routing');
    assert.equal(routing.length, 1);
    assert.equal(routing[0].text, 'The chair passed it to the CFO: Deliberation has just started');
    assert.ok(!timeline.items.some((i) => i.kind === 'speaker' && i.agent === 'founder'),
      'the chair is not a speaker in the timeline');
    // An older backend that still speaks the routing reason: that bubble is hidden.
    assert.equal(repeatsRouting('Deliberation has just started', routing[0].row), true);
    assert.equal(repeatsRouting('Our costs rose 4%.', routing[0].row), false);

    // While the chair is choosing, the line says so and the strip names the phase.
    const choosing = live(RATE_LIMITED.slice(0, 3), { operator: false });
    const line = buildTimeline(choosing.turns.get(RL_TURN)).items[0];
    assert.equal(line.text, 'The chair is choosing who speaks next.');
    const strip = boardStatus({ store: choosing, runInFlight: true });
    assert.equal(strip.phase, 'routing');
    assert.match(strip.text, /Speaking: Founder\. Phase: routing/);
  });

  test('a failure: owner wording once; operator detail on demand only for an operator session', () => {
    const ownerTimeline = buildTimeline(live(RATE_LIMITED, { operator: false }).turns.get(RL_TURN), { operator: false });
    const ownerCards = failureCards(ownerTimeline);
    assert.equal(ownerCards.length, 1, 'shown once');
    const [card] = ownerCards;
    assert.equal(card.agent, 'cfo');
    assert.equal(card.cause, 'budget_exhausted');
    assert.equal(card.next, 'stop');
    assert.ok(card.text.startsWith('The CFO could not answer: the model turned away 3 of its 3 request(s)'));
    assert.match(card.text, /The board stopped here/);
    assert.equal(card.detail, null, 'no technical detail for an owner');
    // The CFO's speech repeats the card's first sentence: the bubble is hidden, the card stays.
    const speech = 'The CFO could not answer: the model turned away 3 of its 3 request(s) under its rate limit, it waited 2 time(s), 1 s in all, and its time for this turn ran out.';
    assert.equal(repeatsFailure(speech, card), true);

    const opStore = live(RATE_LIMITED, { operator: true });
    const opCards = failureCards(buildTimeline(opStore.turns.get(RL_TURN), { operator: true }));
    assert.equal(opCards.length, 1, 'owner and operator outcomes make one card');
    assert.equal(opCards[0].text, card.text);
    assert.deepEqual(
      { ...opCards[0].detail, summary: undefined },
      { modelRequests: 3, rateLimited: 3, waits: 2, waitS: 0.601, waitsS: [0.3, 0.301], elapsedS: 0.601,
        budgetS: 60, errorType: 'RateLimitError', summary: undefined },
    );
    // An operator who switches the operator view off sees the owner card.
    const plain = failureCards(buildTimeline(opStore.turns.get(RL_TURN), { operator: true, operatorView: false }));
    assert.equal(plain[0].detail, null);
  });

  test('an owner session: operator entries neither received nor shown', () => {
    const store = live(RATE_LIMITED, { operator: false });
    const turn = store.turns.get(RL_TURN);
    const operatorCount = RATE_LIMITED.filter((e) => e.audience === 'operator').length;
    assert.equal(store.droppedOperator, operatorCount);
    assert.ok([...turn.entries.values()].every((e) => e.audience === 'owner'));
    const timeline = buildTimeline(turn, { operator: false });
    const rows = timeline.items.flatMap((i) => i.rows || (i.row ? [i.row] : []));
    assert.ok(rows.every((r) => r.audience === 'owner'));
    assert.ok(!timeline.items.some((i) => i.kind === 'missing'), 'owner gaps are expected, not lost entries');
    assert.equal(traceText(turn, { operator: false }), null, 'no copy for an owner');
    // Even when told it may see them, a page that was an owner keeps none.
    const was = live(RATE_LIMITED, { operator: true });
    was.setOperator(false);
    assert.ok([...was.turns.get(RL_TURN).entries.values()].every((e) => e.audience === 'owner'));
  });

  test('an idle run: one idle line, no started/finished pair', () => {
    const gate = new RunLogGate();
    const line = (text) => ({ level: 'info', text });
    const out = [];
    let idle = 0;
    for (const [event, l] of [
      [{ type: 'RUN_STARTED' }, line('Run started')],
      [{ type: 'STATE_SNAPSHOT' }, line('State snapshot received')],
      [{ type: 'RUN_FINISHED' }, line('Run finished')],
    ]) {
      const r = gate.onEvent(event, 'run-1', 'agui', l);
      out.push(...r.lines);
      if (r.idle) idle += 1;
    }
    assert.deepEqual(out, [], 'no "Run started" / "Run finished" for a run without deliberation');
    assert.equal(idle, 1, 'one idle line instead');

    // A page load (hydrate) is the same.
    const hydrate = new RunLogGate();
    assert.deepEqual(hydrate.onEvent({ type: 'RUN_STARTED' }, 'h', 'hydrate', line('Run started')).lines, []);
    assert.equal(hydrate.onEvent({ type: 'RUN_FINISHED' }, 'h', 'hydrate', line('Run finished')).idle, true);

    // A run with deliberation keeps its lines, in order.
    const real = new RunLogGate();
    assert.deepEqual(real.onEvent({ type: 'RUN_STARTED' }, 'r', 'agui', line('Run started')).lines, []);
    assert.deepEqual(real.onEvent({ type: 'STEP_STARTED' }, 'r', 'agui', line('Step started')).lines.map((l) => l.text),
      ['Run started', 'Step started']);
    const end = real.onEvent({ type: 'RUN_FINISHED' }, 'r', 'agui', line('Run finished'));
    assert.deepEqual([end.lines.map((l) => l.text), end.idle], [['Run finished'], false]);

    // The idle entry says why and when the next round is due.
    const store = new TraceStore({ operator: false });
    store.receive(TRACES.idle_entry);
    const turn = store.turns.get(TRACES.idle_entry.turn_id);
    assert.equal(turn.idleOnly, true);
    const timeline = buildTimeline(turn);
    assert.equal(timeline.status, 'idle');
    assert.deepEqual(timeline.items.map((i) => i.kind), ['idle']);
    assert.match(idleStatus({ store }).text, /^No round is running: the agenda is empty\. Next round: /);
    assert.equal(idleStatus({}).text, 'No round is running. Next round: not reported.');
    assert.equal(boardStatus({ store, runInFlight: false }).state, 'idle');
  });

  test('a reload: the same timeline as live', () => {
    for (const operator of [false, true]) {
      for (const entries of [RATE_LIMITED, TWO_SPEAKERS]) {
        const turnId = entries[0].turn_id;
        const liveStore = live(entries, { operator });
        // What is stored: numbered entries for this audience (heartbeats never are).
        const stored = entries.filter((e) => e.live !== true && (operator || e.audience === 'owner'));
        const reloaded = new TraceStore({ operator });
        assert.deepEqual(reloaded.loadHistory([{ turn_id: turnId, entries: stored }]), [turnId]);
        const strip = (t) => JSON.parse(JSON.stringify({ ...t, heartbeat: null }));
        assert.deepEqual(
          strip(buildTimeline(reloaded.turns.get(turnId), { operator })),
          strip(buildTimeline(liveStore.turns.get(turnId), { operator })),
          `${operator ? 'operator' : 'owner'} ${turnId}`,
        );
      }
    }
  });

  test('the banner: each cause, retry state, and clearing', () => {
    const now = Date.parse('2026-10-24T01:29:00Z');
    for (const cause of CAUSES) {
      const banner = memoryBanner({ memory: { status: 'unavailable', cause, affects: ['history', 'grounding'], retrying: false } }, now);
      assert.equal(banner.cause, cause);
      assert.ok(banner.causeText.includes(`[${cause}]`), cause);
      assert.match(banner.causeText, /^History could not be read: /);
      assert.equal(banner.retryText, 'No retry is under way.');
    }
    const history = memoryBanner({ memory: { status: 'unavailable', cause: 'timed_out', affects: ['history'] } }, now);
    assert.match(history.affectsText, /^Affected: history .* Grounding is on\.$/);
    const grounding = memoryBanner({ memory: { status: 'unavailable', cause: 'timed_out', affects: ['grounding'] } }, now);
    assert.match(grounding.affectsText, /^Affected: grounding .* History loaded\.$/);

    const retrying = memoryBanner({ memory: {
      status: 'unavailable', cause: 'memory_unavailable', affects: ['history', 'grounding'],
      retrying: true, next_retry_at: '2026-10-24T01:29:30Z',
    } }, now);
    assert.match(retrying.retryText, /^A retry is under way: next at .* \(in 30 s\)\.$/);
    assert.equal(autoRetryDelay(retrying, now), 31000, 'the page re-reads just after the server retries');
    assert.equal(pageRetryText(retrying, now + 1000, now), '');

    // An older backend: live_only only. The banner says what it can, and the page retries itself.
    const legacy = memoryBanner({ live_only: true, live_only_reason: 'mind_unreachable' }, now);
    assert.equal(legacy.cause, 'memory_unavailable');
    assert.match(legacy.causeText, /reported as “mind_unreachable”/);
    assert.match(legacy.affectsText, /not reported/);
    assert.equal(legacy.retryText, 'Retry: not reported.');
    assert.equal(autoRetryDelay(legacy, now), PAGE_RETRY_MS);
    assert.match(pageRetryText(legacy, now + PAGE_RETRY_MS, now), /^The page reads history again at .* \(in 60 s\)\.$/);

    // Clearing: the cause cleared, so no banner.
    assert.equal(memoryBanner({ memory: { status: 'ok' } }, now), null);
    assert.equal(memoryBanner({ live_only: false }, now), null);
    assert.equal(autoRetryDelay(null, now), null);
    // "No history yet" is not a failure, and reads differently.
    assert.equal(memoryBanner({ memory: { status: 'empty' } }, now), null);
    assert.equal(historyEmpty({ memory: { status: 'empty' } }), true);
    assert.equal(historyEmpty({ memory: { status: 'unavailable', cause: 'timed_out' } }), false);
  });

  test('the log: MSAL lines hidden by default', () => {
    assert.equal(isClientLibrarySource('MSAL'), true);
    assert.equal(isClientLibrarySource('Boardroom'), false);
    const store = new Map();
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    };
    const log = new ClientLogBuffer({ storage, max: 3 });
    assert.equal(log.visible, false, 'off by default');
    for (let i = 0; i < 5; i += 1) log.add({ source: 'MSAL', level: i % 2 ? 'debug' : 'info', text: `line ${i}` });
    assert.deepEqual(log.shown(), [], 'nothing is shown while off');
    assert.equal(log.entries.length, 3, 'bounded');
    log.setVisible(true);
    assert.equal(store.get(CLIENT_LOG_STORAGE_KEY), 'true');
    const infoOnly = log.shown((level) => level !== 'debug');
    assert.deepEqual(infoOnly.map((e) => e.text), ['line 2', 'line 4'], 'the level selector applies');
    assert.equal(new ClientLogBuffer({ storage }).visible, true, 'the choice is remembered');
    const noStorage = new ClientLogBuffer();
    noStorage.setVisible(true);
    assert.equal(noStorage.visible, true, 'works without storage');
  });
});

describe('robustness: a trace the page cannot read does not break the page', () => {
  test('unparseable or missing entries: "trace unavailable" or what exists', () => {
    const store = new TraceStore({ operator: false });
    for (const raw of [null, 'garbage', 42, [], { schema: 'other' },
      { ...RATE_LIMITED[0], n: 'one' }, { ...RATE_LIMITED[0], phase: 'dance' }]) {
      assert.doesNotThrow(() => store.receive(raw));
    }
    assert.ok(store.invalid >= 6);
    const broken = store.turns.get(RL_TURN);
    assert.equal(broken.entries.size, 0);
    assert.equal(broken.invalid, 2);
    assert.doesNotThrow(() => buildTimeline(broken));

    const history = new TraceStore({ operator: false });
    history.loadHistory([
      { turn_id: 't-1', trace_unavailable: true },
      { turn_id: 't-2' },
      { turn_id: 't-3', entries: [] },
      'not a turn',
    ]);
    for (const id of ['t-1', 't-2', 't-3']) {
      const timeline = buildTimeline(history.turns.get(id));
      assert.equal(timeline.status, 'unavailable', id);
      assert.ok(timeline.unavailable, id);
    }
    // A trace that does arrive later replaces "unavailable".
    history.markUnavailable(RL_TURN, 'no trace');
    history.receive(RATE_LIMITED[0]);
    assert.equal(history.turns.get(RL_TURN).unavailable, null);
  });

  test('missing entries are marked on an operator stream, with "not reported" rows', () => {
    const lost = RATE_LIMITED.filter((e) => e.n !== 12);
    const store = live(lost, { operator: true });
    const timeline = buildTimeline(store.turns.get(RL_TURN), { operator: true });
    assert.deepEqual(timeline.items.find((i) => i.kind === 'missing').numbers, [12]);
    const notReported = timeline.items.flatMap((i) => i.rows || (i.row ? [i.row] : [])).filter((r) => r.notReported);
    assert.ok(notReported.length >= 6, 'memory read, context and write-back are "not reported"');
    // A turn whose close never arrived says so once its stream has ended.
    const open = live(TWO_SPEAKERS.slice(0, 9), { operator: true });
    const turn = open.turns.get(TWO_TURN);
    turn.live = false;
    const ended = buildTimeline(turn, { operator: true });
    assert.equal(ended.status, 'incomplete');
    assert.equal(ended.closedMissing, true);
  });

  test('copy trace: plain text with no reason, title or speech', () => {
    const turn = live(TWO_SPEAKERS, { operator: true }).turns.get(TWO_TURN);
    const text = traceText(turn, { operator: true, now: Date.parse('2026-10-24T12:00:00Z') });
    assert.match(text, /^Boardroom turn 0b7c9d1e-.*: trace \(boardroom\.trace\.v1\), copied 2026-10-24T12:00:00\.000Z/);
    assert.equal(text.split('\n').length, TWO_SPEAKERS.length + 1);
    assert.ok(!text.includes('Costs first') && !text.includes('Demand next'), 'no routing reason');
    assert.ok(!text.includes('Pricing review'), 'no agenda title');
    assert.match(text, /#3 .* founder routing finished .*\| founder -> cfo/);
  });
});
