import { loadColliderFromDisk } from './path-lab';
import { generatePath, createPathCache } from '@/lib/path';
import type { Vec3, Waypoint } from '@/lib/types';
const collider = await loadColliderFromDisk('public/sample-room/collider.glb');
const spots: Vec3[] = [[3,0,2.2],[4.4,0,5.2],[1.6,0,7],[8.2,0,4]];
const wps: Waypoint[] = spots.map((p,i)=>({id:`w${i+1}`,position:p,mode:'auto',shotType:'orbit',
  duration:4,emphasis:1,panSector:null,pinned:false}));
const r = generatePath({ collider, waypoints: wps, settings:{style:'realEstate'} }, createPathCache());
const dt = 1/r.fps;
const speed: number[] = [0];
for (let i=1;i<r.frames.length;i++){
  const a=r.frames[i-1].position, b=r.frames[i].position;
  speed.push(Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2])/dt);
}
console.log('speed profile at each segment boundary (m/s):');
for (const s of r.segments) {
  const i = s.frameStart;
  const before = i>0 ? speed[i-1] : 0;
  const at = speed[i] ?? 0;
  console.log(`  ${String(s.startTime.toFixed(1)).padStart(5)}s  ${s.kind.padEnd(6)} ${s.id.padEnd(20)} ` +
    `speed in ${before.toFixed(3)} -> out ${at.toFixed(3)} m/s`);
}
const stops = speed.filter(v=>v<0.02).length;
console.log(`\nframes at a near standstill (<0.02 m/s): ${stops} of ${speed.length} (${(100*stops/speed.length).toFixed(0)}%)`);
console.log(`turn-rate limiter engaged on ${r.stats.turnRateClampedFrames} frames`);
