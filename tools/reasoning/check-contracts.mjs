import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
const commit = '1bc0e9f1414fdb18dbcb95f4f41b79d80a0e9a88';
const temp = mkdtempSync(join(tmpdir(), 'sidekick-reasoning-contract-'));
console.log(`Checking published engine ${commit} in ${temp}`);
// No checkout, merge or changes to teammate files. Only a fresh temporary extraction.
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], { cwd: root, encoding: 'utf8' }).trim().split('\n');
for (const path of paths.filter(p => p.startsWith('src/') || ['package.json', 'tsconfig.json'].includes(p))) {
  const destination = join(temp, path); mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, execFileSync('git', ['show', `${commit}:${path}`], { cwd: root }));
}
for (const directory of ['src/reasoning', 'src/adapters/model']) {
  mkdirSync(join(temp, directory), { recursive: true });
  for (const name of readdirSync(join(root, directory))) copyFileSync(join(root, directory, name), join(temp, directory, name));
}
writeFileSync(join(temp, 'compatibility.mts'), `
import type { SessionSnapshot, Observation as EngineObservation, RecommendationCandidate as EngineCandidate } from './src/contracts/types.js';
import type { SessionContext, Observation, RecommendationCandidate } from './src/reasoning/contracts.mts';
declare const snapshot: SessionSnapshot;
declare const observation: EngineObservation;
declare const candidate: RecommendationCandidate;
const inputContext: SessionContext = snapshot;
const inputObservation: Observation = observation;
const outputCandidate: EngineCandidate = candidate;
void [inputContext, inputObservation, outputCandidate];
`);
const original = JSON.parse(readFileSync(join(temp, 'tsconfig.json'), 'utf8'));
const typeRoots = [join(here, 'node_modules/@types')];
writeFileSync(join(temp, 'tsconfig.compat.json'), JSON.stringify({
  compilerOptions: { ...original.compilerOptions, lib: ['ES2022', 'DOM'], typeRoots,
    noEmit: true, allowImportingTsExtensions: true },
  include: ['src/**/*.ts', 'src/**/*.mts', 'compatibility.mts']
}));
const tsc = join(here, 'node_modules/typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(temp, 'tsconfig.compat.json')], { stdio: 'inherit' });
original.compilerOptions.typeRoots = typeRoots;
writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify(original));
execFileSync(process.execPath, [tsc, '-p', join(temp, 'tsconfig.json')], { stdio: 'inherit' });

const { SidekickEngine } = await import(pathToFileURL(join(temp, 'dist/src/engine.js')).href);
const { reason } = await import(pathToFileURL(join(root, 'src/reasoning/reason.mts')).href);
const { createMockProvider } = await import(pathToFileURL(join(root, 'src/adapters/model/mock.mts')).href);
const unwrap = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
let clock = new Date('2026-11-14T20:00:00Z'); let next = 0;
const engine = new SidekickEngine({ now: () => clock, newId: () => `id-${++next}`, staleAfterMs: 10000 });
const session = unwrap(engine.createSession());
const player = unwrap(engine.addParticipant(session.id, { displayName: 'Alex' }));
unwrap(engine.startWithConsent(session.id));
unwrap(engine.confirmActivity(session.id, 'gaming'));
let snapshot = unwrap(engine.getSession(session.id));
const conversation = unwrap(engine.ingestConversation(session.id, {
  captureGeneration: snapshot.captureGeneration, observedAt: clock.toISOString(), text: 'Alex is responsible for left defense.'
}));
// Use actual engine APIs to accept a proposed context update, then re-read revision.
let first = unwrap(await reason({ session: snapshot, observations: [conversation], now: clock.toISOString(), staleAfterMs: 10000 }, createMockProvider()));
const proposal = first.contextUpdates[0]; assert.equal(proposal.type, 'role_assignment');
unwrap(engine.assignRole(session.id, proposal.participantId, proposal.role, { source: 'transcript', sourceObservationId: proposal.sourceObservationIds[0] }));
snapshot = unwrap(engine.getSession(session.id));
clock = new Date('2026-11-14T20:00:08Z');
const screen = unwrap(engine.ingestScreen(session.id, {
  captureGeneration: snapshot.captureGeneration, observedAt: clock.toISOString(),
  summary: 'The left defensive zone is clearly visible and contains no defending players.', evidenceQuality: 'clear',
  facts: { leftZoneVisible: true, leftZoneUncovered: true }
}));
clock = new Date('2026-11-14T20:00:10Z');
const packet = { session: snapshot, observations: [conversation, screen], now: clock.toISOString(), staleAfterMs: 10000 };
const result = unwrap(await reason(packet, createMockProvider()));
const candidate = result.recommendationCandidates[0]; assert.ok(candidate);
assert.equal(unwrap(engine.proposeRecommendation(session.id, candidate)).outcome, 'created');
assert.equal(unwrap(engine.proposeRecommendation(session.id, candidate)).outcome, 'merged');
unwrap(engine.assignRole(session.id, player.id, 'right defense', { source: 'manual' }));
assert.equal(engine.proposeRecommendation(session.id, candidate).error, 'stale_context');
unwrap(engine.pause(session.id));
assert.equal((await reason({ ...packet, session: unwrap(engine.getSession(session.id)) }, createMockProvider())).error, 'inactive_session');
console.log('PASS: types compatible; real engine accepts context and candidate, deduplicates, rejects changed revision, and pause blocks inference.');
