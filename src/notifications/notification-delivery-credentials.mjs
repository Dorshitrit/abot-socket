import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { isAbsolute } from 'node:path';

const MAX_CREDENTIAL_BYTES = 32 * 1024;

function isPrivateCredentialFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CREDENTIAL_BYTES) return false;
  if ((stat.mode & 0o7777) !== 0o600) return false;
  return typeof process.getuid === 'function' && stat.uid === process.getuid();
}

function parseServiceAccount(json) {
  if (!json || json.type !== 'service_account') throw new Error();
  if (typeof json.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(json.project_id)) throw new Error();
  if (typeof json.client_email !== 'string' || json.client_email.length > 254 ||
      !/^[A-Za-z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(json.client_email)) throw new Error();
  if (typeof json.private_key !== 'string' || json.private_key.length > 16 * 1024) throw new Error();
  const key = createPrivateKey(json.private_key);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error();
  return { projectId: json.project_id, clientEmail: json.client_email, key };
}

/** Never use token_uri or any URL from a credential file as a network destination. */
export function loadFcmServiceAccount(path) {
  let descriptor;
  try {
    if (!isAbsolute(path)) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!isPrivateCredentialFile(before)) throw new Error();
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_CREDENTIAL_BYTES) throw new Error();
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size) throw new Error();
    return parseServiceAccount(JSON.parse(buffer.toString('utf8', 0, bytes)));
  } catch {
    throw new Error('FCM credentials require a valid private service-account file owned by this user with mode 0600');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
