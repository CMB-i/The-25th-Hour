export function demoData(fixed=false){
  const days=[
    {date:'2026-11-16',workWindows:[['16:00','20:00']],busyWindows:[]},
    {date:'2026-11-17',workWindows:[['17:00','20:00']],busyWindows:[]},
    {date:'2026-11-18',workWindows:[['16:00','19:00']],busyWindows:[]},
    {date:'2026-11-19',workWindows:[['16:00','19:00']],busyWindows:[]},
    {date:'2026-11-20',workWindows:[['13:00','20:00']],busyWindows:[]}
  ];
  const t=(id,title,h,targetDay,hardDay,options={})=>({id,title,min:h,likely:h,max:h,targetDay,hardDay,earliestDay:0,priority:1,flexible:false,allowDrop:false,splittable:true,...options});
  const tasks=[
    t('dbms','DBMS Lab',4,1,1),
    t('ml','ML Assignment',3,3,3),
    t('poster','AUV Club Poster',3,3,fixed?3:4,{flexible:!fixed,canRequestExtension:fixed,priority:2}),
    t('french','French Homework',3,4,4),
    t('research','New Research Project',5,3,3,{min:4,likely:5,max:6,priority:2,isProposal:true,allowDrop:true,canRequestExtension:false})
  ];
  return {days,tasks,sleep:{start:'23:00',end:'07:00'}};
}
