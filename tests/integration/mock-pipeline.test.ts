/**
 * In-process end-to-end MOCK pipeline:
 *   fake capture events → SidekickCoordinator → mock vision → SidekickEngine
 *   → REAL reasoning module (src/reasoning, Prabin) with its deterministic mock provider
 *   → engine recommendation → overlay snapshot.
 * No network, no Python, no Gemini, no Chert. Clock and timers are controlled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type {
  CoordinatorDiagnostic,
  FrameInput,
  ReasoningFn,
  ScreenDescription,
  VisionPort,
} from '../../src/coordinator/ports.js';
import type { OverlayState, Result } from '../../src/contracts/types.js';
import { FakeClock, at } from '../../src/mock/demo-scenario.js';

interface Wiring {
  mockReasoning: ReasoningFn;
  createReasoningFn(provider: unknown): ReasoningFn;
}
const wiringUrl = new URL('../../../tests/integration/reasoning-wiring.mts', import.meta.url).href;
const { mockReasoning, createReasoningFn } = (await import(wiringUrl)) as Wiring;

const ROLE_LINE = 'Alex is responsible for left defense.';

function value<T>(r: Result<T> | { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) assert.fail(`expected ok, got ${'error' in r ? r.error : ''}`);
  return r.value;
}

/** Holds calls until released — to observe in-flight behaviour. */
function gate() {
  let open = true;
  let waiters: Array<() => void> = [];
  return {
    hold() { open = false; },
    release() { open = true; waiters.forEach((w) => w()); waiters = []; },
    wait(): Promise<void> { return open ? Promise.resolve() : new Promise((r) => waiters.push(r)); },
  };
}

