const HALF_HOUR = 30;
const DAY_MINUTES = 1440;
const minOf = hhmm => {
  if (!/^\d\d:\d\d$/.test(hhmm)) throw Error(`Bad time: ${hhmm}`);
  const [h,m]=hhmm.split(':').map(Number);
  if(h>23||m>59) throw Error(`Bad time: ${hhmm}`);
  return h*60+m;
};
const fmtTime = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const overlap = (a,b,c,d) => a<d && c<b;
export function inSleep(start,end,sleep) {
  const a=minOf(sleep.start), b=minOf(sleep.end);
  if (a===b) return false;
  if(a<b) return overlap(start,end,a,b);
  return overlap(start,end,a,DAY_MINUTES)||overlap(start,end,0,b);
}
export function makeSlots(days, sleep={start:'23:00',end:'07:00'}) {
  const slots=[];
  days.forEach((day,dayIndex)=>{
    const windows=day.workWindows||[];
    const busy=day.busyWindows||[];
    const occupied=new Set();
    windows.forEach(([begin,finish])=>{
      const st=minOf(begin), en=minOf(finish);
      if(st>=en||st%30||en%30) throw Error(`Work windows must be same-day and half-hour aligned: ${day.date}`);
      for(let m=st;m<en;m+=HALF_HOUR) {
        if(inSleep(m,m+HALF_HOUR,sleep)) continue;
        if(busy.some(([s,e])=>overlap(m,m+HALF_HOUR,minOf(s),minOf(e)))) continue;
        if(occupied.has(m)) continue;
        occupied.add(m);
        slots.push({date:day.date,dayIndex,start:m,end:m+HALF_HOUR,label:`${fmtTime(m)}–${fmtTime(m+HALF_HOUR)}`});
      }
    });
  });
  return slots.sort((a,b)=>a.dayIndex-b.dayIndex||a.start-b.start);
}
