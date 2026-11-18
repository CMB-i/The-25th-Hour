import { evaluatePrepared, prepareEvaluation, verdictText } from './evaluate.mjs';
import { lexical, weekdayName } from './dates.mjs';
import { validateTasks } from './scheduler.mjs';

const rank = {infeasible: 0, 'at-risk': 1, feasible: 2};
const engineDayName = (days, index) => weekdayName(days[index].date);

export function actionIdeas(tasks,days){
  validateTasks(tasks, days);
  const ideas=[];
  for(const t of tasks){
    if(t.removed)continue;
    if(t.flexible&&t.targetDay<t.hardDay) {
      for(let day=t.targetDay+1;day<=t.hardDay;day++)ideas.push({id:`move:${t.id}:${day}`,taskId:t.id,type:'move',toDay:day,needsApproval:false,label:`Move ${t.title} target to ${engineDayName(days,day)}`,description:'Adjust an internal target without violating the final hard deadline.',impact:t.likely*60,disruption:1});
    }
    if(t.allowDrop) ideas.push({id:`drop:${t.id}`,taskId:t.id,type:'drop',needsApproval:false,label:t.isProposal?`Decline ${t.title}`:`Drop optional ${t.title}`,description:'Remove a genuinely optional commitment; do not drop required coursework.',impact:t.likely*60,disruption:5});
    if((t.reduceBy||0)>0){
      ideas.push({id:`reduce:${t.id}`,taskId:t.id,type:'reduce',amount:t.reduceBy,needsApproval:!!t.reductionNeedsApproval,label:`Reduce ${t.title} scope by ${t.reduceBy}h`,description:t.reductionNeedsApproval?'Only valid after the supervisor or teammate agrees.':'Only remove work explicitly identified as nonessential.',impact:t.reduceBy*60,disruption:3});
    }
    if(t.canRequestExtension&&t.hardDay<days.length-1){
      const day=t.hardDay+1;
      ideas.push({id:`extend:${t.id}:${day}`,taskId:t.id,type:'extend',toDay:day,needsApproval:true,label:`Request ${t.title} deadline on ${engineDayName(days,day)}`,description:'A hypothetical extension only. Original deadline stays binding until approved.',impact:t.likely*60,disruption:2});
    }
  }
  return ideas;
}
function simulateAction(tasks, action){
  return tasks.map(t=>{
    if(t.id!==action.taskId)return {...t};
    if(action.type==='move')return {...t,targetDay:action.toDay};
    if(action.type==='extend')return {...t,targetDay:action.toDay,hardDay:action.toDay};
    if(action.type==='drop')return {...t,removed:true};
    if(action.type==='reduce')return {...t,min:Math.max(0,t.min-action.amount),likely:Math.max(0,t.likely-action.amount),max:Math.max(0,t.max-action.amount),reduceBy:0};
    throw Error('Unknown action');
  });
}
export function applyAction(tasks, action, {approved = false} = {}) {
  const task = tasks.find(t => t.id === action.taskId && !t.removed);
  if (!task) throw Error('Repair task is no longer active.');
  const {type, toDay, amount} = action;
  if ((type === 'move' && (!task.flexible || !Number.isInteger(toDay) || toDay <= task.targetDay || toDay > task.hardDay)) ||
      (type === 'extend' && (!task.canRequestExtension || toDay !== task.hardDay + 1)) ||
      (type === 'drop' && !task.allowDrop) ||
      (type === 'reduce' && (!(amount > 0) || amount !== task.reduceBy))) {
    throw Error('This action is no longer allowed.');
  }
  const needsApproval = type === 'extend' || (type === 'reduce' && task.reductionNeedsApproval);
  if ((needsApproval || action.needsApproval) && approved !== true) throw Error('Record explicit approval before applying this action.');
  return simulateAction(tasks, action);
}

export function findRepairs(tasks, days, options = {}) {
  const ideas = actionIdeas(tasks, days);
  const context = prepareEvaluation(days, options);
  const base = evaluatePrepared(tasks, context, false);
  if (base === 'feasible') return [];
  const accepted = [];
  const singles = new Map();
  function verify(actions) {
    const updated = actions.reduce(simulateAction, tasks);
    const verdict = evaluatePrepared(updated, context, false);
    if (rank[verdict] <= rank[base]) return;
    if (actions.length === 1) singles.set(actions[0].id, verdict);
    else if (actions.some(action => rank[singles.get(action.id)] >= rank[verdict])) return;

    const needsApproval = actions.some(action => action.needsApproval);
    const drops = actions.filter(action => action.type === 'drop').length;
    const reducedHours = actions.reduce((sum, action) => sum + (action.type === 'reduce' ? action.amount : 0), 0);
    const disruption = actions.reduce((sum, action) => sum + action.disruption, 0);
    const score = 100 * actions.length + 55 * Number(needsApproval) + 40 * drops +
      15 * reducedHours + 5 * disruption + 8 * Number(verdict === 'at-risk');
    const id = actions.map(action => action.id).join('+');
    accepted.push({id, actions, updated, needsApproval, score});
  }

  for (const action of ideas) verify([action]);
  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      if (ideas[i].taskId === ideas[j].taskId || [ideas[i], ideas[j]].some(action => singles.get(action.id) === 'feasible')) continue;
      verify([ideas[i], ideas[j]]);
    }
  }
  return accepted.sort((a, b) => a.score - b.score || lexical(a.id, b.id)).slice(0, 10)
    .map(repair => ({...repair, test: evaluatePrepared(repair.updated, context)}));
}

export function applyRepair(tasks, days, repairId, {approvedActionIds = [], ...options} = {}) {
  const repair = findRepairs(tasks, days, options).find(candidate => candidate.id === repairId);
  if (!repair) throw Error('This repair is no longer available. Preview the current plan again.');
  return repair.actions.reduce((list, action) =>
    applyAction(list, action, {approved: approvedActionIds.includes(action.id)}), tasks);
}

export function emptyRepairMessage(verdict) {
  return {
    feasible: 'No change needed',
    'at-risk': 'No further verified change. Keep your buffer.',
    infeasible: "No verified fix with the changes you've allowed. This is a capacity problem, not a scheduling problem."
  }[verdict];
}

export function draftApprovalRequest(repair, days, {includeWorkload = false} = {}) {
  const drafts = repair.actions.filter(action => action.needsApproval).map(action => {
    const title = repair.updated.find(task => task.id === action.taskId)?.title;
    const workload = includeWorkload ? `\n\nPlan after the proposed change: ${verdictText(repair.test, days)}` : '';
    if (action.type === 'extend') {
      return `Subject: Request to adjust ${title} deadline\n\nHello,\n\nCould the deadline for ${title} move to ${days[action.toDay].date}? The current deadline stays in effect until you approve the change.${workload}\n\nThank you.`;
    }
    return `Hello, could we discuss reducing the scope of ${title} by ${action.amount}h of optional work? The current scope stays in effect until we agree.${workload}`;
  });
  return drafts.join('\n\n');
}
