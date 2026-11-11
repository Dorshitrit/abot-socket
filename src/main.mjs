import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfiguration } from './config/config.mjs';
import { createSocketServer } from './transport/server.mjs';

export async function startConfiguredServer(env = process.env) {
  const config = loadConfiguration(env);
  const app = createSocketServer(config);
  try { await app.listen(config.port); }
  catch (error) { await app.close(); throw error; }
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const app = await startConfiguredServer();
    console.log('ABot Socket listening on loopback behind the configured HTTPS reverse proxy.');
    const stop = () => { void app.close(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    // Configuration/provider errors can contain secrets; never print them here.
    console.error('ABot Socket could not start. Check private configuration, state permissions and listener availability.');
    process.exitCode = 1;
  }
}
