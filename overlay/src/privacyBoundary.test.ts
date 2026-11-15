/**
 * Static guard for the privacy boundary: the overlay must never be able to
 * publish audio into FaceTime/Chert/WebRTC. It may only use local speech
 * synthesis. This scans every non-test source file for media-capture,
 * peer-connection and call-SDK usage.
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
  ['network calls from the overlay', /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b/],
];

describe('privacy boundary (static)', () => {
  it('found the source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`no ${label}`, () => {
      const offenders = Object.entries(sources)
        .filter(([, code]) => pattern.test(code))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  }

  it('speechSynthesis is used only in voice/speechService.ts', () => {
    const users = Object.entries(sources)
      .filter(([, code]) => /\bspeechSynthesis\b|SpeechSynthesisUtterance/.test(code))
      .map(([file]) => file);
    expect(users).toEqual(['./voice/speechService.ts']);
  });
});
