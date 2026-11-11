import qrcode from 'qrcode-generator';
import { pairingQrPayload } from './pairing-qr-payload.mjs';

const QUIET_MODULES = 4;
const BLACK_ON_WHITE = '\u001b[30;47m';
const RESET = '\u001b[0m';

function fitsTerminal(width, columns) {
  // Leave one column free: some terminals wrap immediately at the last column.
  return Number.isInteger(columns) && columns > width;
}

function isDarkModule(qr, row, column) {
  const size = qr.getModuleCount();
  if (row < 0 || column < 0 || row >= size || column >= size) return false;
  return qr.isDark(row, column);
}

function halfBlock(top, bottom) {
  if (top && bottom) return '█';
  if (top) return '▀';
  if (bottom) return '▄';
  return ' ';
}

/** Fixed black/white terminal QR, independent of the operator's terminal theme. */
export function renderPairingQr(pairing, { columns = 80 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(pairingQrPayload(pairing), 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  if (!fitsTerminal(size + QUIET_MODULES * 2, columns)) return null;
  const lines = [];
  for (let row = -QUIET_MODULES; row < size + QUIET_MODULES; row += 2) {
    let line = '';
    for (let column = -QUIET_MODULES; column < size + QUIET_MODULES; column++) {
      line += halfBlock(isDarkModule(qr, row, column), isDarkModule(qr, row + 1, column));
    }
    lines.push(`${BLACK_ON_WHITE}${line}${RESET}`);
  }
  return lines.join('\n');
}
