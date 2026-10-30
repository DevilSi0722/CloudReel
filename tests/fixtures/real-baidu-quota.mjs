import {app, BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';
const root = process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const load = relative => import(pathToFileURL(path.join(root, 'electron', relative)).href);
const {createBaiduLogin} = await load('services/baidu-login.mjs');
const {BaiduQuotaMonitor} = await load('services/baidu-quota.mjs');
app.setName('CloudReel-Quota-Acceptance');app.setPath('userData', process.env.CLOUDREEL_TEST_DIRECTORY);
let stage = 'startup';
app.whenReady().then(async () => {
  const store = memoryStore();Object.assign(store.data.settings, {autoSync: false, autoRefresh: false, autoScrape: false});
  const login = createBaiduLogin(store, () => {}, () => null);
  stage = 'restore';await login.restore();assert.equal(login.service.connected, true);
  const originalFetch = login.service.fetcher, routes = [];
  login.service.fetcher = (input, options) => {
    const route = new URL(input).pathname;routes.push(route);
    assert.equal(route, '/api/quota');assert.ok(!options.method || options.method === 'GET');
    return originalFetch(input, options);
  };
  const before = JSON.stringify(store.data);
  stage = 'quota';const direct = await login.service.quota();
  assert.ok(direct.total > 0);assert.ok(direct.used >= 0);assert.equal(direct.available, Math.max(0, direct.total - direct.used));
  stage = 'monitor';const monitor = new BaiduQuotaMonitor({read: () => login.service.quota(), identity: () => 'isolated-account'});
  const quota = await monitor.refresh({force: true});assert.ok(quota.updatedAt);assert.equal(quota.error, null);assert.equal(quota.loading, false);
  assert.ok(quota.total > 0);assert.ok(quota.used >= 0);assert.equal(JSON.stringify(store.data), before);
  assert.equal(BrowserWindow.getAllWindows().some(window => window.isVisible()), false);
  console.log('REAL_QUOTA_RESULT ' + JSON.stringify({passed: true, authenticatedQuota: true, monitor: true, validByteCounts: true, readOnlyRequests: routes.length, originalProfileWrites: 0, visibleWindowsOpened: 0}));
  monitor.stop();app.quit();
}).catch(error => {
  console.log('REAL_QUOTA_RESULT ' + JSON.stringify({passed: false, stage, errorType: error.name, http: Number(error.status) || undefined, code: /^-?\d+$/.test(String(error.code)) ? Number(error.code) : undefined}));
  app.exit(1);
});