class ManualTimers {
  #timers: Array<{ dueMs: number; fn: () => void; live: boolean }> = [];
  created = 0;
  constructor(private readonly clock: FakeClock) {}
  set = (fn: () => void, delayMs: number) => {
    this.created += 1;
    const t = { dueMs: this.clock.now().getTime() + delayMs, fn, live: true };
    this.#timers.push(t);
    return () => { t.live = false; };
  };
  get live(): number { return this.#timers.filter((t) => t.live).length; }
  get dueTimes(): number[] { return this.#timers.filter((t) => t.live).map((t) => t.dueMs); }
  fireDue(): void {
    const now = this.clock.now().getTime();
    for (const t of this.#timers) if (t.live && t.dueMs <= now) { t.live = false; t.fn(); }
  }
}

/** Mock vision: the "image" bytes are a JSON-encoded description (test convenience only). */
function mockVision(g = gate()) {
  let calls = 0;
  const port: VisionPort = {
    async describe(frame: FrameInput, signal: AbortSignal): Promise<ScreenDescription> {
      calls += 1;
      await g.wait();
      if (signal.aborted) throw new Error('aborted');
      return JSON.parse(new TextDecoder().decode(frame.image)) as ScreenDescription;
    },
  };
  return { port, gate: g, get calls() { return calls; } };
}

function setup(options: { reasoningGate?: ReturnType<typeof gate>; reasoning?: ReasoningFn; conditionFactKeys?: string[] } = {}) {
  const clock = new FakeClock();
  const timers = new ManualTimers(clock);
  const diagnostics: CoordinatorDiagnostic[] = [];
  const vision = mockVision();
  const reasoningGate = options.reasoningGate ?? gate();
  let reasoningCalls = 0;
  const base = options.reasoning ?? mockReasoning;
  const reasoning: ReasoningFn = async (request, signal) => {
    reasoningCalls += 1;
    await reasoningGate.wait();
    return base(request, signal);
  };
  let n = 0;
  const coordinator = new SidekickCoordinator({
    reasoning,
    vision: vision.port,
    now: clock.now,
    setTimer: timers.set,
    engine: { newId: () => `id-${++n}` },
    ...(options.conditionFactKeys ? { conditionFactKeys: options.conditionFactKeys } : {}),
    onDiagnostic: (d) => diagnostics.push(d),
  });
  const engine = coordinator.engine;
  const sid = value(coordinator.createSession({ externalRef: 'mock-room' })).id;
  const alex = value(engine.addParticipant(sid, { displayName: 'Alex' }));
  value(coordinator.startWithConsent(sid));
  value(engine.confirmActivity(sid, 'gaming'));
  const overlay: OverlayState[] = [];
  value(engine.subscribe(sid, (s) => overlay.push(s)));

  const generation = () => value(engine.getSession(sid)).captureGeneration;
  const say = (seconds: number, text: string) => {
    clock.set(seconds);
    return value(coordinator.ingestConversation(sid, { captureGeneration: generation(), observedAt: at(seconds), text }));
  };
  /** A frame "captured" now with the current generation (or an explicit one). */
  const captureFrame = (seconds: number, uncovered = true, captureGeneration = generation()): FrameInput => ({
    mediaSource: 'screen_share', captureGeneration,
    observedAt: at(seconds),
    mimeType: 'image/jpeg',
    image: new TextEncoder().encode(JSON.stringify({
      summary: uncovered ? 'Left defensive zone clearly visible and empty.' : 'Left defensive zone covered.',
      evidenceQuality: 'clear',
      facts: { leftZoneVisible: true, leftZoneUncovered: uncovered },
    })),
  });
  const recs = () => value(engine.getSession(sid)).recommendations;
  return {
    clock, timers, diagnostics, vision, reasoningGate, coordinator, engine, sid, alex, overlay,
    generation, say, captureFrame, recs, get reasoningCalls() { return reasoningCalls; },
  };
}

test('happy path: role → visual observation → one card → duplicate suppressed → end', async () => {
  const h = setup();
  const utterance = h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  const alex = value(h.engine.getSession(h.sid)).participants.find((p) => p.id === h.alex.id)!;
  assert.equal(alex.role, 'left defense');
  assert.equal(alex.lastRoleChange?.source, 'transcript');
  assert.equal(alex.lastRoleChange?.sourceObservationId, utterance.id);
  assert.equal(value(h.engine.getSession(h.sid)).contextRevision, 1);

  h.clock.set(8);
  const frame = h.captureFrame(8);
  const screen = value(await h.coordinator.ingestFrame(h.sid, frame));
  assert.equal(screen.captureGeneration, frame.captureGeneration, 'capture-time generation preserved through vision');
  await h.coordinator.whenIdle(h.sid);

  assert.equal(h.recs().length, 1);
  const card = h.recs()[0]!;
  assert.equal(card.status, 'active');
  assert.deepEqual(card.conditionObservationIds, [screen.id]);
  assert.deepEqual(card.contextObservationIds, [utterance.id]);
  assert.deepEqual(card.relatedParticipantIds, [h.alex.id]);
  assert.equal(card.contextAtCreation.contextRevision, 1);
  assert.equal(h.overlay.at(-1)?.prominent?.title, 'Left defense appears exposed');
  assert.equal(h.overlay.at(-1)?.voiceBusy, false, 'quiet text only — no automatic voice');
  assert.deepEqual(value(h.engine.getSession(h.sid)).voiceRequests, []);

  // A second frame of the same situation merges into the same card.
  h.clock.set(10);
  const second = value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(10)));
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 1, 'duplicate suppressed');
  assert.deepEqual(h.recs()[0]!.conditionObservationIds, [screen.id, second.id]);
  assert.ok(h.diagnostics.some((d) => d.type === 'candidate_result' && d.outcome === 'merged'));
  // The role proposal keeps coming back from the same utterance but is applied only once.
  assert.ok(h.diagnostics.some((d) => d.type === 'context_applied' && d.outcome === 'already_applied'));
  assert.equal(value(h.engine.getSession(h.sid)).contextRevision, 1);

  value(h.coordinator.end(h.sid));
  assert.equal((await h.coordinator.ingestFrame(h.sid, h.captureFrame(12))).ok, false);
  const types = value(h.engine.getTimeline(h.sid)).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'role_updated').length, 1);
  assert.equal(types.filter((t) => t === 'recommendation_created').length, 1);
  assert.ok(!types.includes('voice_requested'));
  assert.equal(types.at(-1), 'session_ended');
});

