import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reason } from '../../src/reasoning/reason.mts';
import { createMockProvider } from '../../src/adapters/model/mock.mts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/normalized-left-defense.json', import.meta.url)));
const input = () => structuredClone(fixture);
for (const skew of [0, 1000, 5000]) {
  for (const extra of [0, 1]) test(`source time at skew ${skew} + ${extra} ms`, async () => {
    const i = input(); i.maxClockSkewMs = skew;
    i.observations.find(o => o.source === 'screen').observedAt = new Date(Date.parse(i.now) + skew + extra).toISOString();
    const r = await reason(i, createMockProvider());
    assert.equal(r.ok, extra === 0);
    if (extra) assert.equal(r.error, 'invalid_input');
    else assert.equal(r.value.recommendationCandidates.length, 1);
  });
}
test('default remains zero tolerance', async () => {
  const i = input(); i.observations[0].observedAt = new Date(Date.parse(i.now) + 1).toISOString();
  assert.equal((await reason(i, createMockProvider())).error, 'invalid_input');
});
test('engine receive time gets no source-clock tolerance', async () => {
  const i = input(); i.maxClockSkewMs = 5000;
  i.observations[0].receivedAt = new Date(Date.parse(i.now) + 1).toISOString();
  assert.equal((await reason(i, createMockProvider())).error, 'invalid_input');
});
for (const skew of [-1, 5001, 0.1, Infinity, NaN, null, '5000']) test(`rejects invalid skew ${String(skew)} before inference`, async () => {
  const i = input(); i.maxClockSkewMs = skew;
  assert.equal((await reason(i, { generate() { assert.fail('provider called'); } })).error, 'invalid_input');
});
test('clock tolerance does not extend freshness or let fresh context revive old screens', async () => {
  const i = input(); i.maxClockSkewMs = 5000;
  i.observations.find(o => o.source === 'screen').observedAt = new Date(Date.parse(i.now) - i.staleAfterMs - 1).toISOString();
  i.observations.find(o => o.source === 'transcript').observedAt = new Date(Date.parse(i.now) + 5000).toISOString();
  const r = await reason(i, createMockProvider()); assert.ok(r.ok); assert.equal(r.value.recommendationCandidates.length, 0);
});
