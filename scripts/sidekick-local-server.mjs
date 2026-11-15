import { createServer } from 'node:http';
import { SidekickEngine } from '../dist/src/index.js';
import { createGeminiProvider } from '../src/adapters/model/gemini.mts';
import { createMockProvider } from '../src/adapters/model/mock.mts';
import { reason } from '../src/reasoning/reason.mts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SIDEKICK_PORT ?? 4317);
const provider = process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL
  ? createGeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL })
  : createMockProvider();
const reasoningMode = process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL ? 'gemini' : 'deterministic mock';
const subscribers = new Set();

let engine;
let sessionId;
let alexId;
let samId;
let observations;
let feedIndex;
let voiceRequestByRecommendation;

const unwrap = (result) => {
  if (!result.ok) throw new Error(result.detail ? `${result.error}: ${result.detail}` : result.error);
  return result.value;
};

function resetSession() {
  engine = new SidekickEngine();
  const session = unwrap(engine.createSession());
  sessionId = session.id;
  alexId = unwrap(engine.addParticipant(sessionId, { displayName: 'Alex' })).id;
  samId = unwrap(engine.addParticipant(sessionId, { displayName: 'Sam' })).id;
  unwrap(engine.confirmActivity(sessionId, 'gaming'));
  observations = [];
  feedIndex = 0;
  voiceRequestByRecommendation = new Map();
  broadcast();
}

function asObservation(input) {
  if (input.source === 'transcript') {
    return {
      id: input.id,
      sessionId: input.sessionId,
      observedAt: input.observedAt,
      source: 'transcript',
      summary: input.text,
      speakerId: input.speakerParticipantId,
      evidenceQuality: 'clear',
    };
  }
  return {
    id: input.id,
    sessionId: input.sessionId,
    observedAt: input.observedAt,
    source: 'screen',
    summary: input.summary,
    evidenceQuality: input.evidenceQuality,
    frameRef: input.frameRef,
  };
}

function mapEvent(event) {
  const supported = new Set([
    'role_updated', 'activity_confirmed', 'observation', 'recommendation_created',
    'recommendation_dismissed', 'recommendation_resolved', 'recommendation_stale',
    'voice_requested', 'voice_finished', 'session_started', 'session_paused',
    'session_resumed', 'session_ended',
  ]);
  if (!supported.has(event.type)) return null;
  const result = {
    id: event.id,
    sessionId: event.sessionId,
    time: event.time,
    type: event.type,
    summary: event.summary,
  };
  if (event.type === 'observation') result.observationIds = [event.observationId];
  if ('recommendationId' in event) result.recommendationId = event.recommendationId;
  if (event.type === 'recommendation_created') {
    result.observationIds = [...event.conditionObservationIds, ...event.contextObservationIds];
  }
  if (event.type === 'recommendation_resolved') result.observationIds = [event.observationId];
  return result;
}

function snapshot() {
  const session = unwrap(engine.getSession(sessionId));
  const timeline = unwrap(engine.getTimeline(sessionId)).map(mapEvent).filter(Boolean);
  const participants = Object.fromEntries(session.participants.map((p) => [p.id, {
    displayName: p.displayName,
    ...(p.role ? { role: p.role } : {}),
  }]));
  const latest = observations.at(-1);
  return {
    session: {
      id: session.id,
      status: session.status,
      consentActive: session.consentGiven && session.status === 'active',
      activity: session.activity,
      activityConfirmed: session.activityConfirmed,
      startedAt: session.startedAt ?? session.createdAt,
      ...(session.endedAt ? { endedAt: session.endedAt } : {}),
      participants,
      goals: session.goals.filter((g) => g.active).map((g) => g.text),
      latestObservationIds: latest ? [latest.id] : [],
      recommendationIds: session.recommendations.map((r) => r.id),
    },
    recommendations: session.recommendations.map((r) => {
      const requestId = voiceRequestByRecommendation.get(r.id);
      const voiceRequest = session.voiceRequests.find((item) => item.id === requestId);
      const voiceStatus = voiceRequest?.status === 'cancelled' ? 'failed' : voiceRequest?.status;
      return {
        id: r.id,
        sessionId: r.sessionId,
        createdAt: r.createdAt,
        status: r.status,
        title: r.title,
        shortAdvice: r.shortAdvice,
        evidenceObservationIds: [...r.conditionObservationIds, ...r.contextObservationIds],
        ...(r.relatedGoalId ? { relatedGoal: session.goals.find((g) => g.id === r.relatedGoalId)?.text } : {}),
        urgency: r.urgency,
        ...(voiceRequest ? { voiceRequestedAt: voiceRequest.requestedAt, voiceDeliveryStatus: voiceStatus } : {}),
        relatedParticipantIds: [...r.relatedParticipantIds],
      };
    }),
    observations: observations.map(asObservation),
    events: timeline,
    reasoningMode,
  };
}

