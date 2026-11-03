import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

/** Load the repo's .env when it exists. CI sets the same variables as secrets instead. */
export function loadEnv() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

/** True when `importMetaUrl` is the script Node was started with. */
export function isMain(importMetaUrl) {
  return process.argv[1] === fileURLToPath(importMetaUrl);
}