test('pause aborts in-flight reasoning; pre-pause frames cannot create advice after resume', async () => {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  const preGeneration = h.generation();

  h.reasoningGate.hold();
  h.clock.set(8);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(8)));
  value(h.coordinator.pause(h.sid)); // reasoning is still in flight
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 0, 'aborted reasoning produced nothing');
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'aborted'));

  h.clock.set(9);
  value(h.coordinator.resume(h.sid));
  // A frame captured before the pause, delivered after resume:
  const visionCalls = h.vision.calls;
  const late = await h.coordinator.ingestFrame(h.sid, h.captureFrame(8.5, true, preGeneration));
  assert.equal(late.ok, false);
  assert.equal(!late.ok && late.error, 'stale_evidence');
  assert.equal(h.vision.calls, visionCalls, 'stale frame never reaches vision');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 0);

  // Fresh evidence after resume creates a current card.
  h.clock.set(11);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(11)));
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 1);
  assert.equal(h.recs()[0]!.status, 'active');
});

test('vision in flight across pause/resume: generation is not re-read, result is dropped', async () => {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  h.vision.gate.hold();
  h.clock.set(8);
  const pending = h.coordinator.ingestFrame(h.sid, h.captureFrame(8));
  value(h.coordinator.pause(h.sid));
  value(h.coordinator.resume(h.sid));
  h.vision.gate.release();
  const r = await pending;
  assert.equal(!r.ok && r.error, 'aborted');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.listObservations(h.sid, { source: 'screen' })).length, 0, 'nothing stored under the new generation');
  assert.equal(h.recs().length, 0);
});

test('stale context: a correction during reasoning discards the result and re-runs', async () => {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  // Applying the role bumps the revision, so the role phase is itself two calls (run + re-run).
  const afterRolePhase = h.reasoningCalls;

  h.reasoningGate.hold();
  h.clock.set(8);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(8)));
  // While the call (computed against revision 1) is in flight, a participant corrects the role.
  value(h.engine.assignRole(h.sid, h.alex.id, 'right defense', { source: 'manual' }));
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);

  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'context_changed'));
  assert.equal(h.reasoningCalls - afterRolePhase, 2, 'discarded run + one re-run against the new revision');
  const cards = h.recs();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.contextAtCreation.contextRevision, 2, 'advice evaluated against the corrected context');
  assert.deepEqual(cards[0]!.relatedParticipantIds, [], 'no advice addressed to Alex for a role he no longer has');
  assert.ok(!cards[0]!.shortAdvice.includes('Alex'));
  // The old utterance must not override the manual correction.
  const alex = value(h.engine.getSession(h.sid)).participants.find((p) => p.id === h.alex.id)!;
  assert.equal(alex.role, 'right defense');
});

test('a result computed against another revision or session is discarded', async () => {
  const h = setup({
    reasoning: async (request, signal) => {
      const r = await mockReasoning(request, signal);
      return r.ok ? { ok: true, value: { ...r.value, basedOnContextRevision: r.value.basedOnContextRevision + 7 } } : r;
    },
  });
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'result_mismatch'));
  assert.equal(value(h.engine.getSession(h.sid)).contextRevision, 0, 'nothing applied');
});

test('[R3-2] future-stamped evidence is deferred individually; eligible evidence runs now', async () => {
  const h = setup();
  h.clock.set(2);
  // Speech already eligible, frame 2 s ahead (engine admits up to maxClockSkewMs = 5 s).
  h.engine.ingestConversation(h.sid, { captureGeneration: h.generation(), observedAt: at(2), text: ROLE_LINE });
  h.clock.set(10);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(12)));
  await h.coordinator.whenIdle(h.sid);
  assert.ok(h.reasoningCalls >= 1, 'eligible observations are reasoned over without waiting');
  assert.equal(value(h.engine.getSession(h.sid)).participants[0]?.role, 'left defense', 'role applied immediately');
  assert.equal(h.recs().length, 0, 'no advice from evidence reasoning has not seen yet');
  assert.deepEqual(h.timers.dueTimes, [Date.parse(at(12))]);
  assert.ok(!h.diagnostics.some((d) => d.type === 'reasoning_failed'), 'reasoning never received future evidence');
  h.clock.set(12);
  h.timers.fireDue();
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 1, 'delayed evidence processed once eligible');
});

