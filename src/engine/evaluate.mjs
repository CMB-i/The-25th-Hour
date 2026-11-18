import { makeSlots } from './capacity.mjs';
import { schedule } from './scheduler.mjs';
const HALF_HOUR = 30;
export function evaluate(tasks,days,{sleep={start:'23:00',end:'07:00'},deadline='target',minimumCushionMinutes=60}={}) {
  const optimistic=schedule(tasks,days,{sleep,estimate:'optimistic',deadline});
  const typical=schedule(tasks,days,{sleep,estimate:'typical',deadline});
  const conservative=schedule(tasks,days,{sleep,estimate:'conservative',deadline});
  const minMargin=conservative.deadlineMargins.length?Math.min(...conservative.deadlineMargins.map(x=>x.margin)):Infinity;
  let verdict='feasible', reason='Even conservative estimates fit with a reasonable deadline buffer.';
  if(!optimistic.feasible){verdict='infeasible';reason='Even optimistic task durations cannot meet every deadline.';}
  else if(!typical.feasible){verdict='at-risk';reason='Optimistic durations fit, but typical estimates miss at least one deadline.';}
  else if(!conservative.feasible){verdict='at-risk';reason='Typical durations fit, but conservative estimates miss a deadline.';}
  else if(minMargin<minimumCushionMinutes){verdict='at-risk';reason='All estimates fit, but at least one deadline has less than one hour of conservative slack.';}
  return {verdict,reason,minMargin,optimistic,typical,conservative};
}
export function weeklyCheck(tasks,days,options={}){
  const mins=tasks.filter(t=>!t.removed).reduce((a,t)=>a+t.likely*60,0);
  const capacity=makeSlots(days,options.sleep).length*HALF_HOUR;
  return {feasible:mins<=capacity,requiredMinutes:mins,capacityMinutes:capacity};
}
