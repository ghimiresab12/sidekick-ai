import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExplanationText } from '../../src/explanations/explanation-text.js';
import type { ExplanationContext } from '../../src/contracts/types.js';

const TRANSCRIPT = 'Alex is responsible for left defense. My phone number is 555-0100.';

function context(over: Partial<ExplanationContext> = {}): ExplanationContext {
  return {
    recommendation: { shortAdvice: 'Ask Alex to cover left defense or arrange backup coverage' } as ExplanationContext['recommendation'],
    conditionEvidence: [{ id: 's1', sessionId: 'x', captureGeneration: 1, source: 'screen', observedAt: '', receivedAt: '', summary: 'The full left defensive zone is visible and appears uncovered', evidenceQuality: 'clear' }],
    contextEvidence: [{ id: 't1', sessionId: 'x', captureGeneration: 1, source: 'transcript', observedAt: '', receivedAt: '', text: TRANSCRIPT }],
    contextAtCreation: { contextRevision: 1, capturedAt: '', participants: [{ participantId: 'p1', displayName: 'Alex', role: 'left defense', roleRevision: 1 }] },
    changesSinceCreation: [],
    isStale: false,
    conditionAgeMs: 1000,
    ...over,
  };
}

test('grounded: roles at creation, screen summary, the card advice — and nothing else', () => {
  const text = buildExplanationText(context());
  assert.equal(text,
    'When this advice was made, the group had assigned Alex to left defense. ' +
    'The shared screen showed: The full left defensive zone is visible and appears uncovered. ' +
    'Ask Alex to cover left defense or arrange backup coverage.');
});

test('transcript text is never quoted, even when it is context evidence', () => {
  const text = buildExplanationText(context());
  for (const fragment of ['responsible for', '555-0100', 'phone']) assert.ok(!text.includes(fragment), fragment);
});

test('later corrections are stated separately; stale advice is phrased as earlier', () => {
  const text = buildExplanationText(context({
    isStale: true,
    changesSinceCreation: [
      { kind: 'role_changed', displayName: 'Alex', change: { revision: 2, kind: 'assigned', participantId: 'p1', role: 'striker', previousRole: 'left defense', effectiveAt: '', recordedAt: '', source: 'manual' } },
      { kind: 'goal_retired', goalId: 'g1', text: 'Keep the left covered', retiredAt: '', revision: 3 },
    ],
  }));
  assert.match(text, /assigned Alex to left defense\./, 'creation-time role kept');
  assert.match(text, /Since then, Alex's role changed to striker\./);
  assert.match(text, /Since then, a related group goal was retired\./);
  assert.ok(!text.includes('Keep the left covered'), 'goal wording withheld (M5)');
  assert.match(text, /earlier observation and may no longer be current\.$/);
});

test('no roles, no goal, no screen evidence → only the advice itself', () => {
  const text = buildExplanationText(context({ conditionEvidence: [], contextAtCreation: { contextRevision: 0, capturedAt: '', participants: [] } }));
  assert.equal(text, 'Ask Alex to cover left defense or arrange backup coverage.');
});

test('[M5] goal wording and unsafe role text never appear in explanations', () => {
  const text = buildExplanationText(context({
    contextAtCreation: {
      contextRevision: 2, capturedAt: '',
      participants: [{ participantId: 'p1', displayName: 'Sam', role: 'ZEBRA ROLE 5512 duty', roleRevision: 2 }],
      goal: { goalId: 'g1', text: 'Our goal is to protect ZEBRA-GOAL-7731 at all costs.' },
    },
  }));
  assert.ok(!text.includes('ZEBRA') && !text.includes('5512') && !text.includes('protect'), text);
  assert.match(text, /assigned Sam to assigned role\./);
  assert.match(text, /The group had stated a goal related to this advice\./);
});
