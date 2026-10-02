// Acceso a la IA detrás de una interfaz chica: structured({ system, content, schema }) → datos validados.
// El resto del sistema no sabe qué proveedor ni qué modelo hay detrás (config/index.js → AI_MODEL).
//
// - Salida estructurada (output_config.format con JSON Schema generado desde zod) + validación zod.
// - Timeout por request. Reintento sólo ante errores transitorios, y con el modelo alternativo.
// - Si el modelo declina (stop_reason "refusal") o se corta por max_tokens, también se prueba el alternativo.
const Anthropic = require("@anthropic-ai/sdk");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
const config = require("../config");
const { logger } = require("../observability/logger");

class AIError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message);
    this.code = code; // "unavailable" | "timeout" | "invalid_output" | "refused" | "config"
    this.retryable = retryable;
    this.cause = cause;
  }
}

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ timeout: config.ai.timeoutMs, maxRetries: 0 });
  }
  return client;
}

// Para tests: inyectar un cliente falso.
function setClient(c) {
  client = c;
}

function classify(err) {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AIError("timeout", "La IA no respondió a tiempo", { retryable: true, cause: err });
  if (err instanceof Anthropic.RateLimitError) return new AIError("unavailable", "Límite de uso de la IA", { retryable: true, cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AIError("config", "Credenciales de IA inválidas", { cause: err });
  }
  if (err instanceof Anthropic.NotFoundError) return new AIError("config", "Modelo de IA no disponible", { retryable: true, cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new AIError("unavailable", "Sin conexión con la IA", { retryable: true, cause: err });
  if (err instanceof Anthropic.APIError && (err.status >= 500 || err.status === 529)) {
    return new AIError("unavailable", "IA saturada", { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.BadRequestError) return new AIError("invalid_request", err.message, { cause: err });
  return new AIError("unknown", err && err.message ? err.message : String(err), { cause: err });
}

async function callOnce(model, { system, content, schema, maxTokens }) {
  const response = await getClient().messages.parse({
    model,
    max_tokens: maxTokens || config.ai.maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: config.ai.effort, format: zodOutputFormat(schema) },
  });
  if (response.stop_reason === "refusal") throw new AIError("refused", "El modelo declinó la solicitud", { retryable: true });
  if (response.stop_reason === "max_tokens") throw new AIError("invalid_output", "Respuesta cortada por longitud", { retryable: true });
  // parse() valida contra el schema; si no valida, parsed_output es null.
  const data = response.parsed_output;
  if (!data) throw new AIError("invalid_output", "La respuesta no cumple el formato esperado", { retryable: true });
  const check = schema.safeParse(data);
  if (!check.success) throw new AIError("invalid_output", "La respuesta no cumple el formato esperado", { retryable: true });
  return { data: check.data, usage: response.usage, model };
}

async function structured({ task, system, content, schema, maxTokens }) {
  if (!config.ai.enabled) throw new AIError("config", "IA desactivada (AI_DISABLED=1)");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !client) {
    throw new AIError("config", "Falta ANTHROPIC_API_KEY");
  }
  const models = [...new Set([config.ai.model, config.ai.fallbackModel].filter(Boolean))];
  let lastErr = null;
  for (const model of models) {
    const started = Date.now();
    try {
      const out = await callOnce(model, { system, content, schema, maxTokens });
      logger.info("ai_call", { task, model, ms: Date.now() - started, input_tokens: out.usage.input_tokens,
        output_tokens: out.usage.output_tokens, cache_read: out.usage.cache_read_input_tokens || 0 });
      return out;
    } catch (e) {
      lastErr = classify(e);
      logger.warn("ai_call_failed", { task, model, ms: Date.now() - started, code: lastErr.code, status: e && e.status });
      if (!lastErr.retryable) break;
    }
  }
  throw lastErr;
}

module.exports = { structured, AIError, setClient };