function broadcast() {
  if (!engine || !sessionId) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const response of subscribers) response.write(payload);
}

function reasoningInput() {
  const session = unwrap(engine.getSession(sessionId));
  return {
    session: {
      id: session.id,
      status: session.status,
      consentGiven: session.consentGiven,
      activity: session.activity,
      activityConfirmed: session.activityConfirmed,
      contextRevision: session.contextRevision,
      captureGeneration: session.captureGeneration,
      participants: session.participants,
      goals: session.goals,
    },
    observations,
    now: new Date().toISOString(),
    staleAfterMs: engine.config.staleAfterMs,
  };
}

async function runReasoning() {
  let result = await reason(reasoningInput(), provider);
  if (!result.ok) throw new Error(`reasoning_${result.error}`);
  let changedContext = false;
  for (const update of result.value.contextUpdates) {
    const sourceObservationId = update.sourceObservationIds[0];
    if (update.type === 'role_assignment') {
      unwrap(engine.assignRole(sessionId, update.participantId, update.role, {
        source: 'transcript', sourceObservationId,
      }));
      changedContext = true;
    } else if (update.type === 'group_goal') {
      unwrap(engine.setGoal(sessionId, update.text, { source: 'transcript', sourceObservationId }));
      changedContext = true;
    } else if (update.type === 'activity_identification') {
      unwrap(engine.suggestActivity(sessionId, update.activity));
    } else if (update.type === 'participant_decision') {
      unwrap(engine.recordDecision(sessionId, {
        text: update.text,
        source: 'transcript',
        sourceObservationIds: update.sourceObservationIds,
        participantIds: update.participantIds,
      }));
      changedContext = true;
    }
  }
  // Re-read context and validate again if the model proposed a context change.
  if (changedContext && result.value.recommendationCandidates.length > 0) {
    result = await reason(reasoningInput(), provider);
    if (!result.ok) throw new Error(`reasoning_${result.error}`);
  }
  for (const candidate of result.value.recommendationCandidates) {
    unwrap(engine.proposeRecommendation(sessionId, candidate));
  }
  broadcast();
  return { uncertainties: result.value.uncertainties, withheld: result.value.withheld };
}

