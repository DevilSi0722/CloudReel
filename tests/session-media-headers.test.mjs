import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {fetchSessionMedia} from '../electron/services/session-media.mjs';

function requestFixture(headers, statusCode=206) {
  const incoming=Readable.from([Buffer.from('original-media-bytes')]);
  Object.assign(incoming,{headers,statusCode});
  const request=new EventEmitter();let aborted=false;
  request.end=()=>queueMicrotask(()=>request.emit('response',incoming));
  request.abort=()=>{aborted=true;incoming.destroy();};
  return {factory:()=>request,incoming,aborted:()=>aborted};
}
const browser={getUserAgent:()=> 'isolated-test'},url='https://pcs.baidu.com/file';

test('Unicode attachment filenames do not crash the media response or change original bytes/range',async()=>{
  const fixture=requestFixture({'Content-Type':'application/octet-stream','content-length':'20','content-range':'bytes 0-19/100','accept-ranges':'bytes','content-disposition':'attachment; filename=天气之子.🎬.mkv','set-cookie':'session=private','x-provider-note':'中文'});
  const result=await fetchSessionMedia(browser,url,{},fixture.factory);
  assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes 0-19/100');assert.equal(result.headers.get('content-length'),'20');assert.equal(result.headers.get('content-type'),'application/octet-stream');assert.equal(result.headers.get('accept-ranges'),'bytes');
  assert.equal(await result.text(),'original-media-bytes');assert.equal(result.headers.has('content-disposition'),false);assert.equal(result.headers.has('set-cookie'),false);assert.equal(result.headers.has('x-provider-note'),false);
});

test('malformed essential response metadata rejects promptly, closes transport and allows later requests',async()=>{
  for(const [headers,status] of [[{'content-type':'无效'},206],[{'content-type':'video/mp4'},0]]){
    const fixture=requestFixture(headers,status);
    await assert.rejects(fetchSessionMedia(browser,url,{},fixture.factory),/百度媒体响应无效/);
    assert.equal(fixture.aborted(),true);assert.equal(fixture.incoming.destroyed,true);
    const next=requestFixture({'content-type':'video/mp4'});assert.equal(await (await fetchSessionMedia(browser,url,{},next.factory)).text(),'original-media-bytes');
  }
});
