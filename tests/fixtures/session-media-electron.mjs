import {app, net, session, BrowserWindow} from 'electron';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fetchSessionMedia} from '../../electron/services/session-media.mjs';
import {createStreamRelay} from '../../electron/services/stream.mjs';

app.setName('CloudReel-Media-Regression');
app.setPath('userData',path.join(process.env.CLOUDREEL_TEST_DIRECTORY,'profile'));
let proxy, relay;
app.whenReady().then(async()=>{
  const requests=[];let downloads=0, cancelled=false;
  proxy=http.createServer((req,res)=>{
    const url=new URL(req.url);requests.push({host:url.hostname,path:url.pathname,cookie:req.headers.cookie,ua:req.headers['user-agent'],range:req.headers.range,referer:req.headers.referer});
    if(url.pathname==='/api'){res.end('api');return;}
    if(url.pathname==='/start'){res.writeHead(302,{location:'http://cdn.media-test.test/seed','set-cookie':'LOGIN_REFRESH=fresh; Path=/'}).end();return;}
    if(url.pathname==='/seed'){res.writeHead(302,{location:'http://cdn.media-test.test/bytes','set-cookie':'CDN_SESSION=cdn-only; Path=/'}).end();return;}
    if(url.pathname==='/bad'){res.writeHead(302,{location:'http://untrusted.invalid/'}).end();return;}
    if(url.pathname==='/slow'){
      res.writeHead(200,{'content-type':'video/mp4'});res.write('start');const timer=setInterval(()=>res.write('chunk'),20);
      res.on('close',()=>{clearInterval(timer);cancelled=true;});return;
    }
    if(url.pathname==='/retry'&&url.searchParams.get('ticket')==='old'){res.writeHead(403).end('expired');return;}
    assert.equal(req.headers.range,'bytes=3-9');
    const bytes=Buffer.from('3456789');res.writeHead(206,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="movie.mkv"','content-length':bytes.length,'content-range':'bytes 3-9/100','accept-ranges':'bytes'});
    res.end(req.method==='HEAD'?undefined:bytes);
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const browser=session.fromPartition('cloudreel-media-regression');browser.setUserAgent('CloudReelIsolatedMediaTest/1');
  browser.on('will-download',event=>{downloads++;event.preventDefault();});
  await browser.setProxy({proxyRules:`http=127.0.0.1:${proxy.address().port}`});
  await browser.cookies.set({url:'http://login.media-test.test',name:'LOGIN_SESSION',value:'test-only',path:'/'});
  const allowed=value=>{try{const url=new URL(value);return url.protocol==='http:'&&['login.media-test.test','cdn.media-test.test'].includes(url.hostname);}catch{return false;}};
  const transport=(url,options)=>fetchSessionMedia(browser,url,options,input=>net.request(input),allowed);
  assert.equal(await (await browser.fetch('http://login.media-test.test/api',{credentials:'include'})).text(),'api');
  const result=await transport('http://login.media-test.test/start',{headers:{Range:'bytes=3-9',Cookie:'foreign=must-not-leak'}});
  assert.equal(result.status,206);assert.equal(await result.text(),'3456789');assert.equal(result.headers.get('content-range'),'bytes 3-9/100');assert.equal(result.headers.has('set-cookie'),false);
  const first=requests.find(entry=>entry.path==='/start'),seed=requests.find(entry=>entry.path==='/seed'),bytes=requests.find(entry=>entry.path==='/bytes');
  assert.match(first.cookie,/LOGIN_SESSION=test-only/);assert.equal(seed.cookie,undefined);assert.equal(bytes.cookie,'CDN_SESSION=cdn-only');
  assert.equal(bytes.ua,first.ua);assert.equal(bytes.ua,requests[0].ua);
  assert.equal((await browser.cookies.get({url:'http://login.media-test.test'})).some(cookie=>cookie.name==='LOGIN_REFRESH'),true);
  // The real Baidu service supplies a full-path, cross-origin Referer. Without
  // an explicit compatible referrer policy Chromium cancels it before sending.
  await assert.rejects(fetchSessionMedia(browser,'http://cdn.media-test.test/bytes',{headers:{Range:'bytes=3-9',Referer:'http://login.media-test.test/disk/main'}},init=>{const {referrerPolicy,...oldOptions}=init;return net.request(oldOptions);},allowed),/ERR_BLOCKED_BY_CLIENT/);
  const original=await transport('http://cdn.media-test.test/bytes',{headers:{Range:'bytes=3-9',Referer:'http://login.media-test.test/disk/main','User-Agent':'pan.baidu.com'}});
  assert.equal(original.status,206);assert.equal(await original.text(),'3456789');
  assert.equal(requests.at(-1).referer,'http://login.media-test.test/disk/main');assert.equal(requests.at(-1).ua,'pan.baidu.com');
  const head=await transport('http://cdn.media-test.test/bytes',{method:'HEAD',headers:{Range:'bytes=3-9'}});assert.equal(head.status,206);assert.equal(await head.text(),'');
  await assert.rejects(transport('http://login.media-test.test/bad'),/不支持的地址/);
  assert.equal(requests.some(entry=>entry.host==='untrusted.invalid'),false);
  let refreshed=false;
  relay=await createStreamRelay(async({refresh})=>{refreshed ||= refresh;return `http://login.media-test.test/retry?ticket=${refresh?'new':'old'}`;},{fetcher:transport});
  const retried=await fetch(relay.url,{headers:{Range:'bytes=3-9'}});assert.equal(retried.status,206);assert.equal(await retried.text(),'3456789');assert.equal(refreshed,true);relay.close();relay=null;
  const controller=new AbortController(),slow=await transport('http://cdn.media-test.test/slow',{signal:controller.signal}),reader=slow.body.getReader();
  await reader.read();controller.abort();await assert.rejects(async()=>{while(!(await reader.read()).done){ /* Drain an already queued chunk before the abort error. */ }});reader.releaseLock();
  for(let i=0;i<40&&!cancelled;i++)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(cancelled,true);
  cancelled=false;
  const preflight=await transport('http://cdn.media-test.test/slow');await preflight.body.cancel();
  for(let i=0;i<40&&!cancelled;i++)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(cancelled,true,'range preflight/body cancellation must close the upstream');
  assert.equal(downloads,0);assert.equal(BrowserWindow.getAllWindows().length,0);
  console.log(JSON.stringify({sessionProxyUsed:true,crossOriginFullReferer:true,downloadUserAgent:true,rangeAndAttachmentStreamed:true,domainCookiesAndSetCookie:true,signedLinkRefresh:true,untrustedRedirectBlocked:true,abortStopsUpstream:true,visibleWindowsOpened:0}));
  proxy.closeAllConnections();proxy.close();app.quit();
}).catch(error=>{console.error(error.stack);relay?.close();proxy?.closeAllConnections();proxy?.close();app.exit(1);});