test('[R3-2] continuous clock-skewed frames (1/s, +2 s) still produce reasoning and advice', async () => {
  const h = setup();
  h.clock.set(2);
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  const before = h.reasoningCalls;
  for (let s = 10; s <= 20; s++) {
    h.clock.set(s);
    h.timers.fireDue();
    value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(s + 2)));
    await h.coordinator.whenIdle(h.sid);
    // The pending deadline is the EARLIEST excluded frame; later frames never push it back.
    assert.ok(h.timers.dueTimes.length <= 1);
    if (h.timers.dueTimes.length === 1) assert.ok(h.timers.dueTimes[0]! <= Date.parse(at(s + 2)));
  }
  assert.ok(h.reasoningCalls - before >= 10, `reasoning ran ${h.reasoningCalls - before} times`);
  assert.equal(h.recs().length, 1, 'one card, merged as frames keep arriving');
  assert.ok(h.recs()[0]!.conditionObservationIds.length >= 5);
});

test('[R3-2] a pending deadline is kept, not re-created, by later triggers', async () => {
  const h = setup();
  h.clock.set(10);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(12)));
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.timers.created, 1);
  for (const t of [10.2, 10.4, 10.6]) {
    h.say(t, 'chatter');
    await h.coordinator.whenIdle(h.sid);
  }
  assert.equal(h.timers.created, 1, 'same deadline kept across triggers');
  assert.deepEqual(h.timers.dueTimes, [Date.parse(at(12))]);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(14)));
  await h.coordinator.whenIdle(h.sid);
  assert.deepEqual(h.timers.dueTimes, [Date.parse(at(12))], 'a later future frame never pushes the deadline back');
});

test('ending the session cancels deferred reasoning', async () => {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  h.clock.set(10);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(12)));
  assert.equal(h.timers.live, 1);
  value(h.coordinator.end(h.sid));
  assert.equal(h.timers.live, 0);
  const calls = h.reasoningCalls;
  h.clock.set(13);
  h.timers.fireDue();
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.reasoningCalls, calls);
});

test('context proposals are idempotent against engine state, including retired goals', async () => {
  const h = setup();
  h.say(2, 'Our goal is to keep the left covered.');
  await h.coordinator.whenIdle(h.sid);
  const goals = () => value(h.engine.getSession(h.sid)).goals;
  assert.equal(goals().length, 1);
  h.say(3, 'Nice pass.');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(goals().length, 1, 'same utterance re-proposed, not re-applied');
  value(h.engine.retireGoal(h.sid, goals()[0]!.id, { source: 'manual' }));
  h.say(4, 'Okay.');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(goals().length, 1, 'retired goal is not resurrected from the old utterance');
  assert.equal(goals()[0]!.active, false);
});

test('discard during in-flight reasoning leaves nothing behind', async () => {
  const h = setup();
  h.reasoningGate.hold();
  h.say(2, ROLE_LINE);
  value(h.coordinator.discard(h.sid));
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.engine.getSession(h.sid).ok, false);
  const late = await h.coordinator.ingestFrame(h.sid, h.captureFrame(3, true, 1));
  assert.equal(!late.ok && late.error, 'session_not_found');
});

test('triggers during a run coalesce into a single rerun', async () => {
  const h = setup();
  h.reasoningGate.hold();
  h.say(2, ROLE_LINE);
  h.say(3, 'one');
  h.say(4, 'two');
  h.say(5, 'three');
  assert.equal(h.reasoningCalls, 1);
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  // Run 1 (held) applies the role; the queued triggers and the context-change rerun
  // collapse into exactly one more run.
  assert.equal(h.reasoningCalls, 2);
});

test('reasoning failures are contained and reported as codes', async () => {
  const h = setup({ reasoning: async () => { throw new Error('secret provider detail'); } });
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  const failure = h.diagnostics.find((d) => d.type === 'reasoning_failed');
  assert.deepEqual(failure, { type: 'reasoning_failed', sessionId: h.sid, error: 'provider_threw' });
  assert.ok(!JSON.stringify(h.diagnostics).includes('secret'));
  assert.ok(!JSON.stringify(h.diagnostics).includes('left defense'), 'diagnostics carry no transcript text');
});

