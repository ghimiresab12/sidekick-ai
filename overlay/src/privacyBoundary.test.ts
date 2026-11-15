/**
 * Static guard for the privacy boundary: the overlay must never be able to
 * publish audio into FaceTime/Chert/WebRTC. It may only use local speech
 * synthesis. This scans every non-test source file for media-capture,
 * peer-connection and call-SDK usage.
 *
 * Network access is allowed in exactly one file, `backend/httpBackend.ts` (the client of
 * the local bridge's browser API). Everything else stays network-free.
 *
 * This proves what the CODE does. It cannot prove acoustic isolation or OS
 * screen-share audio behaviour — those need the live CH-4 test.
 */
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FORBIDDEN: Array<[string, RegExp]> = [
  ['WebRTC peer connection', /\bRTCPeerConnection\b/],
  ['microphone/camera capture', /\bgetUserMedia\b/],
  ['screen capture', /\bgetDisplayMedia\b/],
  ['media stream construction', /\bnew\s+MediaStream\b/],
  ['audio routed to a stream', /createMediaStreamDestination|captureStream\s*\(/],
  ['Web Audio graph', /\bnew\s+(AudioContext|webkitAudioContext)\b/],
  ['call SDK import', /from\s+['"][^'"]*(livekit|chert)[^'"]*['"]/i],
  ['network calls', /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bEventSource\b|\bsendBeacon\b/],
];

/** The only overlay file allowed to talk to the network (the local bridge, same origin). */
const NETWORK_CLIENT = './backend/httpBackend.ts';

describe('privacy boundary (static)', () => {
  it('found the source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`no ${label}`, () => {
      const offenders = Object.entries(sources)
        .filter(([file]) => !(label === 'network calls' && file === NETWORK_CLIENT))
        .filter(([, code]) => pattern.test(code))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  }

  it('the network client exists and only uses same-origin bridge paths', () => {
    const code = sources[NETWORK_CLIENT];
    expect(code).toBeDefined();
    // No absolute URLs: requests go to the bridge that served the page (base '' by default).
    expect(code).not.toMatch(/['"`]https?:\/\//);
    expect(code).not.toMatch(/['"]?authorization['"]?\s*:/i); // never sends an Authorization header
    expect(code).not.toMatch(/['"`]Bearer\s/); // never builds a bearer credential
  });

  it('the in-process simulation is never imported statically by the app (live bundle has no engine)', () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.startsWith('./backend/inProcessBackend'))
      .filter(([, code]) => /^import[^;]*from\s+['"][^'"]*inProcessBackend['"]/m.test(code))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('speechSynthesis is used only in voice/speechService.ts', () => {
    const users = Object.entries(sources)
      .filter(([, code]) => /\bspeechSynthesis\b|SpeechSynthesisUtterance/.test(code))
      .map(([file]) => file);
    expect(users).toEqual(['./voice/speechService.ts']);
  });
});

/**
 * The in-process backend bundles shared backend modules from `src/` into the page.
 * Every backend module the overlay may import is scanned with the same rules, and the
 * overlay may never import the Gemini adapter (API keys stay server-side).
 */
const backendSources = import.meta.glob(
  [
    '../../src/engine.ts',
    '../../src/contracts/*.ts',
    '../../src/sessions/*.ts',
    '../../src/recommendations/*.ts',
    '../../src/coordinator/*.ts',
    '../../src/privacy/*.ts',
    '../../src/explanations/*.ts',
    '../../src/reasoning/*.mts',
    '../../src/adapters/model/mock.mts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('privacy boundary (shared backend modules bundled into the overlay)', () => {
  it('found the backend modules', () => {
    expect(Object.keys(backendSources).length).toBeGreaterThan(8);
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`no ${label} in bundled backend code`, () => {
      const offenders = Object.entries(backendSources)
        .filter(([, code]) => pattern.test(code))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  }

  it('the overlay never imports the Gemini adapter or reads API keys', () => {
    const offenders = Object.entries({ ...sources, ...backendSources })
      .filter(([, code]) => /adapters\/model\/gemini|GEMINI_API_KEY|process\.env/.test(code))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
