import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGeminiProvider } from '../../src/adapters/model/gemini.mts';
import { reason } from '../../src/reasoning/reason.mts';

const input = JSON.parse(readFileSync(new URL('./fixtures/normalized-left-defense.json', import.meta.url), 'utf8'));
const payload = { contextUpdates: [], recommendationCandidates: [], uncertainties: ['Insufficient evidence.'] };
const response = (text = JSON.stringify(payload), finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
const options = fetchImpl => ({ apiKey: 'test-only-not-a-real-key', model: 'gemini-test-model', fetchImpl });

test('sends documented structured REST request with server-side header and no media refs', async () => {
  let request;
  const provider = createGeminiProvider(options(async (url, init) => {
    request = { url, ...init }; return Response.json(response());
  }));
  const r = await reason(input, provider);
  assert.equal(r.ok, true);
  assert.match(request.url, /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemini-test-model:generateContent$/);
  assert.equal(request.url.includes('test-only'), false);
  assert.equal(request.headers['x-goog-api-key'], 'test-only-not-a-real-key');
  assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseJsonSchema.type, 'object');
  assert.equal('tools' in body, false);
  assert.equal(JSON.parse(body.contents[0].parts[0].text).observations.length, 2);
});
for (const status of [400, 401, 403, 404, 429, 500, 503]) test(`HTTP ${status} fails without leaking server response or retrying`, async () => {
  let calls = 0;
  const p = createGeminiProvider(options(async () => { calls++; return new Response('private server body', { status }); }));
  assert.deepEqual(await reason(input, p), { ok: false, error: 'provider_error' }); assert.equal(calls, 1);
});
for (const [name, value] of [
  ['blocked', { promptFeedback: { blockReason: 'SAFETY' } }],
  ['truncated', response('{}', 'MAX_TOKENS')],
  ['empty', { candidates: [] }],
  ['invalid model JSON', response('not json')],
  ['markdown fenced JSON', response('```json\n{}\n```')],
  ['non-text part', { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: {} }] } }] }]
]) test(`rejects ${name} model response`, async () => {
  const p = createGeminiProvider(options(async () => Response.json(value)));
  assert.equal((await reason(input, p)).error, 'provider_error');
});
test('invalid outer response JSON is rejected', async () => {
  const p = createGeminiProvider(options(async () => new Response('not-json')));
  assert.equal((await reason(input, p)).error, 'provider_error');
});
test('oversized response is bounded', async () => {
  const p = createGeminiProvider(options(async () => new Response('x'.repeat(131073))));
  assert.equal((await reason(input, p)).error, 'provider_error');
});
test('thought parts are not treated as the answer', async () => {
  const data = response(); data.candidates[0].content.parts.unshift({ thought: true, text: 'internal reasoning' });
  const p = createGeminiProvider(options(async () => Response.json(data)));
  assert.deepEqual(await p.generate(input), payload);
});
test('missing credentials and unsafe model paths rejected before network', () => {
  assert.throws(() => createGeminiProvider({ ...options(fetch), apiKey: '' }), /GEMINI_API_KEY/);
  assert.throws(() => createGeminiProvider({ ...options(fetch), model: '../secret' }), /GEMINI_MODEL/);
});
test('network failures are sanitized', async () => {
  const p = createGeminiProvider(options(async () => { throw Error('secret token'); }));
  await assert.rejects(p.generate(input), /Gemini request failed or was cancelled/);
});

test('diagnostics report only bounded HTTP metadata', async () => {
  const events = [];
  const p = createGeminiProvider({ ...options(async () => new Response('private response', { status: 429 })), onDiagnostic: e => events.push(e) });
  assert.equal((await reason(input, p)).error, 'provider_error');
  assert.deepEqual(events, [{ code: 'http_error', status: 429 }]);
});
test('unknown provider finish reason cannot leak through diagnostics', async () => {
  const events = [];
  const p = createGeminiProvider({ ...options(async () => Response.json(response('{}', 'private value'))), onDiagnostic: e => events.push(e) });
  assert.equal((await reason(input, p)).error, 'provider_error');
  assert.deepEqual(events, [{ code: 'incomplete_response' }]);
});
test('diagnostic callback failure does not change sanitized error', async () => {
  const p = createGeminiProvider({ ...options(async () => new Response('', { status: 503 })), onDiagnostic() { throw Error('private'); } });
  assert.equal((await reason(input, p)).error, 'provider_error');
});

test('provider schema avoids constraints rejected in the live smoke test', async () => {
  const p = createGeminiProvider(options(async (url, init) => {
    const schema = JSON.parse(init.body).generationConfig.responseJsonSchema;
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      assert.equal(Object.hasOwn(value, 'maxItems'), false);
      assert.equal(Object.hasOwn(value, 'additionalProperties'), false);
      for (const child of Object.values(value)) inspect(child);
    }
    inspect(schema);
    assert.ok(schema.properties.contextUpdates.items.anyOf);
    assert.ok(schema.required.includes('recommendationCandidates'));
    return Response.json(response());
  }));
  assert.equal((await reason(input, p)).ok, true);
});
