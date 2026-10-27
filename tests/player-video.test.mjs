import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoPlaybackStatus} from '../electron/core/player-video.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';

test('Dolby Vision is reported as mapped HDR and never as native Dolby output', () => {
  const status = videoPlaybackStatus({videoParams:{colormatrix:'dolbyvision',gamma:'pq'}, videoTarget:{gamma:'pq',primaries:'bt.2020',pixelformat:'rgb10a2','max-luma':650}, dolbyVisionProfile:5, hwdec:'d3d11va'});
  assert.equal(status.source,'Dolby Vision'); assert.equal(status.output,'HDR'); assert.equal(status.mapped,true);
  assert.equal(status.nativeDolbyVision,false); assert.equal(status.dolbyVisionProfile,5); assert.equal(status.peakNits,650);
});

test('HDR and SDR output follow actual renderer properties instead of source labels', () => {
  assert.equal(videoPlaybackStatus({videoParams:{gamma:'pq'},videoTarget:{gamma:'srgb'}}).output,'SDR');
  assert.equal(videoPlaybackStatus({videoParams:{gamma:'hlg'},videoTarget:{gamma:'scrgb'}}).output,'HDR');
  assert.equal(videoPlaybackStatus({videoParams:{gamma:'pq'},videoTarget:{gamma:'linear',pixelformat:'rgbaf16'}}).output,'HDR');
  assert.equal(videoPlaybackStatus({videoParams:{gamma:'bt.1886'},videoTarget:{gamma:'pq'}}).source,'SDR');
  assert.equal(videoPlaybackStatus({}).output,null);
  assert.equal(videoPlaybackStatus({videoTarget:{gamma:'pq','max-luma':NaN}}).peakNits,undefined);
});

test('changing or losing output clears stale HDR status without touching playback progress', () => {
  const player = new PlayerService(memoryStore(),{},{},{},{resolveMpv(){}});
  const session = {item:{id:'one'},position:50,duration:100}; player.session=session;
  player.event(session,{event:'property-change',name:'video-params',data:{colormatrix:'dolbyvision',gamma:'pq'}});
  player.event(session,{event:'property-change',name:'video-target-params',data:{gamma:'pq','max-luma':650}});
  assert.equal(player.status().video.output,'HDR');
  player.event(session,{event:'property-change',name:'video-target-params',data:{gamma:'srgb'}});
  assert.equal(player.status().video.output,'SDR'); assert.equal(player.status().video.mapped,true);
  player.event(session,{event:'property-change',name:'video-target-params',data:null});
  assert.equal(player.status().video.output,null); assert.equal(session.position,50);
  player.event({}, {event:'property-change',name:'video-target-params',data:{gamma:'pq'}});
  assert.equal(player.status().video.output,null);
});
