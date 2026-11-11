function formError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

export async function readReviewPairingForm(req) {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (contentType !== 'application/x-www-form-urlencoded') throw formError('invalid_content_type', 415);
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 4096)) {
    throw formError('payload_too_large', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw formError('payload_too_large', 413);
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if ([...form.keys()].some(key => key !== 'csrf') || form.getAll('csrf').length !== 1) {
    throw formError('invalid_form', 400);
  }
  return form.get('csrf');
}
