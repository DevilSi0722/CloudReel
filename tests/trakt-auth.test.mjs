import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isTraktCallback, isTraktPage, traktRedirect} from '../electron/core/trakt-auth.mjs';
import {TraktService} from '../electron/services/trakt.mjs';
import {memoryStore} from './helpers.mjs';

test('publisher defaults enable sign-in without any user application settings; incomplete builds stay unavailable',()=>{
  const store=memoryStore();store.data.settings.traktClientId='';store.data.settings.traktRedirectUri='';
  const service=new TraktService(store,{clientId:'publisher-app',redirectUri:'https://example.com/trakt/callback'});
  assert.ok(service.configured());const url=new URL(service.beginAuth().url);
  assert.equal(url.searchParams.get('client_id'),'publisher-app');assert.equal(store.data.settings.traktClientId,'');
  assert.equal(new TraktService(store).configured(),false);
  assert.throws(()=>new TraktService(store).beginAuth(),/登录尚未启用/);
  assert.equal(new TraktService(store,{clientId:'publisher-app',redirectUri:'http://localhost/callback'}).configured(),false);
});

test('authorization confines navigation to official pages and exactly the registered HTTPS callback',()=>{
  assert.ok(isTraktPage('https://auth.trakt.tv/oauth/authorize'));assert.ok(isTraktPage('https://app.trakt.tv/auth/signin'));
  for(const url of ['https://trakt.tv.evil.test','https://trakt.tv@evil.test','http://trakt.tv','https://user:pass@trakt.tv'])assert.equal(isTraktPage(url),false);
  const callback='https://example.com/trakt/callback';assert.ok(isTraktCallback(callback+'?code=a&state=b',callback));
  for(const url of ['https://example.com/trakt/callback/extra','https://example.com.evil.test/trakt/callback','https://user:pass@example.com/trakt/callback','http://example.com/trakt/callback'])assert.equal(isTraktCallback(url,callback),false);
  for(const url of ['cloudreel://callback','https://localhost/callback','https://example.com/callback?token=a','https://user:pass@example.com/callback'])assert.throws(()=>traktRedirect(url));
});

test('denied and expired sign-ins never exchange codes or save credentials',async()=>{
  let requests=0;const store=memoryStore(),service=new TraktService(store,{fetcher:async()=>{requests++;throw new Error('must not request');}});
  const url=new URL(service.beginAuth().url),state=url.searchParams.get('state');
  await assert.rejects(service.completeAuth(`https://example.com/callback?error=access_denied&state=${state}`),/取消 Trakt 授权/);
  assert.equal(service.authorization,null);assert.equal(requests,0);assert.equal(store.secret('traktToken'),null);
  service.beginAuth();service.authorization.expires=Date.now()-1;
  await assert.rejects(service.completeAuth('https://example.com/callback?code=a&state=b'),/过期/);assert.equal(requests,0);
});

test('a delayed token refresh cannot restore a disconnected Trakt account',async()=>{
  const store=memoryStore();store.setSecret('traktToken',{access_token:'old',refresh_token:'old-refresh'});let complete;
  const service=new TraktService(store,{fetcher:async()=>new Promise(resolve=>{complete=resolve;})});
  const pending=service.refresh();store.setSecret('traktToken',null);
  complete(new Response(JSON.stringify({access_token:'late',refresh_token:'late-refresh',expires_in:3600})));
  await assert.rejects(pending,/连接已更改/);assert.equal(store.secret('traktToken'),null);
});
