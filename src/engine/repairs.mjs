import { evaluatePrepared, prepareEvaluation, verdictText } from './evaluate.mjs';
import { lexical, weekdayName } from './dates.mjs';
import { validateTasks } from './scheduler.mjs';

const rank = {infeasible: 0, 'at-risk': 1, feasible: 2};
function destinationLabel(days, index) {
  const day = days[index];
  return index < 7 ? weekdayName(day.date) : `${weekdayName(day.date)} (${day.date})`;
}

export function actionIdeas(tasks, days) {
  validateTasks(tasks, days);
  const ideas = [];
  for (const task of tasks) {
    if (task.removed) continue;
    const {id, title, targetDay, hardDay} = task;
    const impact = task.likely * 60;
    if (task.flexible) {
      for (let toDay = targetDay + 1; toDay <= hardDay; toDay++) {
        ideas.push({id:`move:${id}:${toDay}`, taskId:id, type:'move', toDay, needsApproval:false, impact,
          label:`Move ${title} target to ${destinationLabel(days, toDay)}`,
          description:'Adjust an internal target within the hard deadline.', disruption:1});
      }
    }
    if (task.allowDrop) {
      ideas.push({id:`drop:${id}`, taskId:id, type:'drop', needsApproval:false, impact,
        label:`${task.isProposal ? 'Decline' : 'Drop optional'} ${title}`,
        description:'Remove a genuinely optional commitment.', disruption:5});
    }
    if (task.reduceBy > 0) {
      const amount = task.reduceBy;
      const needsApproval = Boolean(task.reductionNeedsApproval);
      ideas.push({id:`reduce:${id}`, taskId:id, type:'reduce', amount, needsApproval, impact:amount * 60,
        label:`Reduce ${title} scope by ${amount}h`,
        description:needsApproval ? 'Keep the current scope until agreement.' : 'Remove work identified as nonessential.',
        disruption:3});
    }
    if (task.canRequestExtension && hardDay < days.length - 1) {
      const toDay = hardDay + 1;
      ideas.push({id:`extend:${id}:${toDay}`, taskId:id, type:'extend', toDay, needsApproval:true, impact,
        label:`Request ${title} deadline on ${destinationLabel(days, toDay)}`,
        description:'Keep the current deadline until approval.', disruption:2});
    }
  }
  return ideas;
}

function simulateAction(tasks, action) {
  return tasks.map(task => {
    if (task.id !== action.taskId) return task;
    switch (action.type) {
      case 'move': return {...task,targetDay:action.toDay};
      case 'extend': return {...task,targetDay:action.toDay,hardDay:action.toDay};
      case 'drop': return {...task,removed:true};
      case 'reduce': {
        const reduce = hours => Math.max(0, hours - action.amount);
        return {...task,min:reduce(task.min),likely:reduce(task.likely),max:reduce(task.max),reduceBy:0};
      }
      default: throw Error('Unknown action.');
    }
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
  return simulateAction(tasks, action).map(task => ({...task}));
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
    .map(repair => ({...repair, updated:repair.updated.map(task => ({...task})),
      test:evaluatePrepared(repair.updated, context)}));
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
