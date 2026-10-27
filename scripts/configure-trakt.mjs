import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {traktRedirect} from '../electron/core/trakt-auth.mjs';

// Publisher-only setup. Client ID is public; no Client Secret is accepted or saved.
const args = process.argv.slice(2), values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--client-id', '--redirect-uri'].includes(args[i]) || !args[i + 1]) throw new Error('用法：npm run configure:trakt -- --client-id CLIENT_ID --redirect-uri HTTPS_CALLBACK');
  values[args[i]] = args[i + 1].trim();
}
const clientId = values['--client-id'] || process.env.CLOUDREEL_TRAKT_CLIENT_ID || '';
const redirectUri = values['--redirect-uri'] || process.env.CLOUDREEL_TRAKT_REDIRECT_URI || '';
if (!/^[A-Za-z0-9_-]{16,256}$/.test(clientId)) throw new Error('请提供为 CloudReel 登记的 Trakt Client ID。');
traktRedirect(redirectUri);
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/services.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
config.trakt = {clientId, redirectUri};
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log('Trakt 发行配置已保存。重新打包后，用户只需点击登录并在官方页面授权。');
