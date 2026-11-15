import type { ReasoningInput, ReasoningProvider } from '../../reasoning/contracts.mts';
import { promptData, RESPONSE_SCHEMA, SYSTEM_INSTRUCTION } from '../../reasoning/prompt.mts';

export interface GeminiOptions {
  apiKey: string;
  /** Explicit account-supported model; no guessed/default model version. */
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Content-free diagnostics only; never exposes prompts, responses or credentials. */
  onDiagnostic?: (event: { code: 'http_error' | 'network_error' | 'invalid_response' | 'incomplete_response'; status?: number; finishReason?: 'MAX_TOKENS' | 'SAFETY' | 'OTHER' }) => void;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Gemini response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 131_072) { await reader.cancel(); throw Error('Oversized Gemini response'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Error('Invalid Gemini response JSON'); }
}

/** Official generateContent REST transport. No runtime SDK dependency, retries, tools or logging. */
export function createGeminiProvider(options: GeminiOptions): ReasoningProvider {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) throw Error('GEMINI_API_KEY is required');
  if (!/^gemini-[A-Za-z0-9._-]+$/.test(options.model)) throw Error('GEMINI_MODEL must be an explicit Gemini model ID');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw Error('Invalid Gemini timeout');
  const send = options.fetchImpl ?? fetch;
  const report = (event: Parameters<NonNullable<GeminiOptions['onDiagnostic']>>[0]) => {
    try { options.onDiagnostic?.(event); } catch { /* Diagnostics cannot affect inference. */ }
  };
  return {
    async generate(input: ReasoningInput, signal?: AbortSignal) {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(promptData(input)) }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA, maxOutputTokens: 4096 }
      });
      if (new TextEncoder().encode(body).length > 262_144) throw Error('Oversized Gemini request');
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await send(`https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey }, body
        });
      } catch { report({ code: 'network_error' }); throw Error('Gemini request failed or was cancelled'); }
      if (!response.ok) {
        await response.body?.cancel();
        report({ code: 'http_error', status: response.status });
        // Never expose provider response bodies, headers, prompts or credentials in errors.
        throw Error(`Gemini HTTP ${response.status}`);
      }
      const data = await boundedJson(response).catch(() => { report({ code: 'invalid_response' }); throw Error('Invalid Gemini response'); }) as {
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      };
      if (!data || data.promptFeedback?.blockReason || !Array.isArray(data.candidates) || data.candidates.length !== 1) { report({ code: 'invalid_response' }); throw Error('Gemini returned no usable candidate'); }
      const candidate = data.candidates[0]!;
      if (candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) {
        const finishReason = ['MAX_TOKENS', 'SAFETY', 'OTHER'].includes(candidate.finishReason ?? '')
          ? candidate.finishReason as 'MAX_TOKENS' | 'SAFETY' | 'OTHER' : undefined;
        report({ code: 'incomplete_response', ...(finishReason ? { finishReason } : {}) });
        throw Error('Gemini output blocked or incomplete');
      }
      const parts = candidate.content.parts.filter(p => p.thought !== true);
      if (!parts.length || parts.some(p => typeof p.text !== 'string')) { report({ code: 'invalid_response' }); throw Error('Gemini returned non-text output'); }
      try { return JSON.parse(parts.map(p => p.text).join('')); }
      catch { report({ code: 'invalid_response' }); throw Error('Gemini did not return structured JSON'); }
    }
  };
}
