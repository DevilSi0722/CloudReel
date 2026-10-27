import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readChapters, markerKey, playbackMarkers, updateMarkers} from '../electron/core/player-navigation.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';

const episode = {id:'a', title:'Show', kind:'episode', season:2, episode:1};
test('chapters retain native identity, discard invalid timestamps and provide readable fallback titles', () => {
  assert.deepEqual(readChapters([{time:90,title:'Main'},{time:0},{time:-1},{time:500},{time:NaN}], 500), [{id:1,time:0,title:'章节 1'},{id:0,time:90,title:'Main'}]);
  assert.deepEqual(readChapters(null, 500), []);
  assert.deepEqual(readChapters([null,{time:null},{time:'40'}],500),[]);
});
test('marker overrides resolve by field and scope, explicit disable masks parent, reset restores inheritance', () => {
  const records = {};
  updateMarkers(episode,records,{scope:'series',field:'introEnd',seconds:60},1200);
  updateMarkers(episode,records,{scope:'season',field:'creditsStart',seconds:1100},1200);
  assert.equal(playbackMarkers(episode,records,1200).introEnd,60);
  assert.equal(playbackMarkers({...episode,id:'b',episode:2},records,1200).creditsStart,1100);
  assert.equal(playbackMarkers({...episode,id:'b',episode:2},records,1300).creditsStart,1200);
  assert.equal(playbackMarkers({...episode,season:3},records,1200).creditsStart,undefined);
  updateMarkers(episode,records,{scope:'episode',field:'introEnd',seconds:null},1200);
  assert.equal(playbackMarkers(episode,records,1200).introEnd,undefined);
  assert.equal(playbackMarkers({...episode,id:'other-cut'},records,1200).introEnd,60);
  updateMarkers(episode,records,{scope:'episode',field:'introEnd',reset:true},1200);
  assert.equal(playbackMarkers(episode,records,1200).introEnd,60);
  assert.equal(playbackMarkers(episode,records,50).introEnd,undefined);
  assert.throws(()=>markerKey({...episode,kind:'movie'},'season'));
  for(const seconds of [-1,NaN,0,1200,Infinity]) assert.throws(()=>updateMarkers(episode,records,{scope:'episode',field:'introEnd',seconds},1200));
  updateMarkers(episode,records,{scope:'episode',field:'introEnd',seconds:70},1200);
  assert.throws(()=>updateMarkers(episode,records,{scope:'episode',field:'creditsStart',seconds:50},1200));
  assert.equal(records[markerKey(episode,'episode')].creditsStart,undefined,'rejected changes must not persist');
});
test('manual and automatic intro skips use confirmed seek pipeline, reject stale files and do not repeatedly override deliberate rewinds', () => {
  const store=memoryStore(), writes=[];
  const service=new PlayerService(store,{}, {}, {},{resolveMpv(){}});
  const session=service.session={item:episode,position:10,duration:1200,loaded:true,tracks:[],preferences:{skipIntro:'auto'},socket:{write:line=>writes.push(JSON.parse(line))}};
  service.setMarker({itemId:'a',field:'introEnd',scope:'season',seconds:60});
  service.maybeSkipIntro(session);
  assert.equal(writes[0].command[0],'seek');assert.equal(session.position,10);assert.equal(session.seek.target,60);
  service.maybeSkipIntro(session);assert.equal(writes.length,1);
  assert.throws(()=>service.setMarker({itemId:'old',field:'introEnd',scope:'season',seconds:80}));
  clearTimeout(session.seekTimer);session.seek.pending=false;
  service.setMarker({itemId:'a',field:'creditsStart',scope:'episode',seconds:1100});
  assert.throws(()=>service.skipSection({itemId:'a',section:'credits'}));
  session.position=1120;service.skipSection({itemId:'a',section:'credits'});assert.equal(session.seek.target,1199.75);assert.equal(session.position,1120);
  clearTimeout(session.seekTimer);
});
