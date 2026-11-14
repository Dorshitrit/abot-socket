import { id, string, fail } from './protocol-validation.mjs';

export const SPARK_SESSION_ID = 'spark-companion';
export const SPARK_CHAT_FEATURE = 'spark_chat_v1';
export const SPARK_OPEN_REQUEST = 'spark.chat.open.request';
export const SPARK_OPEN_RESPONSE = 'spark.chat.open.response';

const MODES = new Set(['ask', 'full_access', 'full_plus']);
const READINESS = new Set(['ready', 'model_required', 'model_unavailable']);
const ERRORS = new Set(['invalid_spark_chat_request', 'spark_chat_session_unavailable',
  'spark_chat_model_required', 'spark_chat_model_unavailable', 'spark_chat_permission_mismatch',
  'spark_chat_unsupported', 'spark_chat_unavailable']);

export function supportsSparkChat(runtime) {
  if (runtime === undefined) return true;
  if (runtime.online !== true) return false;
  return Array.isArray(runtime.features) && runtime.features.includes(SPARK_CHAT_FEATURE);
}

function isSparkChatCommand(command) {
  if (command.type === SPARK_OPEN_REQUEST) return true;
  return command.type === 'run_request' && command.sessionId === SPARK_SESSION_ID;
}

/** The existing authenticated runtime grant remains the authority ceiling. */
export function assertSparkChatSupported(command, runtime) {
  if (!isSparkChatCommand(command)) return;
  if (!runtime.features.includes(SPARK_CHAT_FEATURE)) fail('spark_chat_unsupported');
}

function projectSparkChatState(body) {
  if (body.sessionId !== SPARK_SESSION_ID) fail();
  if (!MODES.has(body.toolPermissionMode) || !READINESS.has(body.readiness)) fail();
  const modelProfileId = body.modelProfileId === null ? null : string(body.modelProfileId, 256);
  if ((modelProfileId === null) !== (body.readiness === 'model_required')) fail();
  return { sessionId: SPARK_SESSION_ID, modelProfileId,
    toolPermissionMode: body.toolPermissionMode, readiness: body.readiness };
}

/** Only chat state crosses the relay; preferences and private diagnostics never do. */
export function projectSparkOpenResponse(body) {
  try {
    if (!body || body.type !== SPARK_OPEN_RESPONSE || typeof body.ok !== 'boolean') return null;
    const result = { type: SPARK_OPEN_RESPONSE, correlationId: id(body.correlationId), ok: body.ok };
    if (body.ok) return { ...result, ...projectSparkChatState(body) };
    if (!ERRORS.has(body.error)) return null;
    return { ...result, error: body.error };
  } catch {
    return null;
  }
}
