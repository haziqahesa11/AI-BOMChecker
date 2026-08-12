// Thin client for Ollama's REST API — same "external HTTP API, config via
// config/credentials/*.env, throw a clear typed error if unreachable" shape as
// services/tpaHistoryService.js and services/moApiClient.js.
//
// Ollama runs on NEXAi, a separate host from wherever this backend runs (see
// config/credentials/ollama.env.example) — reachable in the app's live deployment,
// not necessarily from every dev machine. Callers (services/aiPredictionService.js)
// treat OllamaUnavailableError as a soft failure: the rest of a response still
// renders, just without the generated narrative — never a 500 for the whole request.

class OllamaUnavailableError extends Error {}

const REQUEST_TIMEOUT_MS = 30_000;

// Ollama's /api/generate with stream:false returns the full completion in one
// response body (field `response`) instead of newline-delimited chunks — simplest
// integration for a single request/response narrative, no SSE plumbing needed on
// either end.
async function generate(prompt) {
  const baseUrl = (process.env.OLLAMA_BASE_URL || '').trim();
  const model = (process.env.OLLAMA_MODEL || '').trim();
  if (!baseUrl || !model) {
    throw new OllamaUnavailableError(
      'OLLAMA_BASE_URL / OLLAMA_MODEL are not configured (config/credentials/ollama.env)'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new OllamaUnavailableError(`Could not reach Ollama at ${baseUrl}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OllamaUnavailableError(`Ollama request failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  const body = await response.json();
  if (!body.response) {
    throw new OllamaUnavailableError('Ollama returned an empty response.');
  }
  return body.response.trim();
}

module.exports = { generate, OllamaUnavailableError };