function review() {
  const data = snapshot();
  const recs = new Map(data.recommendations.map((r) => [r.id, r]));
  const visible = data.events.filter((e) => [
    'role_updated', 'recommendation_created', 'recommendation_resolved',
    'recommendation_dismissed', 'voice_requested',
  ].includes(e.type));
  const created = data.events.filter((e) => e.type === 'recommendation_created');
  const resolved = data.events.filter((e) => e.type === 'recommendation_resolved');
  const enoughEvidence = created.length > 0 && data.observations.some((o) => o.source === 'screen');
  return {
    sessionId: data.session.id,
    generatedAt: new Date().toISOString(),
    activity: data.session.activity,
    overview: enoughEvidence
      ? `In this simulated ${data.session.activity} session, Sidekick produced ${created.length} evidence-linked recommendation${created.length === 1 ? '' : 's'} from synthetic inputs.`
      : `Not enough observations for a performance assessment. Sidekick recorded ${data.events.length} event${data.events.length === 1 ? '' : 's'} and showed no grounded recommendation.`,
    keyMoments: visible.map((e) => ({ eventIds: [e.id], time: e.time, whatHappened: e.summary })),
    strengths: resolved.map((e) => `A later synthetic screen observation supported resolving “${recs.get(e.recommendationId)?.title ?? 'an issue'}”.`),
    improvementAreas: created.flatMap((e) => {
      const rec = recs.get(e.recommendationId);
      return rec && rec.status !== 'resolved' ? [`“${rec.title}” has no later observation confirming it was resolved.`] : [];
    }),
    nextActions: [...new Set(created.map((e) => recs.get(e.recommendationId)?.shortAdvice).filter(Boolean))],
    limitations: [
      'Synthetic demo input; no live Chert, FaceTime, LiveKit room media, or screen capture was processed.',
      `Reasoning provider: ${reasoningMode}. Screen facts and transcript are scripted, not sensed live.`,
      'No scores, match outcomes, or player performance metrics are tracked.',
    ],
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}

async function handle(request, response) {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { status: 'ok', reasoningMode });
    }
    if (url.pathname === '/api/session' && request.method === 'GET') return sendJson(response, 200, snapshot());
    if (url.pathname === '/api/session/stream' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      subscribers.add(response);
      response.on('close', () => subscribers.delete(response));
      return;
    }
    if (request.method !== 'POST') return sendJson(response, 404, { error: 'not_found' });
    const body = await readJson(request);

    if (url.pathname === '/api/session/reset') {
      resetSession();
      return sendJson(response, 200, snapshot());
    }
    if (url.pathname === '/api/session/start') {
      unwrap(engine.startWithConsent(sessionId));
      broadcast();
      return sendJson(response, 200, snapshot());
    }
    if (url.pathname === '/api/session/pause') unwrap(engine.pause(sessionId));
    else if (url.pathname === '/api/session/resume') unwrap(engine.resume(sessionId));
    else if (url.pathname === '/api/session/end') unwrap(engine.end(sessionId));
    else if (url.pathname === '/api/session/discard') {
      unwrap(engine.discard(sessionId));
      sessionId = undefined;
      observations = [];
      return sendJson(response, 200, { ok: true });
    } else if (url.pathname === '/api/session/dismiss') {
      unwrap(engine.dismiss(sessionId, body.recommendationId));
    } else if (url.pathname === '/api/session/demo/advance') {
      const session = unwrap(engine.getSession(sessionId));
      if (session.status !== 'active') throw new Error('Start observing before playing the synthetic feed.');
      if (feedIndex === 0) {
        const input = {
          captureGeneration: session.captureGeneration,
          observedAt: new Date().toISOString(),
          text: 'Alex is responsible for left defense.',
        };
        const observation = unwrap(engine.ingestConversation(sessionId, input));
        observations.push(observation);
        feedIndex += 1;
        await runReasoning();
      } else if (feedIndex === 1) {
        const input = {
          captureGeneration: session.captureGeneration,
          observedAt: new Date().toISOString(),
          summary: 'Synthetic game frame: the left defensive zone appears uncovered.',
          evidenceQuality: 'clear',
          facts: { leftZoneVisible: true, leftZoneUncovered: true },
        };
        const observation = unwrap(engine.ingestScreen(sessionId, input));
        observations.push(observation);
        feedIndex += 1;
        await runReasoning();
      }
      return sendJson(response, 200, { remaining: Math.max(0, 2 - feedIndex) });
    } else if (url.pathname === '/api/session/voice') {
      const requested = unwrap(engine.requestExplanation(sessionId, body.recommendationId));
      voiceRequestByRecommendation.set(body.recommendationId, requested.request.id);
      const condition = requested.context.conditionEvidence.find((o) => o.source === 'screen');
      const role = requested.context.contextAtCreation.participants.find((p) => p.role)?.role;
      const advice = requested.context.recommendation.shortAdvice;
      const text = [
        role ? `The group assigned ${requested.context.contextAtCreation.participants.find((p) => p.role)?.displayName} to ${role}.` : '',
        condition?.source === 'screen' ? condition.summary : '',
        advice,
        requested.context.isStale ? 'This is based on an earlier observation and may no longer be current.' : '',
      ].filter(Boolean).join(' ');
      broadcast();
      return sendJson(response, 200, {
        recommendationId: body.recommendationId,
        text,
        refersToEarlierObservation: requested.context.isStale,
        evidenceObservationIds: requested.context.recommendation.conditionObservationIds,
        generatedAt: new Date().toISOString(),
        requestId: requested.request.id,
      });
    } else if (url.pathname === '/api/session/voice-report') {
      const requestId = voiceRequestByRecommendation.get(body.recommendationId);
      if (!requestId) throw new Error('No voice request exists for this recommendation.');
      if (body.report === 'cancelled') unwrap(engine.cancelExplanation(sessionId, requestId, 'user'));
      else {
        const status = body.report === 'playing' ? 'playing_locally' : body.report;
        unwrap(engine.reportVoiceStatus(sessionId, requestId, status));
      }
    } else if (url.pathname === '/api/session/review') {
      const current = unwrap(engine.getSession(sessionId));
      if (current.status !== 'ended') throw new Error('End the session before generating its review.');
      return sendJson(response, 200, review());
    } else {
      return sendJson(response, 404, { error: 'not_found' });
    }

    broadcast();
    return sendJson(response, 200, snapshot());
  } catch (error) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : 'request_failed' });
  }
}

resetSession();
const server = createServer((request, response) => void handle(request, response));
server.listen(PORT, HOST, () => {
  console.log(`Sidekick local integration server: http://${HOST}:${PORT}`);
  console.log(`Reasoning provider: ${reasoningMode}; demo inputs remain synthetic.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const response of subscribers) response.end();
    server.close(() => process.exit(0));
  });
}
