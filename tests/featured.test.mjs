import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectFeatured,featuredDay} from '../electron/core/featured.mjs';
const entry=(n,extra={})=>({group:{id:String(n),kind:n%2?'movie':'episode',addedAt:`2026-10-${String(n+1).padStart(2,'0')}`,catalog:{backdrop:'art',rating:8,genres:[n%2?'剧情':'喜剧']}},entries:[{id:String(n)}],summary:{complete:false,watched:0},...extra});
test('daily picks are stable across sort order and state clones, rotate by day, and never duplicate',()=>{
 const pool=Array.from({length:24},(_,n)=>entry(n)),options={day:'2026-10-26'};
 const ids=items=>items.map(x=>x.group.id);
 assert.deepEqual(ids(selectFeatured(pool,options)),ids(selectFeatured(structuredClone(pool).reverse(),options)));
 assert.notDeepEqual(ids(selectFeatured(pool,options)),ids(selectFeatured(pool,{day:'2026-10-27'})));
 assert.equal(new Set(ids(selectFeatured(pool,options))).size,5);
 assert.equal(featuredDay(new Date(2026,9,26)), '2026-10-26');
 for(const item of pool)item.group.addedAt='2026-10-26';assert.deepEqual(ids(selectFeatured(pool,options)),ids(selectFeatured([...pool].reverse(),options)));
});
test('fresh batch avoids previous five, unwatched beat completed, unavailable and artwork-free titles are excluded',()=>{
 const pool=Array.from({length:15},(_,n)=>entry(n));pool[0].entries[0].unavailable=true;pool[1].group.catalog={};pool[2].summary.complete=true;
 const first=selectFeatured(pool,{day:'fixed'}),second=selectFeatured(pool,{day:'fixed',round:1,exclude:first.map(x=>x.group.id)});
 assert.ok(first.every(x=>!['0','1','2'].includes(x.group.id)));assert.ok(second.every(x=>!first.includes(x)));
 assert.ok(new Set(first.map(x=>x.group.kind)).size===2);
});
test('small libraries fill gracefully from started and watched works without inventing sources',()=>{
 const pool=[entry(1),entry(2,{summary:{complete:true,watched:1}}),entry(3,{entries:[{progress:{percent:50}}]})];
 assert.deepEqual(selectFeatured(pool,{day:'fixed'}).map(x=>x.group.id),['1','3','2']);assert.deepEqual(selectFeatured([]),[]);
});
