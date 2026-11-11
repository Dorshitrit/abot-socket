import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPairingQr } from '../src/pairing/pairing-qr.mjs';

const pairing = {
  serverUrl: 'https://socket.example.test', pairingId: 'q'.repeat(32),
  code: '000007', expiresAt: 1_800_000_300_000,
};

function moduleRows(rendered) {
  const rows = [];
  for (const line of rendered.split('\n')) {
    assert.ok(line.startsWith('\u001b[30;47m'));
    assert.ok(line.endsWith('\u001b[0m'));
    const cells = [...line.replace(/^\u001b\[30;47m|\u001b\[0m$/g, '')];
    assert.ok(cells.every(cell => [' ', '█', '▀', '▄'].includes(cell)));
    rows.push(cells.map(cell => cell === '█' || cell === '▀'));
    rows.push(cells.map(cell => cell === '█' || cell === '▄'));
  }
  return rows;
}

test('terminal QR retains a four-module white margin on all sides with explicit colors', () => {
  const rendered = renderPairingQr(pairing);
  assert.equal(typeof rendered, 'string');
  const rows = moduleRows(rendered);
  const width = rows[0].length;
  assert.ok(width < 80);
  assert.ok(rows.every(row => row.length === width));
  assert.ok(rows.flat().some(Boolean));
  for (const row of [...rows.slice(0, 4), ...rows.slice(-4)]) assert.ok(row.every(cell => !cell));
  for (const row of rows) {
    assert.ok(row.slice(0, 4).every(cell => !cell));
    assert.ok(row.slice(-4).every(cell => !cell));
  }
});

test('terminal QR refuses wrapping and invalid widths', () => {
  const rows = moduleRows(renderPairingQr(pairing));
  const width = rows[0].length;
  assert.equal(renderPairingQr(pairing, { columns: width }), null);
  assert.equal(renderPairingQr(pairing, { columns: width - 1 }), null);
  assert.equal(typeof renderPairingQr(pairing, { columns: width + 1 }), 'string');
  for (const columns of [0, -1, 80.5, NaN, Infinity, null, '80']) {
    assert.equal(renderPairingQr(pairing, { columns }), null);
  }
});

test('QR rendering neither mutates pairing details nor renders an invalid origin', () => {
  const frozen = Object.freeze({ ...pairing });
  renderPairingQr(frozen);
  assert.deepEqual(frozen, pairing);
  assert.throws(() => renderPairingQr({ ...pairing, serverUrl: 'https://user:secret@example.test' }),
    /Invalid pairing QR details/);
});
