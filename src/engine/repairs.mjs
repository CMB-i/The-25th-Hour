import { evaluate } from './evaluate.mjs';
const clone = tasks => tasks.map(t=>({...t}));
const engineDayName=(days,i)=>new Date(`${days[i].date}T12:00:00`).toLocaleDateString('en-US',{weekday:'long'});
export function actionIdeas(tasks,days){
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
export function applyAction(tasks, action){
  return tasks.map(t=>{
    if(t.id!==action.taskId)return {...t};
    if(action.type==='move')return {...t,targetDay:action.toDay};
    if(action.type==='extend')return {...t,targetDay:action.toDay,hardDay:action.toDay};
    if(action.type==='drop')return {...t,removed:true};
    if(action.type==='reduce')return {...t,min:Math.max(0,t.min-action.amount),likely:Math.max(0,t.likely-action.amount),max:Math.max(0,t.max-action.amount)};
    throw Error('Unknown action');
  });
}
export function findRepairs(tasks,days,options={}){
  const base=evaluate(tasks,days,options);
  if(base.typical.feasible&&base.verdict==='feasible')return [];
  const ideas=actionIdeas(tasks,days), repairs=[];
  // Explore one action and, if needed, two independent actions. We explicitly
  // promise smallest *examined* change, not a globally optimal schedule.
  const trials=ideas.map(a=>[a]);
  for(let i=0;i<ideas.length;i++)for(let j=i+1;j<ideas.length;j++) {
    if(ideas[i].taskId!==ideas[j].taskId)trials.push([ideas[i],ideas[j]]);
  }
  for(const actions of trials){
    let updated=clone(tasks);
    for(const a of actions)updated=applyAction(updated,a);
    const test=evaluate(updated,days,options);
    if(!test.typical.feasible)continue;
    const needsApproval=actions.some(x=>x.needsApproval);
    const dropped=actions.filter(a=>a.type==='drop').length;
    const reduction=actions.filter(a=>a.type==='reduce').reduce((s,a)=>s+a.amount,0);
    const risk=test.verdict==='at-risk';
    const score=actions.length*100 + (needsApproval?55:0) + dropped*40 + reduction*15 + actions.reduce((s,a)=>s+a.disruption,0)*5 + (risk?8:0);
    repairs.push({id:actions.map(x=>x.id).join('+'),actions,updated,test,needsApproval,score});
  }
  return repairs.sort((a,b)=>a.score-b.score||a.id.localeCompare(b.id)).slice(0,10);
}
export function draftApprovalRequest(repair,days){
  const a=repair.actions.find(x=>x.needsApproval);
  if(!a)return '';
  const target=days[a.toDay]?.date;
  if(a.type==='extend')return `Subject: Request to adjust ${repair.updated.find(t=>t.id===a.taskId)?.title} deadline\n\nHello,\n\nI am managing several overlapping academic commitments this week and would like to ask whether the deadline for ${repair.updated.find(t=>t.id===a.taskId)?.title} could be moved to ${target}. I understand the current deadline remains in effect unless this is approved. Please let me know if an extension is possible.\n\nThank you.`;
  if(a.type==='reduce')return `Hello, could we discuss reducing the scope of ${repair.updated.find(t=>t.id===a.taskId)?.title} by ${a.amount} hours' worth of optional work? I will keep the current scope until we agree on a change.`;
  return '';
}
