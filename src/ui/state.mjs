import { demoData } from '../engine/demo-data.mjs';
import { campusDate } from '../engine/feedback.mjs';
import { rollingDays } from '../engine/weeks.mjs';
import { SCHEMA_VERSION } from './storage.mjs';

export function makeState({fixed = false, demo = true} = {}) {
  const sample = demoData(fixed);
  const anchor = demo ? sample.days[0].date : campusDate(new Date().toISOString());
  const weeklyWorkWindows = [[],...sample.days.map(day => day.workWindows),[]];
  const days = rollingDays(anchor,weeklyWorkWindows);
  return {
    schemaVersion:SCHEMA_VERSION, demo, fixed, includeResearch:true, researchHours:5, weekIndex:0,
    days, tasks:demo ? sample.tasks : [], sleep:sample.sleep, settings:{anchor,weeklyWorkWindows},
    proposals:[], pendingApprovals:[], appliedChanges:[], selectedRepairId:null,
    feedback:{tasks:[],sleepReports:[]}, calendarImportedAt:null, lastEditedAt:null,
    tasksImportedAt:null, unresolvedConflict:false, notice:''
  };
}
