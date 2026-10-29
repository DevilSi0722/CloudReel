import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seedHubUrl, baiduShare, resourceProvider, catalogFromSnapshot, detailFromSnapshot, resourcesFromSnapshot, sharePageState} from '../experiments/seedhub/model.mjs';

const page = (anchors, rest = {}) => ({url: 'https://sidhub.cc/', status: 200, title: 'SeedHub', text: '', anchors, ...rest});

test('discovery URL validation rejects cross-origin and credential-bearing targets', () => {
  assert.equal(seedHubUrl('/categories/3/movies/?page=2'), 'https://sidhub.cc/categories/3/movies/?page=2');
  for (const url of ['https://sidhub.cc.attacker.test/', 'https://sidhub.cc@attacker.test/', 'https://user:password@sidhub.cc/', 'http://sidhub.cc/', '//attacker.test/', 'file:///C:/Windows', 'javascript:alert(1)']) assert.throws(() => seedHubUrl(url), {code: 'invalid-url'});
});

test('catalog combines poster and title links without duplicating movies or admitting foreign pages', () => {
  const result = catalogFromSnapshot(page([
    {href: '/movies/123/', image: 'https://images.example/poster.jpg'},
    {href: '/movies/123/', text: ' 示例  电影 '},
    {href: '/movies/123/#download', text: '资源下载'},
    {href: 'https://attacker.test/movies/999/', text: 'foreign'},
    {href: '/movies/124/', text: '第二部'},
    {href: '/?page=2', text: '下一页'}
  ]));
  assert.deepEqual(result.movies.map(movie => [movie.id, movie.title]), [['123', '示例 电影'], ['124', '第二部']]);
  assert.equal(result.movies[0].poster, 'https://images.example/poster.jpg');
  assert.equal(result.next, 'https://sidhub.cc/?page=2');
});

test('pagination does not change category, sort or jump ahead', () => {
  const url = 'https://sidhub.cc/categories/3/movies/?order=score&page=2';
  const result = catalogFromSnapshot(page([
    {href: '/categories/1/movies/?order=score&page=3'},
    {href: '/categories/3/movies/?order=date&page=3'},
    {href: '/categories/3/movies/?order=score&page=4'},
    {href: '/categories/3/movies/?order=score&page=3'}
  ], {url}));
  assert.equal(result.next, 'https://sidhub.cc/categories/3/movies/?order=score&page=3');
});

test('Cloudflare and HTTP failures cannot be reported as an empty successful catalog', () => {
  for (const snapshot of [page([], {status: 403}), page([], {status: 429}), page([], {title: 'Just a moment...'}), page([], {challenge: true})]) assert.throws(() => catalogFromSnapshot(snapshot), {code: 'verification-required'});
  assert.throws(() => detailFromSnapshot(page([], {status: 503})), {code: 'http-error'});
});

test('detail extracts deduplicated netdisk candidates without assuming pan_id means Baidu', () => {
  const detail = detailFromSnapshot(page([
    {href: '/link_start/?redirect_to=pan_id_10', text: '1080P'},
    {href: '/link_start/?redirect_to=pan_id_10', text: '重复'},
    {href: '/link_start/?redirect_to=magnet_id_20', text: '磁力'},
    {href: 'https://attacker.test/link_start/?redirect_to=pan_id_30', text: 'foreign'}
  ], {url: 'https://sidhub.cc/movies/123/', heading: '示例电影'}));
  assert.equal(detail.title, '示例电影');
  assert.deepEqual(detail.resources.map(resource => resource.id), ['pan_id_10']);
  assert.equal(detail.resources[0].provider, 'unknown');
});

test('resource annotations identify exact provider hosts before opening a share', () => {
  const detail=detailFromSnapshot(page([
    {href:'/link_start/?redirect_to=pan_id_1',text:'1080P',sourceHost:'pan.baidu.com'},
    {href:'/link_start/?redirect_to=pan_id_2',text:'另一个版本',sourceHost:'pan.quark.cn'},
    {href:'/link_start/?redirect_to=pan_id_3',sourceHost:'pan.xunlei.com'},
    {href:'/link_start/?redirect_to=pan_id_4',sourceHost:'www.alipan.com'},
    {href:'/link_start/?redirect_to=pan_id_5',sourceHost:'pan.baidu.com.attacker.test'},
    {href:'/link_start/?redirect_to=pan_id_6',sourceHost:'constructor'}
  ],{url:'https://sidhub.cc/movies/123/'}));
  assert.deepEqual(detail.resources.map(resource=>resource.provider),['baidu','quark','xunlei','alipan','unknown','unknown']);
});

test('redirect extraction trusts a valid link password even if the page claims it is missing', () => {
  const resources = resourcesFromSnapshot(page([
    {href: 'https://pan.baidu.com/s/1TEST_share'},
    {href: 'https://pan.baidu.com/s/1TEST_share?pwd=a1B2&tracking=discard'},
    {href: 'https://pan.xunlei.com/s/example'},
    {href: 'https://pan.baidu.com.attacker.test/s/1fake?pwd=a1B2'}
  ], {url: 'https://sidhub.cc/link_start/?redirect_to=pan_id_10', text: '百度网盘提取码丢失，请换一个链接'}));
  assert.deepEqual(resources.map(resource => resource.provider), ['baidu', 'xunlei']);
  assert.equal(resources[0].share.password, 'a1B2');
  assert.equal(resources[0].url, 'https://pan.baidu.com/s/1TEST_share?pwd=a1B2');
});

test('share normalization supports official init URLs and rejects unsafe or malformed targets', () => {
  assert.equal(baiduShare('https://pan.baidu.com/share/init?surl=TEST_share&pwd=a1B2').url, 'https://pan.baidu.com/s/1TEST_share?pwd=a1B2');
  for (const url of ['http://pan.baidu.com/s/1test', 'https://pan.baidu.com:444/s/1test', 'https://user:password@pan.baidu.com/s/1test', 'https://pan.baidu.com/other/1test', 'https://pan.baidu.com/s/1test?pwd=long-password', 'javascript:alert(1)']) assert.equal(baiduShare(url), null);
  assert.equal(resourceProvider('https://pan.xunlei.com/s/example'), 'xunlei');
  assert.equal(resourceProvider('https://pan.xunlei.com.attacker.test/s/example'), null);
});

test('QR-only resource pages identify the real provider and reject encoded unsafe targets', () => {
  const resources = resourcesFromSnapshot(page([], {qrLinks: [
    'https://pan.baidu.com/s/1TEST_qr?pwd=a1B2',
    'https://pan.baidu.com/s/1TEST_qr?pwd=a1B2',
    'https://pan.quark.cn/s/example',
    'javascript:alert(1)',
    'https://pan.baidu.com.attacker.test/s/1fake'
  ]}));
  assert.deepEqual(resources.map(resource => resource.provider), ['baidu', 'quark']);
  assert.equal(resources[0].share.password, 'a1B2');
});

test('share observation distinguishes unavailable, code, login and visible-file states', () => {
  assert.equal(sharePageState({text: '分享的文件已经被取消'}), 'unavailable');
  assert.equal(sharePageState({text: '请输入提取码'}), 'password-required');
  assert.equal(sharePageState({text: '请先登录'}), 'login-required');
  assert.equal(sharePageState({text: '安全验证'}), 'verification-required');
  assert.equal(sharePageState({text: '保存到网盘', fileRows: 2}), 'files-visible');
  assert.equal(sharePageState({text: '百度网盘'}), 'unrecognized-page');
});