test('frame validation: consent, generation, format, and missing vision', async () => {
  const h = setup();
  const other = value(h.coordinator.createSession()).id;
  const r1 = await h.coordinator.ingestFrame(other, h.captureFrame(1, true, 1));
  assert.equal(!r1.ok && r1.error, 'consent_required');
  const r2 = await h.coordinator.ingestFrame(h.sid, h.captureFrame(1, true, 99));
  assert.equal(!r2.ok && r2.error, 'invalid_generation');
  const r3 = await h.coordinator.ingestFrame(h.sid, { ...h.captureFrame(1), mimeType: 'image/gif' as never });
  assert.equal(!r3.ok && r3.error, 'invalid_input');
  const r4 = await h.coordinator.ingestFrame(h.sid, { ...h.captureFrame(1), image: new Uint8Array() });
  assert.equal(!r4.ok && r4.error, 'invalid_input');
  const noVision = new SidekickCoordinator({ reasoning: mockReasoning, now: h.clock.now });
  const sid = value(noVision.createSession()).id;
  value(noVision.startWithConsent(sid));
  const r5 = await noVision.ingestFrame(sid, h.captureFrame(1, true, 1));
  assert.equal(!r5.ok && r5.error, 'vision_unavailable');
});

// ── Fix 1: newer observations invalidate outdated results ──────────────────

async function inFlightWithNewerFrame(newer: (h: ReturnType<typeof setup>) => Promise<unknown>) {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  h.reasoningGate.hold();
  h.clock.set(8);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(8, true))); // reasoning on t=8 starts
  h.clock.set(9);
  await newer(h); // arrives while reasoning is in flight
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  return h;
}

test('[R3-1] newer COVERED frame during in-flight reasoning: obsolete advice is never created (original repro)', async () => {
  const h = await inFlightWithNewerFrame(async (h) => value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(9, false))));
  assert.equal(h.recs().length, 0, 'no obsolete active recommendation');
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'evidence_superseded'));
});

test('[R3-1] newer UNKNOWN-quality frame during in-flight reasoning is treated conservatively', async () => {
  const h = await inFlightWithNewerFrame(async (h) =>
    value(h.coordinator.ingestScreen(h.sid, {
      mediaSource: 'screen_share', captureGeneration: h.generation(), observedAt: at(9), summary: 'Blurred frame.', evidenceQuality: 'unknown',
    })));
  assert.equal(h.recs().length, 0);
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'evidence_superseded'));
});

test('[R3-1] newer AGREEING frame or new speech does not discard a still-valid result', async () => {
  const agreeing = await inFlightWithNewerFrame(async (h) => value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(9, true))));
  assert.equal(agreeing.recs().length, 1);
  assert.ok(!agreeing.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'evidence_superseded'));
  const speech = await inFlightWithNewerFrame(async (h) => h.say(9, 'Nice pass.'));
  assert.equal(speech.recs().length, 1, 'transcripts never supersede condition evidence');
});

test('[R3-1] an existing unrelated card is not invalidated by a superseded result', async () => {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  value(h.coordinator.ingestScreen(h.sid, {
    mediaSource: 'screen_share', captureGeneration: h.generation(), observedAt: at(2), summary: 'other', evidenceQuality: 'clear',
  }));
  await h.coordinator.whenIdle(h.sid);
  const rev = value(h.engine.getSession(h.sid)).contextRevision;
  const other = value(h.engine.listObservations(h.sid, { source: 'screen' }))[0]!;
  value(h.engine.proposeRecommendation(h.sid, {
    fingerprint: 'unrelated_issue', title: 'Something else appears off', shortAdvice: 'Check it.',
    conditionObservationIds: [other.id], urgency: 'normal', basedOnContextRevision: rev,
  }));
  h.reasoningGate.hold();
  h.clock.set(8);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(8, true)));
  h.clock.set(9);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(9, false)));
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  const cards = h.recs();
  assert.deepEqual(cards.map((c) => [c.fingerprint, c.status]), [['unrelated_issue', 'active']]);
});

// ── Fix 3: reentrant lifecycle changes ─────────────────────────────────────

test('[R3-3] a subscriber that resumes during the pause notification keeps reasoning alive (original repro)', async () => {
  const h = setup();
  let resumed = false;
  value(h.engine.subscribe(h.sid, (s) => {
    if (s.status === 'paused' && !resumed) { resumed = true; value(h.coordinator.resume(h.sid)); }
  }));
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  value(h.coordinator.pause(h.sid));
  assert.equal(value(h.engine.getSession(h.sid)).status, 'active');
  h.clock.set(8);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(8)));
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 1, 'the new active period was not aborted');
});

