import { readFileSync } from 'node:fs';
import { reason } from '../src/reasoning/reason.mts';
import { createMockProvider } from '../src/adapters/model/mock.mts';
import { createGeminiProvider } from '../src/adapters/model/gemini.mts';

const input = JSON.parse(readFileSync(new URL('../tests/reasoning/fixtures/normalized-left-defense.json', import.meta.url), 'utf8'));
const live = process.argv.includes('--live');
try {
  const provider = live
    ? createGeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? '', model: process.env.GEMINI_MODEL ?? '' })
    : createMockProvider();
  console.log(live ? 'REAL GEMINI CALL / SYNTHETIC INPUT / NO CHERT' : 'OFFLINE MOCK / NO GEMINI CALL / NO CHERT');
  const result = await reason(input, provider);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch {
  console.error('Live demo requires GEMINI_API_KEY and an account-supported GEMINI_MODEL in the server environment. No mock fallback was used.');
  process.exitCode = 1;
}
