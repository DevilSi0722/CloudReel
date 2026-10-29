import {app, BrowserWindow} from 'electron';
import {ResearchBrowser} from './browser.mjs';
import {BaiduShareService} from '../../electron/services/baidu-share.mjs';
import {SEEDHUB_ORIGIN, DiscoveryError, seedHubUrl, catalogFromSnapshot, detailFromSnapshot, resourcesFromSnapshot, sharePageState} from './model.mjs';

app.setName('CloudReel-Discovery-Research');
app.setPath('userData', process.env.CLOUDREEL_DISCOVERY_TEST_DIRECTORY);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});

const report = {readOnly: true, originalProfileAccess: false, transferAttempted: false, stages: []};
const stage = entry => { report.stages.push(entry); console.log('SEEDHUB_RESEARCH_PROGRESS ' + JSON.stringify(entry)); };
let website, baidu;
async function run() {
  try {
    website = new ResearchBrowser(SEEDHUB_ORIGIN);
    stage({stage: 'started'});
    try {
      const response = await website.session.fetch(SEEDHUB_ORIGIN, {signal: AbortSignal.timeout(15000), redirect: 'manual'});
      stage({stage: 'http', status: response.status, challenge: response.headers.get('cf-mitigated') === 'challenge'});
      void response.body?.cancel().catch(() => {});
    } catch { stage({stage: 'http', state: 'network-error'}); }
    const home = await website.page(SEEDHUB_ORIGIN);
    stage({stage: 'browser', status: home.status, challenge: /Just a moment|Checking your browser/i.test(home.title)});
    const catalog = catalogFromSnapshot(home);
    stage({stage: 'catalog', status: home.status, movies: catalog.movies.length, posterHosts:[...new Set(catalog.movies.flatMap(movie=>movie.poster?[new URL(movie.poster).hostname]:[]))], pagination: Boolean(catalog.next), searchForm: home.forms.some(form => form.fields.some(field => /search|keyword|^q$|^s$/i.test(field)))});
    if (!catalog.movies.length) throw new DiscoveryError('empty-catalog', '没有识别到作品列表。');
    if (catalog.next) {
      const next = catalogFromSnapshot(await website.page(catalog.next));
      const firstIds = new Set(catalog.movies.map(movie => movie.id));
      stage({stage: 'pagination', movies: next.movies.length, newMovies: next.movies.filter(movie => !firstIds.has(movie.id)).length});
    }
    const category = catalogFromSnapshot(await website.page(seedHubUrl('/categories/3/movies/')));
    stage({stage: 'category', movies: category.movies.length});
    const search = await website.search('硅谷');
    if (search.snapshot) {
      const results = catalogFromSnapshot(search.snapshot), route = new URL(search.snapshot.url);
      stage({stage: 'search', state: search.state, path: route.pathname, parameterNames: [...route.searchParams.keys()], movies: results.movies.length});
    } else stage({stage: 'search', state: search.state, ...(search.host ? {host: search.host} : {})});
    let found;
    // A bounded sample; do not crawl the catalog or check every share link.
    for (const movie of catalog.movies.slice(0, 2)) {
      const detail = detailFromSnapshot(await website.page(movie.url));
      stage({stage: 'detail', resources: detail.resources.length});
      for (const candidate of detail.resources.slice(0, 3)) {
        const snapshot = await website.page(seedHubUrl(candidate.url));
        const resolved = resourcesFromSnapshot(snapshot);
        stage({stage: 'resolve', providers: [...new Set(resolved.map(resource => resource.provider))], decodedQRCodes: snapshot.qrLinks.length});
        found = resolved.find(resource => resource.provider === 'baidu');
        if (found) break;
      }
      if (found) break;
    }
    if (!found) throw new DiscoveryError('no-baidu-in-sample', '本次样本未解析到百度资源。');
    baidu = new ResearchBrowser('https://pan.baidu.com');
    const {snapshot: preview, submittedCode} = await baidu.previewShare(found.url);
    const previewState = sharePageState(preview);
    if (process.argv.includes('--share-api')) {
      const store = {data:{},persist(){}};
      const service = new BaiduShareService({store,web:{connected:false},browserSession:baidu.session,createBrowser:() => baidu});
      const result = await service.inspect(found.url);
      stage({stage:'share-api',rootFiles:result.files.length,hasMore:result.hasMore});
      const folder = result.files.find(file => Number(file.isdir) === 1);
      if (folder) {const children = await service.list({handle:result.handle,directory:folder.path,page:1});stage({stage:'share-api-folder',files:children.files.length,hasMore:children.hasMore});}
    }
    if (process.argv.includes('--inspect-share')) {
      const metadata = await baidu.window.webContents.executeJavaScript(`(() => {
        const data = window.yunData || {}, local = window.locals;
        const get = key => {try {return local?.get?.(key);} catch {return null;}};
        return {yunKeys:Object.keys(data).slice(0,50), localsGet:typeof local?.get==='function',
          fields: Object.fromEntries(['shareid','share_id','uk','share_uk','file_list','filelist','bdstoken'].map(key => {const value = get(key) ?? data[key];return [key, Array.isArray(value)?'array:'+value.length:typeof value];})),
          inlineShareId: [...document.scripts].some(script => /["']shareid["']\\s*:/.test(script.textContent))};
      })()`);
      stage({stage:'share-metadata', ...metadata});
    }
    stage({stage: 'share-preview', passwordInLink: Boolean(found.share.password), submittedCode, state: previewState, visibleFileRows: preview.fileRows});
    if (previewState !== 'files-visible') throw new DiscoveryError('share-' + previewState, '分享预览没有确认可见文件。');
    report.result = 'read-only-preview-passed';
  } catch (error) {
    // Never serialize provider errors, DOM, URLs, share codes or session state.
    report.result = 'blocked';
    report.reason = error instanceof DiscoveryError ? error.code : 'network-or-browser-error';
  } finally {
    report.visibleWindows = BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
    await baidu?.close().catch(() => {});
    await website?.close().catch(() => {});
    await new Promise(resolve => process.stdout.write('SEEDHUB_RESEARCH_RESULT ' + JSON.stringify(report) + '\n', resolve));
    app.exit(report.visibleWindows ? 1 : 0);
  }
}
// Awaiting whenReady at ESM top level prevents Electron's main-module startup
// from completing. Register the callback without blocking module evaluation.
void app.whenReady().then(run).catch(() => app.exit(1));