test('[R3-3] pause → reentrant resume still aborts work from BEFORE the pause', async () => {
  const h = setup();
  let resumed = false;
  value(h.engine.subscribe(h.sid, (s) => {
    if (s.status === 'paused' && !resumed) { resumed = true; value(h.coordinator.resume(h.sid)); }
  }));
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  h.reasoningGate.hold();
  h.clock.set(8);
  value(await h.coordinator.ingestFrame(h.sid, h.captureFrame(8)));
  value(h.coordinator.pause(h.sid));
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.recs().length, 0, 'pre-pause reasoning result discarded');
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'aborted'));
});

test('[R3-3] a subscriber pausing during role application stops later goal updates (original repro)', async () => {
  const h = setup();
  h.clock.set(2);
  // Both utterances land in ONE reasoning batch (the first is ingested without a trigger).
  h.engine.ingestConversation(h.sid, { captureGeneration: h.generation(), observedAt: at(1), text: ROLE_LINE });
  let paused = false;
  value(h.engine.subscribe(h.sid, () => {
    const alex = value(h.engine.getSession(h.sid)).participants[0];
    if (!paused && alex?.role === 'left defense') { paused = true; value(h.coordinator.pause(h.sid)); }
  }));
  h.say(2, 'Our goal is to keep the left covered.');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).status, 'paused');
  assert.equal(value(h.engine.getSession(h.sid)).goals.length, 0, 'no context applied after the pause');
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'lifecycle_changed'));
});

for (const action of ['end', 'discard'] as const) {
  test(`[R3-3] a subscriber that calls ${action} during context application stops the run cleanly`, async () => {
    const h = setup();
    h.clock.set(2);
    h.engine.ingestConversation(h.sid, { captureGeneration: h.generation(), observedAt: at(1), text: ROLE_LINE });
    let done = false;
    value(h.engine.subscribe(h.sid, () => {
      const snap = h.engine.getSession(h.sid);
      if (!done && snap.ok && snap.value.participants[0]?.role === 'left defense') {
        done = true;
        if (action === 'end') value(h.coordinator.end(h.sid));
        else value(h.coordinator.discard(h.sid));
      }
    }));
    h.say(2, 'Our goal is to keep the left covered.');
    await h.coordinator.whenIdle(h.sid);
    const snap = h.engine.getSession(h.sid);
    if (action === 'discard') assert.equal(snap.ok, false);
    else assert.equal(value(snap).goals.length, 0);
    const late = await h.coordinator.ingestFrame(h.sid, h.captureFrame(3, true, 1));
    assert.equal(late.ok, false);
  });
}

test('[R3-3] lifecycle changed directly on the engine during reasoning is honoured', async () => {
  const h = setup();
  h.reasoningGate.hold();
  h.say(2, ROLE_LINE);
  value(h.engine.pause(h.sid)); // bypasses the coordinator
  value(h.engine.resume(h.sid));
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).participants[0]?.role, undefined, 'stale-period result not applied');
  h.say(3, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).participants[0]?.role, 'left defense', 'new period works');
});

// ── Fix 4: duplicates within one response ──────────────────────────────────

function scripted(updates: (ids: string[]) => unknown[]): ReasoningFn {
  return async (request) => ({
    ok: true,
    value: {
      sessionId: request.session.id,
      basedOnContextRevision: request.session.contextRevision,
      captureGeneration: request.session.captureGeneration,
      contextUpdates: updates(request.observations.map((o) => o.id)) as never,
      recommendationCandidates: [],
      uncertainties: [],
      withheld: [],
    },
  });
}

test('[R3-4] duplicate goal proposals in one response create one goal and one event (original repro)', async () => {
  const goal = (ids: string[]) => ({ type: 'group_goal', text: 'Our goal is to win.', sourceObservationIds: [ids[0]], evidenceQuotes: [] });
  const h = setup({ reasoning: scripted((ids) => [goal(ids), goal(ids)]) });
  h.say(2, 'Our goal is to win.');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).goals.length, 1);
  assert.equal(value(h.engine.getTimeline(h.sid)).filter((e) => e.type === 'goal_set').length, 1);
});

