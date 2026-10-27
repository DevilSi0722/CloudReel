const positive = value => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : undefined;
// All fields come from libavformat/libavcodec via mpv, never from a filename.
// In particular a 10-bit video is not necessarily HDR.
export function readMediaInfo({params,tracks = [],duration,fps,dolbyVisionProfile}) {
  const video=tracks.find(t=>t.type==='video' && !t.image && !t.albumart && t.selected) || tracks.find(t=>t.type==='video' && !t.image && !t.albumart);
  const width=positive(params?.w || video?.['demux-w']),height=positive(params?.h || video?.['demux-h']);
  if(!width || !height) return null;
  const profile=positive(dolbyVisionProfile || video?.['dolby-vision-profile']);
  const range=params?.colormatrix==='dolbyvision' || profile ? 'Dolby Vision' : params?.gamma==='pq' ? 'HDR10' : params?.gamma==='hlg' ? 'HLG' : params?.gamma ? 'SDR' : undefined;
  const pixels=params?.['hw-pixelformat'] || params?.pixelformat || '';
  const bitDepth=positive(params?.['plane-depth']) || (/p0?10|p10|10le|10be/i.test(pixels) ? 10 : /p0?12|p12|12le|12be/i.test(pixels) ? 12 : /yuv|nv12|rgba?|bgra/i.test(pixels) ? 8 : undefined);
  const channels = t => {const value=t['audio-channels'] || t.channels || t['demux-channel-count'];return typeof value==='number' ? `${value} 声道` : value==='stereo' ? '立体声' : value==='mono' ? '单声道' : String(value || '');};
  const track = t => ({codec:t.codec || '',lang:t.lang || '',title:t.title || '',channels:channels(t),sampleRate:positive(t['demux-samplerate']),selected:Boolean(t.selected)});
  const audioTracks=tracks.filter(t=>t.type==='audio').map(track),subtitles=tracks.filter(t=>t.type==='sub' && !t.external).map(track);
  const audio=audioTracks.find(t=>t.selected) || audioTracks[0];
  return {width,height,codec:video?.codec || '',dynamicRange:range,dolbyVisionProfile:profile,bitDepth,fps:positive(fps || video?.['demux-fps']),duration:positive(duration),audio:audio?.codec,channels:audio?.channels,audioTracks,subtitles,verified:true};
}
