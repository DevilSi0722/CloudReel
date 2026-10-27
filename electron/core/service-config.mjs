import fs from 'node:fs';
import path from 'node:path';

// A distributor registers one app, then supplies its public OAuth configuration
// at build time. No borrowed application identity or client secret is bundled.
export function serviceConfig(root, env = process.env) {
  const file = path.join(root, 'config', 'services.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { trakt: { clientId: env.CLOUDREEL_TRAKT_CLIENT_ID || config.trakt?.clientId || '', redirectUri: env.CLOUDREEL_TRAKT_REDIRECT_URI || config.trakt?.redirectUri || '' }, tmdbToken: env.CLOUDREEL_TMDB_TOKEN || '' };
}