test('[R3-4] duplicate decision proposals in one response create one decision', async () => {
  const decision = (ids: string[]) => ({ type: 'participant_decision', text: 'We decided to rotate.', participantIds: [], sourceObservationIds: [ids[0]], evidenceQuotes: [] });
  const h = setup({ reasoning: scripted((ids) => [decision(ids), decision(ids), decision(ids)]) });
  h.say(2, 'We decided to rotate.');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).decisions.length, 1);
  assert.equal(value(h.engine.getTimeline(h.sid)).filter((e) => e.type === 'decision_recorded').length, 1);
});

test('[R3-4] genuinely distinct goals and decisions in one response are all kept', async () => {
  const h = setup({
    reasoning: scripted((ids) => [
      { type: 'group_goal', text: 'Our goal is to win.', sourceObservationIds: [ids[0]], evidenceQuotes: [] },
      { type: 'group_goal', text: 'Our goal is to defend.', sourceObservationIds: [ids[1]], evidenceQuotes: [] },
      { type: 'participant_decision', text: 'We decided to rotate.', participantIds: [], sourceObservationIds: [ids[0]], evidenceQuotes: [] },
      { type: 'participant_decision', text: 'We decided to press.', participantIds: [], sourceObservationIds: [ids[1]], evidenceQuotes: [] },
    ]),
  });
  h.clock.set(2);
  h.engine.ingestConversation(h.sid, { captureGeneration: h.generation(), observedAt: at(1), text: 'first' });
  h.say(2, 'second');
  await h.coordinator.whenIdle(h.sid);
  const snap = value(h.engine.getSession(h.sid));
  assert.equal(snap.goals.length, 2);
  assert.equal(snap.decisions.length, 2);
});

// ── Minor: capture metadata snapshot and limits ────────────────────────────

test('frame metadata is snapshotted before vision; mutating the input afterwards has no effect', async () => {
  const h = setup();
  h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  h.vision.gate.hold();
  h.clock.set(8);
  const frame = h.captureFrame(8);
  const pending = h.coordinator.ingestFrame(h.sid, frame);
  frame.observedAt = at(1);
  frame.captureGeneration = 99;
  h.vision.gate.release();
  const screen = value(await pending);
  assert.equal(screen.observedAt, at(8));
  assert.equal(screen.captureGeneration, 1);
});

test('coordinator rejects selection limits beyond the reasoning maximum', () => {
  assert.throws(() => new SidekickCoordinator({ reasoning: mockReasoning, selection: { maxBatch: 101 } }), RangeError);
  assert.throws(() => new SidekickCoordinator({ reasoning: mockReasoning, maxReruns: -1 }), RangeError);
});

// ── Round 4, Fix 1: contradictory summaries with matching partial facts ─────

/**
 * Gemini-like scripted provider, run through the REAL reasoning module (`reason()` →
 * validation and evidence checks). Like a model reading summaries, it proposes advice
 * only when the newest frame's summary says the zone is empty — the facts are incomplete.
 */
const summaryReader = createReasoningFn({
  async generate(input: { session: { captureGeneration: number }; observations: Array<Record<string, unknown>> }) {
    const screens = input.observations
      .filter((o) => o.source === 'screen' && o.captureGeneration === input.session.captureGeneration)
      .sort((a, b) => Date.parse(b.observedAt as string) - Date.parse(a.observedAt as string));
    const newest = screens[0];
    if (!newest || !/empty/i.test(newest.summary as string)) {
      return { contextUpdates: [], recommendationCandidates: [], uncertainties: ['No visible gap.'] };
    }
    return {
      contextUpdates: [],
      uncertainties: [],
      recommendationCandidates: [{
        fingerprint: 'left_defense_uncovered', title: 'Left defense appears exposed', shortAdvice: 'Arrange cover.',
        urgency: 'normal', conditionObservationIds: [newest.id], contextObservationIds: [],
        evidenceQuotes: [{ observationId: newest.id, quote: newest.summary }],
        situation: { leftZoneVisible: true, leftZoneUncovered: true, certainty: 'clear' },
      }],
    };
  },
});

