const HALF_HOUR = 30;
const fmtTime = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
export function parsePastedTasks(text,days){
  const out=[];const errors=[];
  text.split(/\r?\n/).filter(s=>s.trim()).forEach((line,i)=>{
    const [title,rawHours,rawDate,rawPriority]=line.split('|').map(x=>x?.trim());
    const hours=Number((rawHours||'').replace(/h$/i,''));
    const day=days.findIndex(d=>d.date===rawDate);
    if(!title||!Number.isFinite(hours)||hours<=0||(hours*60)%HALF_HOUR||day<0){errors.push(`Line ${i+1}: use Title | 3h | YYYY-MM-DD | must-keep/flexible/droppable (date in demo week).`);return;}
    const p=(rawPriority||'must-keep').toLowerCase();
    if(!['must-keep','flexible','droppable'].includes(p)){errors.push(`Line ${i+1}: invalid priority tag.`);return;}
    out.push({id:`import-${i+1}-${title.toLowerCase().replace(/\W+/g,'-')}`,title,min:Math.max(.5,hours-.5),likely:hours,max:hours+.5,targetDay:day,hardDay:day,earliestDay:0,priority:p==='must-keep'?1:2,flexible:false,allowDrop:p==='droppable',splittable:true,canRequestExtension:false,isProposal:false});
  });
  return {data:out,warnings:errors};
}
/** Conservative .ics import: explicit local times, or UTC Z converted to Kolkata.
 * Unsupported recurrence, all-day events, and external TZIDs are skipped with
 * messages rather than silently producing misleading availability.
 */
export function parseIcs(text,days){
  const result={data:[],warnings:[]};
  const unfolded=text.replace(/\r?\n[ \t]/g,'').split(/\r?\n/);
  let current=null;
  const fields={};
  const local=(value,key)=>{
    if(key.includes('TZID=')&&!key.includes('Asia/Kolkata'))throw Error('Only Asia/Kolkata TZID is supported in this demo.');
    if(!/^\d{8}T\d{6}Z?$/.test(value))throw Error('All-day or malformed event time is unsupported.');
    const y=value.slice(0,4),m=value.slice(4,6),d=value.slice(6,8),h=value.slice(9,11),min=value.slice(11,13);
    if(value.endsWith('Z')) {
      const dt=new Date(`${y}-${m}-${d}T${h}:${min}:${value.slice(13,15)}Z`);
      const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
      const p=Object.fromEntries(f.formatToParts(dt).map(p=>[p.type,p.value]));
      return {date:`${p.year}-${p.month}-${p.day}`,minutes:Number(p.hour)*60+Number(p.minute)};
    }
    return {date:`${y}-${m}-${d}`,minutes:Number(h)*60+Number(min)};
  };
  for(const raw of unfolded){
    if(raw==='BEGIN:VEVENT'){current={};continue;}
    if(raw==='END:VEVENT'){
      if(current){
        try{
          if(current.RRULE)throw Error('Recurring events require expansion; import individual instances.');
          if(!current.start||!current.end)throw Error('Missing start or end time.');
          const s=local(...current.start),e=local(...current.end);
          if(s.date!==e.date)throw Error('Cross-midnight event is unsupported.');
          const index=days.findIndex(x=>x.date===s.date);
          if(index<0)continue;
          if(!(e.minutes>s.minutes))throw Error('Invalid event duration.');
          result.data.push({index,date:s.date,start:fmtTime(s.minutes),end:fmtTime(e.minutes),summary:current.summary||'Imported appointment'});
        }catch(e){result.warnings.push(`${current.summary||'Event'}: ${e.message}`);}
      }
      current=null;continue;
    }
    if(!current)continue;
    const colon=raw.indexOf(':');if(colon<0)continue;
    const key=raw.slice(0,colon),value=raw.slice(colon+1);
    if(key.startsWith('DTSTART'))current.start=[value,key];
    if(key.startsWith('DTEND'))current.end=[value,key];
    if(key==='SUMMARY')current.summary=value;
    if(key==='RRULE')current.RRULE=value;
  }
  return result;
}

