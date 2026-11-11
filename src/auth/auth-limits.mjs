import { createHash } from 'node:crypto';

export class AuthError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export function sourceKey(sourceId) {
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) {
    throw new AuthError('invalid_request', 400);
  }
  return createHash('sha256').update(sourceId).digest('hex');
}