async function contradiction(older: { summary: string; facts?: Record<string, boolean> }, newer: { summary: string; facts?: Record<string, boolean> }, conditionFactKeys?: string[]) {
  const h = setup({ reasoning: summaryReader, ...(conditionFactKeys ? { conditionFactKeys } : {}) });
  const ingest = (seconds: number, frame: { summary: string; facts?: Record<string, boolean> }) =>
    value(h.coordinator.ingestScreen(h.sid, {
      mediaSource: 'screen_share', captureGeneration: h.generation(), observedAt: at(seconds), evidenceQuality: 'clear', summary: frame.summary,
      ...(frame.facts ? { facts: frame.facts } : {}),
    }));
  h.reasoningGate.hold();
  h.clock.set(8);
  ingest(8, older); // reasoning on the older frame starts
  h.clock.set(9);
  ingest(9, newer); // newer frame arrives while it is in flight
  h.reasoningGate.release();
  await h.coordinator.whenIdle(h.sid);
  return h;
}

const EMPTY = 'Left zone clearly empty';
const COVERED = 'Left zone clearly covered';

test('[R4-1] contradictory summaries with identical PARTIAL facts: no outdated card (original repro)', async () => {
  const h = await contradiction({ summary: EMPTY, facts: { leftZoneVisible: true } }, { summary: COVERED, facts: { leftZoneVisible: true } });
  assert.equal(h.recs().length, 0, 'the outdated recommendation never becomes active');
  assert.ok(h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'evidence_superseded'));
});

test('[R4-1] contradictory summaries with EMPTY facts, and with no facts: no outdated card', async () => {
  for (const facts of [{}, undefined]) {
    const h = await contradiction({ summary: EMPTY, ...(facts ? { facts } : {}) }, { summary: COVERED, ...(facts ? { facts } : {}) });
    assert.equal(h.recs().length, 0, `facts=${JSON.stringify(facts)}`);
  }
});

test('[R4-1] partial facts do not satisfy configured condition keys either', async () => {
  const h = await contradiction(
    { summary: EMPTY, facts: { leftZoneVisible: true } }, { summary: COVERED, facts: { leftZoneVisible: true } },
    ['leftZoneVisible', 'leftZoneUncovered'],
  );
  assert.equal(h.recs().length, 0);
});

test('[R4-1] genuinely same condition keeps the result: identical summaries', async () => {
  const h = await contradiction({ summary: EMPTY, facts: { leftZoneVisible: true } }, { summary: EMPTY, facts: { leftZoneVisible: true } });
  assert.equal(h.recs().length, 1);
  assert.ok(!h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'evidence_superseded'));
});

test('[R4-1] genuinely same condition keeps the result: complete condition facts, different wording', async () => {
  const full = { leftZoneVisible: true, leftZoneUncovered: true };
  const h = await contradiction({ summary: EMPTY, facts: full }, { summary: 'Nobody is defending the left; it is empty', facts: full },
    ['leftZoneVisible', 'leftZoneUncovered']);
  assert.equal(h.recs().length, 1);
  assert.ok(!h.diagnostics.some((d) => d.type === 'reasoning_discarded' && d.reason === 'evidence_superseded'));
});

// ── Round 4, Fix 2: sustained future-stamped input ─────────────────────────

test('[R4-2] 101 frames at ~10/s stamped 5 s ahead still reach reasoning, with role context (original repro)', async () => {
  const h = setup(); // default maxScreens = 20, far fewer than the future frames in flight
  const utterance = h.say(2, ROLE_LINE);
  await h.coordinator.whenIdle(h.sid);
  const before = h.reasoningCalls;
  const startMs = Date.parse(at(10));
  for (let i = 0; i <= 100; i++) {
    h.clock.set((startMs - Date.parse(at(0)) + i * 100) / 1000);
    h.timers.fireDue();
    const ahead = new Date(h.clock.now().getTime() + 5_000).toISOString(); // exactly maxClockSkewMs
    value(await h.coordinator.ingestFrame(h.sid, { ...h.captureFrame(0), observedAt: ahead }));
    await h.coordinator.whenIdle(h.sid);
  }
  const calls = h.reasoningCalls - before;
  assert.ok(calls > 0, 'reasoning ran');
  assert.ok(calls >= 40, `reasoning kept running as frames became eligible (${calls} calls)`);
  const card = h.recs()[0];
  assert.ok(card, 'advice created from eligible evidence');
  assert.equal(h.recs().length, 1);
  assert.deepEqual(card.contextObservationIds, [utterance.id], 'eligible role context still included');
  assert.deepEqual(card.relatedParticipantIds, [h.alex.id]);
  assert.ok(h.timers.dueTimes.length <= 1);
});
