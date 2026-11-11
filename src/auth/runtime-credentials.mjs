import { createHash, timingSafeEqual } from 'node:crypto';

export const digestToken = (token) => createHash('sha256').update(token).digest('hex');

export function validateRuntimeGrants(grants) {
  if (!Array.isArray(grants) || grants.length < 1 || grants.length > 16) {
    throw new Error('Configure 1 to 16 runtime grants');
  }
  const ids = new Set();
  const digests = new Set();
  return grants.map((grant) => {
    if (!grant || !/^[A-Za-z0-9_.:-]{1,128}$/.test(grant.runtimeId ?? '') ||
        !/^[a-f0-9]{64}$/.test(grant.tokenSha256 ?? '') ||
        ids.has(grant.runtimeId) || digests.has(grant.tokenSha256)) {
      throw new Error('Invalid or duplicate runtime grant');
    }
    const allowedModes = grant.allowedModes ?? ['ask'];
    if (!Array.isArray(allowedModes) || !allowedModes.includes('ask') ||
        allowedModes.some((mode) => !['ask', 'full_access', 'full_plus'].includes(mode))) {
      throw new Error('Invalid runtime permission ceiling');
    }
    ids.add(grant.runtimeId);
    digests.add(grant.tokenSha256);
    return Object.freeze({ runtimeId: grant.runtimeId, tokenSha256: grant.tokenSha256,
      allowedModes: Object.freeze([...new Set(allowedModes)]) });
  });
}

export function resolveRuntimeCredential(authorization, grants) {
  if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization)) {
    return null;
  }
  const digest = Buffer.from(digestToken(authorization.slice(7)), 'hex');
  let match = null;
  for (const grant of grants) {
    if (timingSafeEqual(digest, Buffer.from(grant.tokenSha256, 'hex'))) match = grant;
  }
  return match;
}
