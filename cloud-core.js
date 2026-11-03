/* Record-based sync. No clocks or whole-file replacement decide which memo wins. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./sync-core.js'):root.WorklogSyncCore);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.WorklogCloudCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(C){
  'use strict';
  const clone=v=>v===undefined?undefined:C.clone(v), eq=C.equal;
  const localKeys=new Set(['rightPanelTab','rightPanelOpen','meetingCollapsedMonths','meetingView','meetingCalMonth','meetingSelectedDay','poVendorCollapsed','poFilter','poView','poCalendarMonth','fxRates']);
  const identity=x=>x&&typeof x==='object'?String(x.id??x._syncId??C.hash(x)):C.hash(x);
  function split(input){
    const raw=clone(input);delete raw._cloudV5;delete raw._syncV4;
    const s=C.normalize(raw), out={};
    const add=(key,kind,value,extra={})=>{out[key]={key,kind,value:clone(value),...extra};};
    add('date','date',s.currentDate);
    const task=(t,day=null,index=0)=>{const clean={...t};delete clean.expanded;delete clean.selected;add('task/'+identity(t),'task',{task:clean,archivedOn:day,currentDay:day||s.currentDate},{index});};
    Object.entries(s.archive||{}).forEach(([day,arr])=>arr.forEach((t,index)=>task(t,day,index)));
    (s.todayTasks||[]).forEach((t,index)=>task(t,null,index));
    Object.entries(s.archiveMemos||{}).forEach(([day,v])=>add('memo/'+day,'memo',v,{day}));
    if(s.todayMemo||!out['memo/'+s.currentDate])add('memo/'+s.currentDate,'memo',s.todayMemo||'',{day:s.currentDate});
    Object.entries(s.archiveAttachments||{}).forEach(([day,v])=>add('attachments/'+day,'attachments',v,{day}));
    if(s.todayAttachments?.length)add('attachments/'+s.currentDate,'attachments',s.todayAttachments,{day:s.currentDate});
    Object.entries(s.calculatorData||{}).forEach(([kind,values])=>Object.entries(values||{}).forEach(([name,value])=>{
      let json=false;try{value=C.normalize(JSON.parse(value));json=true;}catch(_){}
      add('calculator/'+kind+'/'+name,'calculator',value,{calculator:kind,name,json});
    }));
    for(const [k,v] of Object.entries(s)){
      if(localKeys.has(k)||['currentDate','todayTasks','archive','todayMemo','archiveMemos','todayAttachments','archiveAttachments','calculatorData'].includes(k))continue;
      if(Array.isArray(v))v.forEach((item,index)=>add('list/'+k+'/'+identity(item),'list',item,{field:k,index}));
      else add('root/'+k,'root',v,{field:k});
    }
    return out;
  }
  function meaningful(record){
    const v=record.value;
    return record.kind==='date'||(v!==''&&v!==null&&v!==undefined&&(typeof v!=='object'||Object.keys(v).length>0));
  }
  function join(records,seed){
    const s=clone(seed);delete s._cloudV5;delete s._syncV4;
    const all=Object.values(records).filter(r=>!r.deleted);
    const date=all.find(r=>r.kind==='date')?.value;
    s.currentDate=[s.currentDate||'',date||''].sort().at(-1);
    const prefs=new Map((seed.todayTasks||[]).map(t=>[identity(t),{expanded:!!t.expanded,selected:!!t.selected}]));
    const listFields=new Set(all.filter(r=>r.kind==='list').map(r=>r.field));
    // Empty collections remain empty after the last member is tombstoned.
    Object.values(records).filter(r=>r.kind==='list').forEach(r=>listFields.add(r.field));
    listFields.forEach(k=>s[k]=[]);
    s.todayTasks=[];s.archive={};s.todayMemo='';s.archiveMemos={};s.todayAttachments=[];s.archiveAttachments={};s.calculatorData={cost:{},stock:{}};
    for(const r of all.sort((a,b)=>(a.index||0)-(b.index||0)||a.key.localeCompare(b.key))){
      const v=clone(r.value);
      if(r.kind==='task'){
        const day=v.archivedOn||(v.task.completed&&v.currentDay<s.currentDate?v.currentDay:null);
        if(day)(s.archive[day]||(s.archive[day]=[])).push(v.task);
        else s.todayTasks.push({...v.task,...(prefs.get(identity(v.task))||{expanded:false,selected:false})});
      }else if(r.kind==='memo'){if(r.day===s.currentDate)s.todayMemo=v;else if(v)s.archiveMemos[r.day]=v;}
      else if(r.kind==='attachments'){if(r.day===s.currentDate)s.todayAttachments=v;else s.archiveAttachments[r.day]=v;}
      else if(r.kind==='calculator'){if(!s.calculatorData[r.calculator])s.calculatorData[r.calculator]={};s.calculatorData[r.calculator][r.name]=r.json?JSON.stringify(v):v;}
      else if(r.kind==='list')s[r.field].push(v);
      else if(r.kind==='root')s[r.field]=v;
    }
    return s;
  }
  function mergeValue(base,local,remote,path=[],conflicts=[]){
    if(eq(local,base))return clone(remote);
    if(eq(remote,base)||eq(local,remote))return clone(local);
    const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
    if(obj(local)&&obj(remote)&&(base===undefined||obj(base))){
      const result={};for(const key of new Set([...Object.keys(base||{}),...Object.keys(local),...Object.keys(remote)])){
        const v=mergeValue(base?.[key],local[key],remote[key],[...path,key],conflicts);if(v!==undefined)result[key]=v;
      }return result;
    }
    if(Array.isArray(local)&&Array.isArray(remote)&&(base===undefined||Array.isArray(base))){
      const key=x=>x&&typeof x==='object'?identity(x):C.stable(x);
      const unique=a=>new Set(a.map(key)).size===a.length;
      if([base||[],local,remote].every(unique)){
        const b=new Map((base||[]).map(x=>[key(x),x])),l=new Map(local.map(x=>[key(x),x])),r=new Map(remote.map(x=>[key(x),x]));
        const result=[];for(const k of new Set([...r.keys(),...l.keys(),...b.keys()])){
          const v=mergeValue(b.get(k),l.get(k),r.get(k),[...path,k],conflicts);if(v!==undefined)result.push(v);
        }return result;
      }
    }
    conflicts.push(path.join('.'));return clone(local);
  }
  function operation(base,record,id){
    return {id,key:record.key,record:clone(record),baseRevision:base?.revision||0,baseValue:base&&!base.deleted?clone(base.value):undefined,baseDeleted:!base||!!base.deleted,createdAt:Date.now()};
  }
  function resolve(current,op){
    const local=op.record.deleted?undefined:op.record.value,remote=current&&!current.deleted?current.value:undefined;
    const conflicts=[];
    let value;
    if(op.record.kind==='date')value=[local||'',remote||''].sort().at(-1);
    else value=mergeValue(op.baseDeleted?undefined:op.baseValue,local,remote,[],conflicts);
    const record={...clone(op.record),value:value===undefined?null:value,deleted:value===undefined,revision:(current?.revision||0)+1,operationId:op.id};
    return {record,conflicts};
  }
  class Engine{
    constructor(state,saved,makeId,actor='tab'){
      this.actor=actor;this.makeId=makeId;this.model=saved?.model||split(state);this.server=saved?.server||{};this.queue=saved?.queue||{};this.conflicts=saved?.conflicts||{};
      if(!saved)for(const r of Object.values(this.model))if(meaningful(r))this.queue[r.key]={...operation(null,r,makeId()),actor};
    }
    capture(state){
      const next=split(state);let changed=false;
      for(const key of new Set([...Object.keys(this.model),...Object.keys(next)])){
        const previous=this.model[key],value=next[key];
        if(value&&previous&&!previous.deleted&&eq(previous.value,value.value))continue;
        if(!value&&(!previous||previous.deleted))continue;
        const r=value||{...previous,value:null,deleted:true};
        const old=this.queue[key],op={...operation(this.server[key],r,this.makeId()),actor:this.actor};
        if(old){op.baseRevision=old.baseRevision;op.baseValue=clone(old.baseValue);op.baseDeleted=old.baseDeleted;}
        this.queue[key]=op;this.model[key]=clone(r);changed=true;
      }return changed;
    }
    receive(records){
      for(const r of records){
        const previous=this.server[r.key];if(previous&&previous.revision>r.revision)continue;
        this.server[r.key]=clone(r);
        if(!this.queue[r.key])this.model[r.key]=clone(r);
      }
    }
    acknowledge(op,result){
      const pending=this.queue[op.key];
      if(result.conflict){
        this.conflicts[op.id]=clone(result.conflict);
        if(pending?.id===op.id)pending.blocked=true;
        return;
      }
      const r=result.record;
      if(!this.server[r.key]||this.server[r.key].revision<=r.revision)this.server[r.key]=clone(r);
      if(!pending){this.model[r.key]=clone(r);return;}
      if(pending.id===op.id){delete this.queue[r.key];this.model[r.key]=clone(this.server[r.key]);return;}
      if(pending.actor!==op.actor)return;
      // A later keystroke was based on the submitted draft, not the old server.
      const conflicts=[];
      const value=mergeValue(op.record.deleted?undefined:op.record.value,pending.record.deleted?undefined:pending.record.value,r.deleted?undefined:r.value,[],conflicts);
      if(!conflicts.length){
        pending.record={...pending.record,value:value===undefined?null:value,deleted:value===undefined};
        pending.baseRevision=r.revision;pending.baseDeleted=r.deleted;pending.baseValue=clone(r.value);this.model[r.key]=clone(pending.record);
      }
    }
    choose(conflictId,record){
      const c=this.conflicts[conflictId];if(!c)return;
      const r={...clone(record),key:c.key};this.queue[c.key]={...operation(this.server[c.key],r,this.makeId()),actor:this.actor,resolvesConflict:conflictId};this.model[c.key]=clone(r);delete this.conflicts[conflictId];
    }
    snapshot(){return clone({model:this.model,server:this.server,queue:this.queue,conflicts:this.conflicts});}
    pending(){return Object.values(this.queue).filter(op=>!op.blocked);}
  }
  return {clone,eq,split,join,meaningful,mergeValue,operation,resolve,Engine};
});
