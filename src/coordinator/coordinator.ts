/**
 * SidekickCoordinator — connects capture input, vision, the session engine and
 * reasoning. The engine stays the single owner of session state; the coordinator
 * only holds transient task state (in-flight work, abort signals, rerun flags).
 *
 * Asynchronous safety rules:
 * - Capture metadata (`captureGeneration`, `observedAt`) is snapshotted from the frame
 *   BEFORE any await and carried unchanged through vision into `ingestScreen`.
 * - Each reasoning run records the snapshot's `contextRevision` and generation. After
 *   the await, and again before EVERY engine write, the run is revalidated (session,
 *   task identity, abort signal, status, generation). A run that is no longer valid
 *   stops immediately.
 * - Results computed against a superseded context (revision moved) or superseded
 *   condition evidence (a newer, disagreeing current-generation screen exists) are
 *   discarded and reasoning re-runs. Candidates are never relabelled.
 * - Each "active period" (start/resume → pause/end/discard) has its own AbortController
 *   and deadline timer. Lifecycle methods abort only the period that was current before
 *   the call, so a period created by a reentrant callback is never aborted by mistake.
 * - At most one reasoning run per session; triggers during a run coalesce into one rerun.
 */
import type {
  ConversationInput,
  ConversationObservation,
  Result,
  ScreenInput,
  ScreenObservation,
  SessionSnapshot,
} from '../contracts/types.js';
import { SidekickEngine, type EngineOptions } from '../engine.js';
import { parseIsoTime } from '../contracts/validate.js';
import type {
  CoordinatorDiagnostic,
  CoordinatorResult,
  FrameInput,
  ReasoningContextProposal,
  ReasoningFn,
  ReasoningRequest,
  VisionPort,
} from './ports.js';
import {
  DEFAULT_SELECTION_LIMITS,
  findSupersedingScreen,
  selectObservations,
  validateSelectionLimits,
  type SelectionLimits,
} from './select-observations.js';

export interface CoordinatorOptions {
  reasoning: ReasoningFn;
  vision?: VisionPort;
  /** Engine configuration. The coordinator owns the clock, so `now` here is ignored. */
  engine?: Omit<EngineOptions, 'now'>;
  /** Single clock shared by the engine and reasoning (`ReasoningRequest.now`). */
  now?: () => Date;
  /** Timer used to wake reasoning when future-stamped evidence becomes eligible. */
  setTimer?: (fn: () => void, delayMs: number) => () => void;
  selection?: Partial<SelectionLimits>;
  /** Max consecutive reruns caused by context or evidence changes, per trigger. */
  maxReruns?: number;
  /** Largest accepted frame, in bytes: integer 1–5 MiB; defaults to 5 MiB. */
  maxFrameBytes?: number;
  /**
   * Structured screen facts that fully describe the condition the active rule depends on
   * (MVP: `['leftZoneVisible', 'leftZoneUncovered']`). When every key is present on two
   * clear frames with equal values, they count as the same condition even if their
   * summaries are worded differently. Default `[]`: only identical summaries + facts agree.
   */
  conditionFactKeys?: readonly string[];
  onDiagnostic?: (diagnostic: CoordinatorDiagnostic) => void;
}

/** One active stretch of a session. Aborted exactly once, when it ends. */
interface Period {
  controller: AbortController;
  deadlineMs?: number;
  cancelDeadline?: () => void;
}

interface SessionTasks {
  period: Period;
  running?: Promise<void>;
  rerun: boolean;
  reruns: number;
  pending: Set<Promise<unknown>>;
  unsubscribe?: () => void;
}

interface RunContext {
  sessionId: string;
  tasks: SessionTasks;
  period: Period;
  generation: number;
}

const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const iso = (ms: number): string => new Date(ms).toISOString();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const newPeriod = (): Period => ({ controller: new AbortController() });

/** Reads a known adapter error code from a thrown value (structural; no adapter import). */
function visionErrorCode(error: unknown): 'invalid_frame' | 'busy' | 'timeout' | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'invalid_frame' || code === 'busy' || code === 'timeout' ? code : undefined;
}

