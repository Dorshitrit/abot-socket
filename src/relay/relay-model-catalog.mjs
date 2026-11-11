const MODALITIES = new Set(['text', 'image', 'audio']);
const EXECUTION_POLICIES = new Set(['supervisor-worker-v1', 'execution-agent-v1']);

function invalidCatalog() {
  throw Object.assign(new Error('invalid_model_catalog'), { code: 'invalid_model_catalog' });
}

function catalogRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidCatalog();
  return value;
}

function catalogString(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalidCatalog();
  if (/[\u0000-\u001f\u007f]/u.test(value)) invalidCatalog();
  return value;
}

function catalogBoolean(value) {
  if (typeof value !== 'boolean') invalidCatalog();
  return value;
}

function catalogModalities(value) {
  if (!Array.isArray(value) || value.length > 3 || value.some(item => !MODALITIES.has(item))) invalidCatalog();
  return [...new Set(value)];
}

function catalogCapabilities(value) {
  catalogRecord(value);
  const result = {};
  for (const key of ['inputModalities', 'outputModalities']) {
    if (value[key] !== undefined) result[key] = catalogModalities(value[key]);
  }
  return result;
}

function catalogProfile(value) {
  catalogRecord(value);
  const result = { id: catalogString(value.id, 160), label: catalogString(value.label, 240) };
  // Mirror display/capability fields projected by loadRuntimeModelCatalog, never provider config.
  for (const [field, maximum] of [['providerId', 160], ['provider', 160], ['model', 512]]) {
    if (value[field] !== undefined) result[field] = catalogString(value[field], maximum);
  }
  for (const field of ['supportsThinking', 'supportsImageInput']) {
    if (value[field] !== undefined) result[field] = catalogBoolean(value[field]);
  }
  if (value.executionPolicy !== undefined) {
    if (!EXECUTION_POLICIES.has(value.executionPolicy)) invalidCatalog();
    result.executionPolicy = value.executionPolicy;
  }
  if (value.reasoningControls !== undefined) {
    catalogRecord(value.reasoningControls);
    result.reasoningControls = { budgetTokens: catalogBoolean(value.reasoningControls.budgetTokens) };
  }
  if (value.capabilities !== undefined) result.capabilities = catalogCapabilities(value.capabilities);
  return result;
}

export function parseRuntimeModelCatalog(value) {
  catalogRecord(value);
  if (value.schemaVersion !== 1) invalidCatalog();
  const defaultProfileId = catalogString(value.defaultProfileId, 160);
  if (!Array.isArray(value.profiles) || value.profiles.length === 0 || value.profiles.length > 128) invalidCatalog();
  const profiles = value.profiles.map(catalogProfile);
  const ids = new Set(profiles.map(profile => profile.id));
  if (ids.size !== profiles.length || !ids.has(defaultProfileId)) invalidCatalog();
  return { schemaVersion: 1, defaultProfileId, profiles };
}
