import { renderPairingQr } from '../pairing/pairing-qr.mjs';

function canDisplayPairingQr({ isTTY, term }) {
  return isTTY === true && term !== 'dumb';
}

function printTerminalPairing(pairing, out, { columns, renderQr = renderPairingQr }) {
  try {
    const qr = renderQr(pairing, { columns });
    if (!qr) {
      out('The terminal is too narrow for this QR. Widen it and run pair again, or use the details below.');
      return;
    }
    out('Scan this QR inside ABot, then confirm your server address. Keep it private.');
    out(qr);
  } catch {
    // Rendering cannot replace an issued challenge or hide the manual path.
    out('QR display is unavailable. Use the same pairing details below.');
  }
}

export function printPairing(pairing, out = console.log, options = {}) {
  if (canDisplayPairingQr(options)) printTerminalPairing(pairing, out, options);
  out('Pair your app: enter the 6-digit code, then the server URL and temporary pairing key.');
  out(JSON.stringify(pairing, null, 2));
  out('One use, valid for 5 minutes. If needed, run abot-socket pair again for fresh details.');
}

export function printInstallation(result, out = console.log, options = {}) {
  out(`Created private installation files in ${JSON.stringify(result.directory)}`);
  out('Keep runtime-connection.json private and transfer it only to its runtime computer.');
  out(`Configuration: ${JSON.stringify(result.configPath)}`);
  out('For a custom location, pass --config <that-file> to future commands.');
  printPairing(result.pairing, out, options);
}
