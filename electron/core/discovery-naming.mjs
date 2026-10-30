import path from 'node:path';
import {isVideo} from './media.mjs';
import {baseSeriesTitle,mediaNumber,normalizeTitle} from './identification.mjs';

const number='[零〇一二两三四五六七八九十百\\d]+';
const seasonPattern=new RegExp(`第\\s*(${number})\\s*季|\\bSeason[ ._-]*(\\d{1,2})\\b|(?:^|[ ._\\[(])S(\\d{1,2})(?=$|[ ._\\])E])`,'i');
export const namedSeason=value=>{const match=String(value||'').match(seasonPattern);return match?mediaNumber(match[1]??match[2]??match[3]):undefined;};
const saneNumber=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
export const safeName=value=>{let name=String(value||'').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,' ').replace(/\s+/g,' ').replace(/[. ]+$/g,'').trim();while(Buffer.byteLength(name)>150)name=Array.from(name).slice(0,-1).join('');if(/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(name))name+='_';return name.trim();};

export function discoveryWork(snapshot) {
  const heading=String(snapshot.heading||'').replace(/^#\s*/,''),local=String(snapshot.workTitle||heading).trim();
  const text=String(snapshot.facts||snapshot.text||'').slice(0,6000);
  const season=namedSeason(heading),episodes=Number(text.match(/集数\s*[:：]\s*(\d+)/)?.[1])||undefined;
  const year=Number(text.match(/(?:首播|上映日期|上映时间)\s*[:：]\s*((?:19|20)\d{2})/)?.[1])||undefined;
  const kind=season!==undefined||episodes>1?'episode':'movie';
  const title=kind==='episode'?baseSeriesTitle(local):local;
  const original=heading.startsWith(local)?heading.slice(local.length).trim():'';
  return {title:safeName(title),originalTitle:kind==='episode'?baseSeriesTitle(original):original,kind,year,season:kind==='episode'?season:undefined,episodeCount:episodes};
}

function episodeIdentity(file,work,seasonOverride) {
  const stem=path.posix.basename(file.path).replace(/\.[^.]+$/,''),parts=file.path.split('/').slice(0,-1);
  if(/(?:E\d{1,3}\s*[-~至&+]?\s*E\d|E\d{1,3}\s*[-~至]\s*\d|第\s*\d+\s*[-~至]\s*\d+\s*集)/i.test(stem))return null;
  const standard=stem.match(/S(\d{1,2})[ ._-]*E(\d{1,3})|(\d{1,2})x(\d{1,3})/i);
  const cn=stem.match(new RegExp(`第\\s*(${number})\\s*[集话話回]`));
  const code=stem.match(/(?:^|[\s._[(-])(?:EP?|Episode)[ ._-]*(\d{1,3})(?=$|[\s._\])\-])/i);
  const suffix=stem.match(/^(.*?[\u3400-\u9fff])\s*(\d{1,3})$/);
  const brackets=[...stem.matchAll(/[\[【](\d{1,3})(?:v\d)?[\]】]/gi)];
  const numeric=stem.match(/^\s*(\d{1,3})(?:\s*[-._ ]\s*\D.*)?$/)||(brackets.length===1?brackets[0]:null)||(suffix&&normalizeTitle(suffix[1])===normalizeTitle(work.title)?[suffix[0],suffix[2]]:null);
  const episode=standard?Number(standard[2]??standard[4]):cn?mediaNumber(cn[1]):Number(code?.[1]??numeric?.[1]);
  const explicit=standard?Number(standard[1]??standard[3]):namedSeason(stem)??[...parts].reverse().map(namedSeason).find(value=>value!==undefined);
  const special=parts.some(value=>/^(?:specials?|特别篇|番外|OVA|SP)$/i.test(value));
  const expected=work.season;
  if(explicit!==undefined&&expected!==undefined&&explicit!==expected&&!special)return null;
  const season=special?0:explicit??seasonOverride??expected??1;
  if(work.episodeCount&&episode>work.episodeCount&&season!==0)return null;
  return saneNumber(episode,1,999)&&saneNumber(season,0,99)?{season,episode}:null;
}

const excluded=file=>/(?:^|[\/ ._\[（(-])(?:sample|trailer|teaser|extras?|featurettes?|花絮|预告(?:片)?|特典|采访|制作特辑)(?=$|[\/ ._\]）)-])/i.test(file.path);
const collection=file=>/合集|全[一二三四五六七八九十\d]+季|[1-9一二三四五六七八九]+\s*[-~至]\s*[1-9一二三四五六七八九]+\s*季|电影集合|collection|complete.series/i.test(file.path);
export function quality(filename) {
  const tokens=[];
  for(const [pattern,value] of [[/\b2160p\b|\b4K\b/i,'2160p'],[/\b1080[pi]\b/i,'1080p'],[/\b720p\b/i,'720p'],[/\bBluRay\b|蓝光/i,'BluRay'],[/\bWEB[ ._-]?DL\b/i,'WEB-DL'],[/\bREMUX\b/i,'REMUX'],[/\b(?:DV|DOVI)\b|Dolby.Vision/i,'DV'],[/\bHDR10\+\b/i,'HDR10+'],[/\bHDR\b/i,'HDR'],[/\bx265\b|\bHEVC\b/i,'HEVC'],[/\bx264\b|\bAVC\b/i,'AVC']])if(pattern.test(filename))tokens.push(value);
  const part=filename.match(/(?:^|[ ._-])(?:CD|Part|Disc)[ ._-]*(\d{1,2})(?=[ ._-]|$)/i);if(part)tokens.unshift('CD'+part[1]);
  return tokens.length?' - '+tokens.join(' '):'';
}
const subtitle=/\.(?:srt|ass|ssa|vtt|sub|idx)$/i;

// A plan never invents episode numbers from list order. Only the transferred
// copy is renamed; paths here identify files in the public share, not the user library.
export function namingPlan(files,work,{season}={}) {
  if(season!==undefined&&!saneNumber(season,0,99))throw new Error('季数需要在 0 至 99 之间。');
  const title=safeName(work?.title),plans=[];
  const supported=title&&['movie','episode'].includes(work?.kind);
  const videos=files.filter(file=>!file.isdir&&isVideo(file.server_filename)),features=videos.filter(file=>!excluded(file));
  for(const file of videos) {
    let identity=null,reason='';
    if(!supported)reason='缺少作品信息';
    else if(excluded(file)||collection(file))reason='合集或附加内容保留原名';
    else if(work.kind==='episode'){identity=episodeIdentity(file,work,season);if(!identity)reason='无法确认季集，保留原名';}
    else if(/S\d{1,2}[ ._-]*E\d{1,3}|第[零一二三四五六七八九十\d]+集/i.test(file.server_filename))reason='疑似剧集，保留原名';
    else if(features.length>1&&![work.title,work.originalTitle].filter(Boolean).some(value=>normalizeTitle(file.server_filename).includes(normalizeTitle(value))))reason='包含多个影片，保留原名';
    else identity={};
    const extension=path.posix.extname(file.server_filename);
    const stem=work?.kind==='episode'&&identity?`${title} - S${String(identity.season).padStart(2,'0')}E${String(identity.episode).padStart(2,'0')}`:title+(saneNumber(work?.year,1800,2199)?` (${work.year})`:'');
    const name=reason?file.server_filename:stem+quality(file.server_filename)+extension;
    plans.push({sourceId:String(file.fs_id),sourcePath:file.path,original:file.server_filename,name,reason,identity:reason?null:{title:work.title,year:work.year,kind:work.kind,...identity},size:file.size});
  }
  const videoPlans=[...plans];
  for(const file of files.filter(file=>!file.isdir&&subtitle.test(file.server_filename))) {
    const matches=videoPlans.filter(plan=>!plan.reason&&path.posix.dirname(plan.sourcePath)===path.posix.dirname(file.path)&&file.server_filename.toLowerCase().startsWith(plan.original.slice(0,-path.posix.extname(plan.original).length).toLowerCase()+'.'));
    if(matches.length!==1)continue;
    const video=matches[0],stem=video.original.slice(0,-path.posix.extname(video.original).length);
    const name=video.name.slice(0,-path.posix.extname(video.name).length)+file.server_filename.slice(stem.length);
    plans.push({sourceId:String(file.fs_id),sourcePath:file.path,original:file.server_filename,name,reason:Buffer.byteLength(name)>250?'字幕名称过长，保留原名':'',identity:null,size:file.size,videoSourceId:video.sourceId,subtitleSuffix:file.server_filename.slice(stem.length)});
  }
  return plans;
}

export function availableName(name,reserved,current) {
  const taken=new Set(reserved.filter(value=>value!==current).map(value=>value.toLocaleLowerCase()));
  if(!taken.has(name.toLocaleLowerCase()))return name;
  const extension=path.posix.extname(name),stem=name.slice(0,-extension.length);
  for(let version=2;version<10000;version++){const candidate=`${stem} - 版本 ${version}${extension}`;if(!taken.has(candidate.toLocaleLowerCase()))return candidate;}
  throw new Error('同名版本过多，请更换保存目录。');
}
