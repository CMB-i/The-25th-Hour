import { makeSlots } from './capacity.mjs';
const HALF_HOUR = 30;
export function check(tasks,days){
  const ids=new Set();
  for(const t of tasks){
    if(ids.has(t.id)) throw Error(`Duplicate task ID: ${t.id}`);
    ids.add(t.id);
    if(!t.id||!t.title)throw Error('Task needs an ID and title');
    if(!Number.isInteger(t.targetDay)||!Number.isInteger(t.hardDay)||t.targetDay<0||t.hardDay>=days.length||t.targetDay>t.hardDay) throw Error(`Invalid target/hard deadline for ${t.title}`);
    if(!Number.isInteger(t.earliestDay)||t.earliestDay<0||t.earliestDay>t.hardDay)throw Error(`Invalid earliest start for ${t.title}`);
    if(!(t.min>=0&&t.min<=t.likely&&t.likely<=t.max)) throw Error(`Invalid duration range for ${t.title}`);
    if([t.min,t.likely,t.max].some(n=>(n*60)%HALF_HOUR!==0)) throw Error(`Use half-hour duration increments: ${t.title}`);
  }
}
const durationKey = {optimistic:'min',typical:'likely',conservative:'max'};
export function schedule(tasks, days, {sleep={start:'23:00',end:'07:00'}, estimate='typical', deadline='target'}={}) {
  check(tasks,days);
  const key=durationKey[estimate];
  if(!key)throw Error(`Bad estimate: ${estimate}`);
  if(!['target','hard'].includes(deadline))throw Error('Bad deadline mode');
  const usable=tasks.filter(t=>!t.removed);
  const slots=makeSlots(days,sleep);
  const remaining=new Map(usable.map(t=>[t.id,Math.round(t[key]*60)]));
  const alloc=[];
  for(const slot of slots){
    const choices=usable.filter(t=>t.earliestDay<=slot.dayIndex && remaining.get(t.id)>0);
    if(!choices.length)continue;
    choices.sort((a,b)=>a[deadline+'Day']-b[deadline+'Day']||(a.priority??2)-(b.priority??2)||a.id.localeCompare(b.id));
    const t=choices[0];
    // Every task in this MVP is interruptible. Fixed-length activities belong
    // in busyWindows; we do not silently split tasks marked otherwise.
    if(t.splittable===false)throw Error(`Uninterrupted task ${t.title} is unsupported; add it as a fixed busy appointment.`);
    const used=Math.min(HALF_HOUR,remaining.get(t.id));
    remaining.set(t.id,remaining.get(t.id)-used);
    alloc.push({...slot,taskId:t.id,taskTitle:t.title,minutes:used,late:slot.dayIndex>t[deadline+'Day']});
  }
  const taskResults=usable.map(t=>{
    const mine=alloc.filter(a=>a.taskId===t.id);
    const scheduled=mine.reduce((a,x)=>a+x.minutes,0);
    const missing=remaining.get(t.id);
    const late=mine.filter(x=>x.late).reduce((a,x)=>a+x.minutes,0);
    const workedBeforeDeadline=mine.filter(x=>!x.late).reduce((a,x)=>a+x.minutes,0);
    return {id:t.id,title:t.title,required:Math.round(t[key]*60),scheduled,missing,late,shortByDeadline:Math.max(0,Math.round(t[key]*60)-workedBeforeDeadline),dueDay:t[deadline+'Day']};
  });
  const byDay=days.map((d,i)=>({date:d.date,index:i,capacity:slots.filter(s=>s.dayIndex===i).length*HALF_HOUR,assigned:alloc.filter(s=>s.dayIndex===i)}));
  const misses=taskResults.filter(t=>t.shortByDeadline>0);
  const late=taskResults.reduce((a,t)=>a+t.late+t.missing,0);
  const deadlineMargins=[...new Set(usable.map(t=>t[deadline+'Day']))].sort((a,b)=>a-b).map(dayIndex=>{
    const demand=usable.filter(t=>t[deadline+'Day']<=dayIndex).reduce((a,t)=>a+t[key]*60,0);
    const capacity=byDay.filter(d=>d.index<=dayIndex).reduce((a,d)=>a+d.capacity,0);
    return {dayIndex,capacity,demand,margin:capacity-demand};
  });
  return {feasible:misses.length===0,lateMinutes:late,requiredMinutes:taskResults.reduce((a,t)=>a+t.required,0),capacityMinutes:slots.length*HALF_HOUR,alloc,byDay,taskResults,misses,deadlineMargins};
}