/** Resolves/rejects with `work`, or rejects as soon as `signal` aborts — whichever is first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {}); // a late rejection must not become unhandled
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {});
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

const defaultTimer = (fn: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(fn, delayMs);
  handle.unref?.();
  return () => clearTimeout(handle);
};

export class SidekickCoordinator {
  readonly engine: SidekickEngine;
  readonly #reasoning: ReasoningFn;
  readonly #vision: VisionPort | undefined;
  readonly #now: () => Date;
  readonly #setTimer: (fn: () => void, delayMs: number) => () => void;
  readonly #limits: SelectionLimits;
  readonly #maxReruns: number;
  readonly #maxFrameBytes: number;
  readonly #conditionFactKeys: readonly string[];
  readonly #diagnostic: (d: CoordinatorDiagnostic) => void;
  readonly #tasks = new Map<string, SessionTasks>();

  constructor(options: CoordinatorOptions) {
    if (typeof options?.reasoning !== 'function') throw new TypeError('reasoning port is required');
    this.#reasoning = options.reasoning;
    this.#vision = options.vision;
    this.#now = options.now ?? (() => new Date());
    this.#setTimer = options.setTimer ?? defaultTimer;
    this.#limits = { ...DEFAULT_SELECTION_LIMITS, ...options.selection };
    validateSelectionLimits(this.#limits);
    this.#maxReruns = options.maxReruns ?? 3;
    if (!Number.isSafeInteger(this.#maxReruns) || this.#maxReruns < 0) throw new RangeError('maxReruns must be a non-negative integer');
    this.#maxFrameBytes = options.maxFrameBytes === undefined ? MAX_FRAME_BYTES : options.maxFrameBytes;
    if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1 || this.#maxFrameBytes > MAX_FRAME_BYTES) {
      throw new RangeError(`maxFrameBytes must be an integer from 1 to ${MAX_FRAME_BYTES}`);
    }
    const keys = options.conditionFactKeys ?? [];
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 64)) {
      throw new TypeError('conditionFactKeys must be an array of fact names');
    }
    this.#conditionFactKeys = Object.freeze([...keys]);
    this.#diagnostic = options.onDiagnostic ?? (() => {});
    this.engine = new SidekickEngine({ ...options.engine, now: this.#now });
  }

  // ── Lifecycle (use these instead of the engine's so in-flight work is aborted) ──

  createSession(options?: { externalRef?: string }): Result<SessionSnapshot> {
    const created = this.engine.createSession(options);
    if (!created.ok) return created;
    const id = created.value.id;
    const tasks: SessionTasks = { period: newPeriod(), rerun: false, reruns: 0, pending: new Set() };
    this.#tasks.set(id, tasks);
    // Keeps periods in sync with lifecycle changes made directly on the engine, too.
    const sub = this.engine.subscribe(id, () => this.#syncPeriod(id));
    if (sub.ok) tasks.unsubscribe = sub.value;
    return created;
  }

  startWithConsent(sessionId: string): Result<SessionSnapshot> {
    const r = this.engine.startWithConsent(sessionId);
    this.#syncPeriod(sessionId);
    return r;
  }

  pause(sessionId: string): Result<SessionSnapshot> {
    return this.#leaveActive(sessionId, () => this.engine.pause(sessionId));
  }

  resume(sessionId: string): Result<SessionSnapshot> {
    const r = this.engine.resume(sessionId);
    this.#syncPeriod(sessionId);
    return r;
  }

  end(sessionId: string): Result<SessionSnapshot> {
    return this.#leaveActive(sessionId, () => this.engine.end(sessionId));
  }

  discard(sessionId: string): Result<{ sessionId: string }> {
    const t = this.#tasks.get(sessionId);
    if (t) {
      this.#tasks.delete(sessionId);
      t.unsubscribe?.();
      this.#abortPeriod(t, t.period);
    }
    return this.engine.discard(sessionId);
  }

  // ── Capture input ─────────────────────────────────────────────────────────

  /** Normalized transcript from the capture adapter. Triggers reasoning when accepted. */
  ingestConversation(sessionId: string, input: ConversationInput): Result<ConversationObservation> {
    const r = this.engine.ingestConversation(sessionId, input);
    if (r.ok) this.#trigger(sessionId);
    return r;
  }

  /** Already-described screen input (e.g. a simulator). Triggers reasoning when accepted. */
  ingestScreen(sessionId: string, input: ScreenInput): Result<ScreenObservation> {
    const r = this.engine.ingestScreen(sessionId, input);
    if (r.ok) this.#trigger(sessionId);
    return r;
  }

  /**
   * Raw sampled frame → vision → engine. The frame's capture-time generation and
   * `observedAt` are snapshotted before vision runs; the image is passed to vision and
   * then dropped. Frames from an earlier generation are not sent to vision at all.
   *
   * `options.signal` lets the caller cancel (e.g. an HTTP request timeout or client
   * disconnect). Once it aborts, the frame is never ingested, even if vision finishes.
   */
  ingestFrame(
    sessionId: string,
    frame: FrameInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CoordinatorResult<ScreenObservation>> {
    const t = this.#tasks.get(sessionId);
    const work = this.#ingestFrame(sessionId, frame, t, options?.signal);
    if (t) {
      t.pending.add(work);
      void work.finally(() => t.pending.delete(work));
    }
    return work;
  }

  /** Resolves once no vision or reasoning work is in flight for the session (pending deadlines excluded). */
  async whenIdle(sessionId: string): Promise<void> {
    for (;;) {
      const t = this.#tasks.get(sessionId);
      if (!t) return;
      const waits = [...t.pending, ...(t.running ? [t.running] : [])];
      if (waits.length === 0) return;
      await Promise.allSettled(waits);
    }
  }

  // ── Periods ───────────────────────────────────────────────────────────────

  /** Runs a pause/end and aborts the period that was current BEFORE it. */
  #leaveActive(sessionId: string, op: () => Result<SessionSnapshot>): Result<SessionSnapshot> {
    const t = this.#tasks.get(sessionId);
    const before = t?.period;
    const r = op();
    if (r.ok && t && before) this.#abortPeriod(t, before);
    this.#syncPeriod(sessionId);
    return r;
  }

  /** Aligns the current period with the engine's actual status (idempotent). */
  #syncPeriod(sessionId: string): void {
    const t = this.#tasks.get(sessionId);
    if (!t) return;
    const snap = this.engine.getSession(sessionId);
    if (!snap.ok) return;
    if (snap.value.status === 'active') {
      if (t.period.controller.signal.aborted) t.period = newPeriod();
    } else if (snap.value.status !== 'starting') {
      this.#abortPeriod(t, t.period);
    }
  }

  /** Aborts one specific period; never touches a newer one. */
  #abortPeriod(t: SessionTasks, period: Period): void {
    if (period.controller.signal.aborted) return;
    period.controller.abort();
    period.cancelDeadline?.();
    delete period.cancelDeadline;
    delete period.deadlineMs;
    if (t.period === period) t.rerun = false;
  }

  /** Keeps the EARLIEST pending deadline; a later one never pushes it back. */
  #scheduleDeadline(sessionId: string, t: SessionTasks, atMs: number, nowMs: number): void {
    const period = t.period;
    if (period.controller.signal.aborted) return;
    if (period.deadlineMs !== undefined && period.deadlineMs <= atMs) return;
    period.cancelDeadline?.();
    period.deadlineMs = atMs;
    const delayMs = Math.max(1, atMs - nowMs);
    period.cancelDeadline = this.#setTimer(() => {
      if (period.deadlineMs !== atMs) return;
      delete period.deadlineMs;
      delete period.cancelDeadline;
      if (this.#tasks.get(sessionId) === t && t.period === period) this.#trigger(sessionId);
    }, delayMs);
    this.#diagnostic({ type: 'reasoning_deferred', sessionId, delayMs });
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  async #ingestFrame(
    sessionId: string,
    frame: FrameInput,
    t: SessionTasks | undefined,
    callerSignal?: AbortSignal,
  ): Promise<CoordinatorResult<ScreenObservation>> {
    const snap = this.engine.getSession(sessionId);
    if (!snap.ok || !t) return { ok: false, error: 'session_not_found' };
    if (snap.value.status === 'starting') return { ok: false, error: 'consent_required' };
    if (snap.value.status !== 'active') return { ok: false, error: 'session_not_active' };
    if (
      !isObject(frame) ||
      !(frame.image instanceof Uint8Array) ||
      frame.image.byteLength === 0 ||
      frame.image.byteLength > this.#maxFrameBytes ||
      !MIME_TYPES.has(frame.mimeType as string)
    ) {
      return { ok: false, error: 'invalid_input', detail: 'frame must be a non-empty JPEG/PNG/WebP image within the size limit' };
    }
    // Snapshot capture metadata now; nothing below re-reads the (mutable) input object.
    const generation = frame.captureGeneration;
    const observedAt = frame.observedAt;
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > snap.value.captureGeneration) {
      return { ok: false, error: 'invalid_generation' };
    }
    if (generation < snap.value.captureGeneration) {
      return { ok: false, error: 'stale_evidence', detail: 'frame captured before the last pause/resume; not sent to vision' };
    }
    // Reject inadmissible capture times before any external image processing. Mirror
    // engine admission, including its configured producer-clock tolerance. The engine
    // checks again after vision, so this does not bypass its lifecycle validation.
    const observedMs = parseIsoTime(observedAt);
    if (observedMs === undefined) return { ok: false, error: 'invalid_timestamp' };
    const nowMs = this.#now().getTime();
    const startedMs = parseIsoTime(snap.value.startedAt);
    const skew = this.engine.config.maxClockSkewMs;
    if (!Number.isFinite(nowMs) || startedMs === undefined || observedMs > nowMs + skew || observedMs < startedMs - skew) {
      return { ok: false, error: 'timestamp_out_of_range' };
    }
    if (!this.#vision) return { ok: false, error: 'vision_unavailable' };

    if (callerSignal?.aborted) return { ok: false, error: 'aborted' };
    // Aborts on pause/end/discard (period) OR caller cancellation, whichever comes first.
    const signal = callerSignal
      ? AbortSignal.any([t.period.controller.signal, callerSignal])
      : t.period.controller.signal;
    let description: unknown;
    try {
      // Raced against the signal so cancellation returns immediately even if the adapter
      // ignores `signal`; a late result from such an adapter is discarded.
      description = await untilAborted(
        this.#vision.describe(
          { captureGeneration: generation, observedAt, image: frame.image, mimeType: frame.mimeType },
          signal,
        ),
        signal,
      );
    } catch (error) {
      // Cancellation precedence: pause/end/discard/disconnect/caller deadline is never
      // reported as a vision or provider failure.
      if (signal.aborted) {
        this.#diagnostic({ type: 'vision_failed', sessionId, aborted: true, code: 'unknown' });
        return { ok: false, error: 'aborted' };
      }
      const code = visionErrorCode(error);
      this.#diagnostic({ type: 'vision_failed', sessionId, aborted: false, code: code ?? 'unknown' });
      if (code === 'invalid_frame') return { ok: false, error: 'invalid_input', detail: 'image rejected by vision' };
      if (code === 'busy') return { ok: false, error: 'vision_busy' };
      if (code === 'timeout') return { ok: false, error: 'vision_timeout' };
      return { ok: false, error: 'vision_failed' };
    }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    if (!isObject(description)) {
      this.#diagnostic({ type: 'vision_failed', sessionId, aborted: false, code: 'unknown' });
      return { ok: false, error: 'vision_failed', detail: 'vision returned no description' };
    }
    const input: ScreenInput = {
      captureGeneration: generation,
      observedAt,
      summary: description.summary as string,
      evidenceQuality: description.evidenceQuality as ScreenInput['evidenceQuality'],
    };
    if (description.facts !== undefined) input.facts = description.facts as ScreenInput['facts'];
    return this.ingestScreen(sessionId, input); // the engine validates the description
  }

  // ── Reasoning scheduling ──────────────────────────────────────────────────

  #trigger(sessionId: string): void {
    const t = this.#tasks.get(sessionId);
    if (!t || t.period.controller.signal.aborted) return;
    t.reruns = 0;
    if (t.running) {
      t.rerun = true;
      return;
    }
    this.#start(sessionId, t);
  }

  #start(sessionId: string, t: SessionTasks): void {
    t.running = this.#drain(sessionId, t).finally(() => {
      t.running = undefined;
      if (t.rerun && this.#tasks.get(sessionId) === t && !t.period.controller.signal.aborted) this.#start(sessionId, t);
    });
  }

  async #drain(sessionId: string, t: SessionTasks): Promise<void> {
    do {
      t.rerun = false;
      try {
        await this.#runOnce(sessionId, t);
      } catch {
        this.#diagnostic({ type: 'reasoning_failed', sessionId, error: 'coordinator_error' });
      }
    } while (t.rerun && this.#tasks.get(sessionId) === t && !t.period.controller.signal.aborted);
  }

  #requestRerun(sessionId: string, t: SessionTasks): void {
    if (t.reruns < this.#maxReruns) {
      t.reruns += 1;
      t.rerun = true;
    } else {
      this.#diagnostic({ type: 'rerun_budget_exhausted', sessionId });
    }
  }

  /** True while this run may still write to the engine. Checked before every write. */
  #valid(run: RunContext): boolean {
    if (this.#tasks.get(run.sessionId) !== run.tasks) return false;
    if (run.tasks.period !== run.period || run.period.controller.signal.aborted) return false;
    const snap = this.engine.getSession(run.sessionId);
    return snap.ok && snap.value.status === 'active' && snap.value.captureGeneration === run.generation;
  }

  async #runOnce(sessionId: string, t: SessionTasks): Promise<void> {
    const before = this.engine.getSession(sessionId);
    if (!before.ok) return;
    const snap = before.value;
    const period = t.period;
    const signal = period.controller.signal;
    if (snap.status !== 'active' || signal.aborted) {
      this.#diagnostic({ type: 'reasoning_skipped', sessionId, reason: 'inactive' });
      return;
    }
    const nowMs = this.#now().getTime();
    const staleAfterMs = this.engine.config.staleAfterMs;
    const selection = selectObservations(this.engine, snap, nowMs, staleAfterMs, this.#limits);
    if (!selection.ok) {
      this.#diagnostic({ type: 'reasoning_skipped', sessionId, reason: 'selection_failed' });
      return;
    }
    if (selection.value.nextEligibleAtMs !== undefined) {
      this.#scheduleDeadline(sessionId, t, selection.value.nextEligibleAtMs, nowMs);
    }
    const batch = selection.value.observations;
    if (batch.length === 0) {
      this.#diagnostic({ type: 'reasoning_skipped', sessionId, reason: 'no_observations' });
      return;
    }

    const run: RunContext = { sessionId, tasks: t, period, generation: snap.captureGeneration };
    const revision = snap.contextRevision;
    const request: ReasoningRequest = {
      session: { ...snap, goals: snap.goals.filter((g) => g.active).slice(0, 50) },
      observations: batch,
      now: iso(nowMs),
      staleAfterMs,
    };

    let result: unknown;
    try {
      result = await this.#reasoning(request, signal);
    } catch {
      this.#diagnostic({ type: 'reasoning_failed', sessionId, error: 'provider_threw' });
      return;
    }
    if (signal.aborted) return this.#discard(sessionId, 'aborted');
    if (!isObject(result) || result.ok !== true || !isObject(result.value)) {
      const error = isObject(result) && typeof result.error === 'string' ? result.error : 'invalid_result';
      this.#diagnostic({ type: 'reasoning_failed', sessionId, error });
      return;
    }
    const output = result.value;
    if (!this.engine.getSession(sessionId).ok) return this.#discard(sessionId, 'session_gone');
    if (!this.#valid(run)) return this.#discard(sessionId, 'lifecycle_changed');
    if (
      output.sessionId !== sessionId ||
      output.basedOnContextRevision !== revision ||
      output.captureGeneration !== run.generation ||
      !Array.isArray(output.contextUpdates) ||
      !Array.isArray(output.recommendationCandidates)
    ) {
      return this.#discard(sessionId, 'result_mismatch');
    }
    if (this.#revision(sessionId) !== revision) {
      // Roles/goals changed during the call (e.g. a manual correction): never relabel; re-run.
      this.#discard(sessionId, 'context_changed');
      return this.#requestRerun(sessionId, t);
    }

    for (const proposal of output.contextUpdates as ReasoningContextProposal[]) {
      if (!this.#valid(run)) return this.#discard(sessionId, 'lifecycle_changed');
      this.#applyContext(sessionId, proposal);
    }
    if (!this.#valid(run)) return this.#discard(sessionId, 'lifecycle_changed');
    if (this.#revision(sessionId) !== revision) {
      // Candidates in this batch were computed against the pre-update context.
      return this.#requestRerun(sessionId, t);
    }

    for (const candidate of output.recommendationCandidates) {
      if (!this.#valid(run)) return this.#discard(sessionId, 'lifecycle_changed');
      if (this.#revision(sessionId) !== revision) {
        this.#discard(sessionId, 'context_changed');
        return this.#requestRerun(sessionId, t);
      }
      const superseding = findSupersedingScreen(
        this.engine, sessionId, run.generation, batch, this.#now().getTime(), this.#conditionFactKeys,
      );
      if (!superseding.ok || superseding.value) {
        // A newer, disagreeing (or unclear) frame exists that this result never saw.
        this.#discard(sessionId, 'evidence_superseded');
        return this.#requestRerun(sessionId, t);
      }
      if (typeof candidate !== 'object' || candidate === null || candidate.basedOnContextRevision !== revision) {
        this.#diagnostic({ type: 'candidate_result', sessionId, outcome: 'revision_mismatch' });
        continue;
      }
      // The engine fully validates every candidate field.
      const r = this.engine.proposeRecommendation(sessionId, candidate);
      if (r.ok) {
        const id = r.value.outcome === 'suppressed' ? r.value.recommendationId : r.value.recommendation.id;
        this.#diagnostic({ type: 'candidate_result', sessionId, outcome: r.value.outcome, recommendationId: id });
      } else {
        this.#diagnostic({ type: 'candidate_result', sessionId, outcome: r.error });
        if (r.error === 'stale_context') return this.#requestRerun(sessionId, t);
      }
    }
    const withheld = Array.isArray(output.withheld) ? output.withheld : [];
    if (withheld.length > 0) {
      this.#diagnostic({
        type: 'candidates_withheld',
        sessionId,
        reasons: withheld.map((w) => (isObject(w) && typeof w.reason === 'string' ? w.reason : 'unknown')),
      });
    }
  }

  #revision(sessionId: string): number | undefined {
    const snap = this.engine.getSession(sessionId);
    return snap.ok ? snap.value.contextRevision : undefined;
  }

  #discard(sessionId: string, reason: Extract<CoordinatorDiagnostic, { type: 'reasoning_discarded' }>['reason']): void {
    this.#diagnostic({ type: 'reasoning_discarded', sessionId, reason });
  }

  /**
   * Applies one context proposal through engine APIs with transcript provenance.
   * Idempotent against CURRENT engine state (re-read per proposal, no shadow copy):
   * a proposal whose effect already exists — including a duplicate earlier in the same
   * response, or a retired goal — is not applied again.
   */
  #applyContext(sessionId: string, proposal: ReasoningContextProposal): void {
    const report = (outcome: string) =>
      this.#diagnostic({ type: 'context_applied', sessionId, proposal: String(proposal?.type), outcome });
    if (!isObject(proposal) || !Array.isArray(proposal.sourceObservationIds)) return report('invalid_proposal');
    const source = proposal.sourceObservationIds[0];
    if (typeof source !== 'string') return report('invalid_proposal');
    const current = this.engine.getSession(sessionId);
    if (!current.ok) return report('session_gone');
    const snap = current.value;
    const provenance = { source: 'transcript' as const, sourceObservationId: source };

    switch (proposal.type) {
      case 'role_assignment': {
        const p = snap.participants.find((x) => x.id === proposal.participantId);
        if (p?.role === proposal.role && p.lastRoleChange?.sourceObservationId === source) return report('already_applied');
        const r = this.engine.assignRole(sessionId, proposal.participantId, proposal.role, provenance);
        return report(r.ok ? r.value.outcome : r.error);
      }
      case 'group_goal': {
        const text = typeof proposal.text === 'string' ? proposal.text.trim() : '';
        if (snap.goals.some((g) => g.text === text && g.sourceObservationId === source)) return report('already_applied');
        const r = this.engine.setGoal(sessionId, text, provenance);
        return report(r.ok ? 'applied' : r.error);
      }
      case 'participant_decision': {
        const text = typeof proposal.text === 'string' ? proposal.text.trim() : '';
        if (snap.decisions.some((d) => d.text === text && sameSet(d.sourceObservationIds, proposal.sourceObservationIds))) {
          return report('already_applied');
        }
        const r = this.engine.recordDecision(sessionId, {
          text,
          source: 'transcript',
          sourceObservationIds: proposal.sourceObservationIds,
          participantIds: Array.isArray(proposal.participantIds) ? proposal.participantIds : [],
        });
        return report(r.ok ? 'applied' : r.error);
      }
      case 'activity_identification': {
        // A suggestion only; never re-suggest once the group confirmed an activity.
        if (snap.activityConfirmed || snap.suggestedActivity === proposal.activity) return report('already_applied');
        const r = this.engine.suggestActivity(sessionId, proposal.activity);
        return report(r.ok ? 'applied' : r.error);
      }
      default:
        return report('unsupported_proposal');
    }
  }
}
