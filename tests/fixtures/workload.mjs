import { rollingDays } from '../../src/engine/weeks.mjs';

export const windows = [[], ...Array.from({length:5}, () => [['16:00','20:00']]), []];
export function workload() {
  const days = rollingDays('2027-01-06',windows);
  const tasks = Array.from({length:30},(_,i) => {
    const week = Math.floor(i / 6);
    const targetDay = week * 7 + 3;
    const likely = i < 6 ? 3 : 2;
    return {id:`task-${i}`,title:`Task ${i}`,targetDay,hardDay:targetDay + 1,
      earliestDay:week * 7, min:likely-0.5,likely,max:likely + 0.5,priority:2,
      flexible:true,allowDrop:i % 3 === 0,canRequestExtension:true,splittable:true};
  });
  return {days,tasks};
}
