import type { SessionSnapshot, SidekickDataSource } from './SidekickDataSource';
import type { MockControls } from './mockDataSource';
import type { SessionReview } from '../contracts/sidekick';
import type { VoiceExplanation, VoicePlaybackReport } from '../contracts/proposed';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const data = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const message = typeof data === 'object' && data && 'error' in data ? data.error : undefined;
    throw new Error(typeof message === 'string' ? message : `Sidekick local service returned ${response.status}.`);
  }
  return data as T;
}

const post = <T = unknown>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** UI adapter for the loopback SidekickEngine + reasoning service. Inputs remain synthetic. */
export function createEngineDataSource(): SidekickDataSource & { readonly mock: MockControls } {
  let remaining = 2;
  const initialized = post<SessionSnapshot>('/api/session/reset');

  return {
    mode: 'mock',

    async getSnapshot() {
      await initialized;
      return request<SessionSnapshot>('/api/session');
    },

    subscribe(listener) {
      let closed = false;
      let eventSource: EventSource | undefined;
      void initialized.then(() => {
        if (closed) return;
        eventSource = new EventSource('/api/session/stream');
        eventSource.onmessage = (event) => {
          try {
            listener(JSON.parse(event.data) as SessionSnapshot);
          } catch {
            // Ignore malformed/stale stream messages; next full snapshot repairs state.
          }
        };
      }).catch(() => {});
      return () => {
        closed = true;
        eventSource?.close();
      };
    },

    async startSession() {
      await initialized;
      await post('/api/session/start');
    },
    async pauseSession() {
      await post('/api/session/pause');
    },
    async resumeSession() {
      await post('/api/session/resume');
    },
    async endSession() {
      await post('/api/session/end');
    },
    async discardSession() {
      await post('/api/session/discard');
    },
    async dismissRecommendation(recommendationId) {
      await post('/api/session/dismiss', { recommendationId });
    },
    async requestVoiceExplanation(recommendationId) {
      const result = await post<VoiceExplanation & { requestId: string }>('/api/session/voice', { recommendationId });
      return result;
    },
    reportVoicePlayback(recommendationId, report: VoicePlaybackReport) {
      void post('/api/session/voice-report', { recommendationId, report }).catch(() => {});
    },
    async generateReview() {
      await initialized;
      return post<SessionReview>('/api/session/review');
    },

    mock: {
      async advanceFeed() {
        await initialized;
        if (remaining <= 0) return false;
        const result = await post<{ remaining: number }>('/api/session/demo/advance');
        remaining = result.remaining;
        return true;
      },
      remainingFeedSteps() {
        return remaining;
      },
    },
  };
}
