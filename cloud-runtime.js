/* App integration: durable drafts, record transactions, account isolation. */
window.installCloudWorklog=function(){
  'use strict';
  const R=WorklogCloudCore,KEY=STORAGE_KEY,config=window.WORKLOG_CLOUD_CONFIG||{},id=()=>crypto.randomUUID(),actor=id();
  const saved=state._cloudV5;let owner=saved?.owner||null,email=saved?.email||localStorage.getItem('drive_user_email')||'';
  let engine=new R.Engine(state,saved,id,actor),user=null,backend=null,readyAuth=false,serverSeen=false;
  state=R.join(engine.model,state);
  let sequence=saved?.sequence||0,bootSequence=sequence,localOK=true,flushing=false,syncing=false,syncAgain=false,paused=false,epoch=0,retries=0,lastSync=0,lastError='';
  let timer=null,stopRecords=null,stopConflicts=null,deferredRecords=null,renderPending=false,authBusy=false;
  let durable=Promise.resolve(),databasePromise;
  function database(){
    if(!databasePromise)databasePromise=new Promise((resolve,reject)=>{
      const req=indexedDB.open('worklog-cloud-v5',1);
      req.onupgradeneeded=()=>req.result.createObjectStore('snapshots');
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });return databasePromise;
  }
  async function put(key,value){const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put(value,key);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
  });}
  async function get(key){const db=await database();return new Promise((resolve,reject)=>{
    const req=db.transaction('snapshots').objectStore('snapshots').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });}
  const accountKey=()=>owner?'account:'+owner:'guest';
  const draftKey=()=> 'draft:'+accountKey()+':'+actor;
  function localDrafts(){const entries=[];try{const prefix='worklog-v5:draft:'+accountKey()+':';for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix)){const v=JSON.parse(localStorage.getItem(key));if(v)entries.push(v);}}}catch(_){}return entries;}
  async function drafts(){try{const db=await database();return await new Promise((resolve,reject)=>{
    const prefix='draft:'+accountKey()+':',req=db.transaction('snapshots').objectStore('snapshots').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));
    req.onsuccess=()=>{const merged=new Map(req.result.map(v=>[v._draftKey,v]));for(const v of localDrafts()){const old=merged.get(v._draftKey);if(!old||old._cloudV5.sequence<v._cloudV5.sequence)merged.set(v._draftKey,v);}resolve([...merged.values()]);};req.onerror=()=>reject(req.error);
  });}catch(_){return localDrafts();}}
  async function clearDraftOperation(key,op){
    if(key!==draftKey())try{localStorage.setItem('worklog-v5:ack:'+accountKey()+':'+op.id,'1');}catch(_){}
    try{const db=await database();return await new Promise((resolve,reject)=>{
    const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots'),req=store.get(key);
    req.onsuccess=()=>{const data=req.result;if(data?._cloudV5?.queue[op.key]?.id===op.id){delete data._cloudV5.queue[op.key];if(!Object.keys(data._cloudV5.queue).length&&key!==draftKey())store.delete(key);else store.put(data,key);}};
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
    });}catch(_){try{localStorage.setItem('worklog-v5:ack:'+accountKey()+':'+op.id,'1');}catch(_){}} }
  const envelope=()=>({...R.clone(state),_cloudV5:{...engine.snapshot(),owner,email,sequence,savedAt:Date.now()}});
  function memoStatus(text,error=false){const el=document.getElementById('memoStatus');if(el){el.textContent=text;el.style.color=error?'#c0392b':'';el.classList.add('show');}}
  function editing(){return editingId!=null||document.activeElement?.matches('input,textarea,select,[contenteditable="true"],iframe')||!!document.querySelector('.modal.show');}
  function redraw(){if(editing()){renderPending=true;return;}renderPending=false;render();}
  function view(){state=R.join(engine.model,state);redraw();}
  function status(error){
    const txt=document.getElementById('syncText'),dot=document.getElementById('syncDot'),login=document.getElementById('loginBtn'),sync=document.getElementById('syncNowBtn'),logout=document.getElementById('logoutBtn');
    const conflicts=Object.keys(engine.conflicts).length,pending=Object.keys(engine.queue).length;
    let text,kind='offline';
    if(error)lastError=error;
    if(lastError){text=lastError;kind='error';}
    else if(!localOK){text='기기 저장 실패 · 창을 닫기 전에 백업해 주세요';kind='error';}
    else if(!config.enabled)text='이 기기 저장됨 · 서버 연결 설정 대기';
    else if(!readyAuth)text='이 기기 저장됨 · 로그인 확인 중';
    else if(!user)text='이 기기 저장됨 · 로그인 후 서버에 전송';
    else if(conflicts){text=`수정 충돌 ${conflicts}건 · 양쪽 내용 보관됨`;kind='error';}
    else if(navigator.onLine===false)text='이 기기 저장됨 · 인터넷 연결 후 전송';
    else if(syncing||pending){text=pending?`이 기기 저장됨 · 서버 전송 ${pending}건 대기`:'이 기기 저장됨 · 서버 저장 확인 중';kind='syncing';}
    else if(!serverSeen)text='이 기기 저장됨 · 서버 연결 확인 중';
    else{text='서버 저장 완료 · '+new Date(lastSync||Date.now()).toLocaleTimeString('ko-KR');kind='synced';}
    if(txt)txt.textContent=text;if(dot)dot.className='sync-dot '+kind;
    const who=document.getElementById('syncEmail');if(who)who.textContent=user?'· '+user.email:'';
    if(login){login.textContent='구글로 로그인';login.style.display=user?'none':'';login.disabled=!backend?.auth||authBusy;}
    if(sync)sync.style.display=user?'':'none';
    if(logout){logout.textContent='로그아웃';logout.style.display=user?'':'none';}
    const badge=document.getElementById('cloudConflictButton');if(badge){badge.textContent=`수정 충돌 확인 (${conflicts})`;badge.style.display=conflicts?'':'none';}
    return text;
  }
  updateSyncUI=()=>status();
  updateStorageInfo=function(){const el=document.getElementById('storageInfo');if(el)el.textContent=(user?user.email+' · ':'')+(localOK?'이 기기에 복구본 보관 중':'기기 저장 확인 필요');};
  function persist(){
    const payload=envelope(),key=accountKey(),draft=draftKey(),seq=sequence;let syncOK=true;
    try{localStorage.setItem('worklog-v5:'+draft,JSON.stringify({...payload,_draftKey:draft}));if(window.worklogBrokenStorage)throw new Error('원본 복구본 보관 대기');localStorage.setItem(KEY,JSON.stringify(payload));localOK=true;}catch(_){localOK=false;syncOK=false;}
    durable=durable.catch(()=>{}).then(()=>put(draft,{...payload,_draftKey:draft})).then(()=>put(key,payload)).then(()=>{
      // The private per-tab IndexedDB journal is durable now. Keep localStorage
      // small; a newer draft must never be removed by this older callback.
      try{const mirrored=JSON.parse(localStorage.getItem('worklog-v5:'+draft)||'null');if(mirrored?._cloudV5.sequence===seq&&sequence===seq)localStorage.removeItem('worklog-v5:'+draft);}catch(_){}
      if(sequence===seq){localOK=true;if(!syncOK)memoStatus('✓ 이 기기 복구 저장소에 저장됨');status();}return true;
    }).catch(()=>{if(sequence===seq&&!syncOK){memoStatus('저장 실패 · 백업 필요',true);status();}return syncOK;});
    return syncOK;
  }
  function checkpoint(){
    const slot='history:'+accountKey()+':'+(Math.floor(Date.now()/60000)%60),payload=envelope();
    return get(slot).then(old=>{if(old&&Math.floor(old._cloudV5.savedAt/60000)===Math.floor(Date.now()/60000))return;return put(slot,payload);}).catch(()=>{});
  }
  function capture(){const changed=engine.capture(state);if(changed){sequence++;checkpoint();}return changed;}
  saveData=function(){capture();const ok=persist();memoStatus(ok?'✓ 이 기기에 저장됨':'기기 저장 실패 · 복구 저장 시도 중',!ok);updateStorageInfo();status();schedule();return ok;};
  saveMemo=function(){state.todayMemo=document.getElementById('todayMemo').value;return saveData();};
  function schedule(delay=900){clearTimeout(timer);if(!user||paused)return;timer=setTimeout(flush,delay);}
  function retry(error){
    if(['permission-denied','unauthenticated','failed-precondition'].includes(error?.code)||navigator.onLine===false)return;
    schedule(Math.min(60000,1000*2**Math.min(retries++,6)));
  }
  async function flush(){
    if(!user||!backend||paused||navigator.onLine===false){status();return false;}
    if(flushing){syncAgain=true;return false;}
    clearTimeout(timer);timer=null;flushing=true;
    let completed=false;const attemptEpoch=epoch,uid=user.uid;
    try{
      if(capture())persist();
      if(!await durable)throw new Error('기기 복구 저장을 완료하지 못했습니다. 백업을 먼저 보관해 주세요.');
      const journal=await drafts(),operations=new Map();
      const collect=(op,source)=>{
        if(!operations.has(op.id))operations.set(op.id,{op:R.clone(op),sources:new Set()});
        const entry=operations.get(op.id);entry.sources.add(source);return entry;
      };
      for(const entry of journal)for(const op of Object.values(entry._cloudV5.queue||{}))if(!op.blocked&&!localStorage.getItem('worklog-v5:ack:'+accountKey()+':'+op.id))collect(op,entry._draftKey);
      for(const op of engine.pending())collect(op,draftKey()).op=R.clone(op);
      // An idle check must not publish a new snapshot or flash an upload state.
      // Rewriting KEY here makes other tabs request another identical check.
      if(!operations.size){completed=true;return Object.keys(engine.queue).length===0;}
      syncing=true;lastError='';status();
      for(const {op,sources} of [...operations.values()].sort((a,b)=>a.op.createdAt-b.op.createdAt)){
        if(attemptEpoch!==epoch)return false;
        const result=await backend.commit(uid,op);
        if(attemptEpoch!==epoch)return false;
        capture();engine.acknowledge(op,result);sequence++;state=R.join(engine.model,state);persist();await durable;
        for(const source of sources)await clearDraftOperation(source,op);
        if(op.resolvesConflict&&!result.conflict)await backend.resolveConflict(uid,op.resolvesConflict);
      }
      retries=0;lastSync=Date.now();serverSeen=true;completed=true;redraw();return Object.keys(engine.queue).length===0;
    }catch(e){status(e.code==='permission-denied'?'서버 접근 설정을 확인해야 합니다 · 기기 기록은 보존됨':e.code==='unauthenticated'?'로그인 확인이 필요합니다 · 기기 기록은 보존됨':'서버 저장 대기 · '+e.message);retry(e);return false;}
    finally{flushing=false;syncing=false;status();if(syncAgain){syncAgain=false;schedule();}else if(completed&&engine.pending().length)schedule();}
  }
  function receive(records,fromServer){
    if(editing()){deferredRecords={records,fromServer};return;}
    if(records.every(record=>R.eq(engine.server[record.key],record))){
      if(fromServer){serverSeen=true;if(!lastSync)lastSync=Date.now();}status();return;
    }
    capture();engine.receive(records);if(fromServer){serverSeen=true;lastSync=Date.now();}state=R.join(engine.model,state);sequence++;persist();redraw();status();
  }
  document.addEventListener('focusout',()=>setTimeout(()=>{
    if(!editing()&&deferredRecords){const d=deferredRecords;deferredRecords=null;receive(d.records,d.fromServer);}
    else if(!editing()&&renderPending)redraw();
  },0));
  // Modals may close without a focusout event; always release deferred snapshots.
  setInterval(()=>{if(!editing()&&deferredRecords){const d=deferredRecords;deferredRecords=null;receive(d.records,d.fromServer);}},1500);
  async function switchUser(next){
    const token=++epoch;stopRecords?.();stopConflicts?.();stopRecords=stopConflicts=null;
    capture();persist();await durable;readyAuth=true;
    if(token!==epoch)return;
    user=next;serverSeen=false;paused=false;deferredRecords=null;lastError='';
    if(!next){status();return;}
    if(owner!==next.uid){
      const previousOwner=owner,previousEmail=email;
      const existing=await get('account:'+next.uid).catch(()=>{
        try{const candidates=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith('worklog-v5:draft:account:'+next.uid+':'))candidates.push(JSON.parse(localStorage.getItem(key)));}return candidates.sort((a,b)=>b._cloudV5.savedAt-a._cloudV5.savedAt)[0]||null;}catch(_){return null;}
      });
      if(token!==epoch)return;
      const mayMigrate=!previousOwner&&(!previousEmail||previousEmail.toLowerCase()===next.email?.toLowerCase());
      const guestDrafts=mayMigrate?await drafts().catch(()=>[]):[];
      if(existing){state=R.clone(existing);engine=new R.Engine(state,existing._cloudV5,id,actor);}
      else if(!mayMigrate){state=loadData(null);engine=new R.Engine(state,null,id,actor);}
      owner=next.uid;email=next.email||'';sequence++;persist();await durable;
      for(const draft of guestDrafts){
        const key='draft:account:'+owner+':import:'+WorklogSyncCore.hash(draft._draftKey);
        const imported={...draft,_draftKey:key,_cloudV5:{...draft._cloudV5,owner,email}};
        try{await put(key,imported);}catch(_){localStorage.setItem('worklog-v5:'+key,JSON.stringify(imported));}
      }
    }
    if(token!==epoch)return;
    email=next.email||'';Drive.userEmail=email;
    hideLoginGate();hideGuestBanner();view();updateStorageInfo();status();
    stopRecords=backend.watch(next.uid,(records,real)=>{if(token===epoch)receive(records,real);},e=>{if(token===epoch)status('서버 연결 대기 · '+e.message);});
    stopConflicts=backend.watchConflicts(next.uid,(conflicts,removed=[])=>{
      if(token!==epoch)return;
      for(const conflictId of removed){const previous=engine.conflicts[conflictId];delete engine.conflicts[conflictId];if(previous&&engine.queue[previous.key]?.id===conflictId&&engine.queue[previous.key]?.blocked){delete engine.queue[previous.key];if(!editing()&&engine.server[previous.key])engine.model[previous.key]=R.clone(engine.server[previous.key]);else deferredRecords={records:Object.values(engine.server),fromServer:true};}}
      for(const conflict of conflicts)engine.conflicts[conflict.id]=conflict;
      if(removed.length&&!editing())view();persist();status();
    },e=>status('충돌 기록 확인 대기 · '+e.message));
    schedule(0);
  }
  async function init(){
    if(window.worklogBrokenStorage){
      try{await put('damaged-source:'+Date.now(),window.worklogBrokenStorage);await put('damaged-source:'+accountKey(),window.worklogBrokenStorage);window.worklogBrokenStorage=null;}catch(_){status('기존 저장본 복구 확인이 필요합니다 · 원본은 보존됨');}
    }
    const recovered=await get(accountKey()).catch(()=>null);
    if(recovered?._cloudV5&&recovered._cloudV5.sequence>bootSequence){
      // Do not replace keystrokes entered while IndexedDB was opening.
      if(sequence===bootSequence){state=R.clone(recovered);engine=new R.Engine(state,recovered._cloudV5,id,actor);sequence=recovered._cloudV5.sequence;view();}
    }
    persist();hideLoginGate();status();
    if(!config.enabled||!config.firebase)return;
    try{backend=new WorklogCloudBackend(config);await backend.init(next=>switchUser(next).catch(e=>{paused=true;status('계정 기록 복구 확인 필요 · '+e.message);}));status();}
    catch(e){readyAuth=true;status('서버 연결 준비 실패 · '+e.message);}
  }
  driveLogin=async function(){
    if(!backend?.auth){status('서버 연결 설정이 필요합니다 · 이 기기 저장은 계속됩니다');return;}
    if(authBusy)return;authBusy=true;status();
    try{await backend.login();}catch(e){status(e.code==='auth/popup-closed-by-user'?'로그인을 취소했습니다 · 기기 기록은 보존됨':'로그인 연결 확인 필요 · '+e.message);}
    finally{authBusy=false;status();}
  };
  driveLogout=async function(){
    capture();persist();if(!await durable){status('로그아웃 전 백업을 보관해 주세요 · 기기 저장 실패');return;}
    if(!confirm('로그아웃할까요? 이 기기의 기록과 서버 전송 대기 내용은 보존됩니다.'))return;
    paused=true;++epoch;clearTimeout(timer);stopRecords?.();stopConflicts?.();await backend?.logout();user=null;status();showLoginGate('login');
  };
  driveSyncNow=()=>{saveData();return user?flush():driveLogin();};forceDriveSync=()=>{saveData();return flush();};
  Drive.init=init;Drive.resume=()=>{status();if(engine.pending().length)schedule(0);};Drive.schedulePush=()=>schedule();Drive.pullFromDrive=flush;Drive.pushToDrive=flush;Drive.login=driveLogin;Drive.logout=driveLogout;
  window.addEventListener('pagehide',()=>{capture();persist();});
  window.addEventListener('online',()=>{retries=0;schedule(0);});window.addEventListener('offline',()=>status());
  window.addEventListener('storage',ev=>{
    if(ev.key!==KEY)return;
    // Each tab keeps its own pending drafts; server transactions arbitrate edits.
    // Never adopt another tab's entire snapshot or credentials.
    if(!user||!ev.newValue)return;
    try{
      const incoming=JSON.parse(ev.newValue)._cloudV5;
      if(incoming?.owner===owner&&Object.values(incoming.queue||{}).some(op=>!op.blocked))schedule(0);
    }catch(_){}
  });
  exportBackup=function(){capture();persist();download('업무일지_백업_'+todayStr()+'.json',envelope());};
  function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  window.exportSyncRecovery=async function(){const versions=[];for(let i=0;i<60;i++){const v=await get('history:'+accountKey()+':'+i).catch(()=>null);if(v)versions.push(v);}download('업무일지_복구기록_'+todayStr()+'.json',{current:envelope(),versions,damagedSource:window.worklogBrokenStorage||await get('damaged-source:'+accountKey()).catch(()=>null)});};
  const controls=document.getElementById('storageInfo')?.parentElement;
  function button(text,onclick,parent=controls){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=onclick;parent?.appendChild(b);return b;}
  function modal(title){
    document.getElementById('cloudReviewModal')?.remove();const wrap=document.createElement('div');wrap.id='cloudReviewModal';wrap.className='modal show';
    const box=document.createElement('div');box.className='modal-content';box.style.maxWidth='850px';
    const h=document.createElement('h2');h.textContent=title;box.appendChild(h);button('닫기',()=>wrap.remove(),box);
    wrap.appendChild(box);document.body.appendChild(wrap);return box;
  }
  function preview(box,value){const el=document.createElement('pre');el.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;background:#f5f7fa;padding:12px;';el.textContent=value?.task?value.task.text+'\n\n'+(value.task.notes||''):typeof value==='string'?value:JSON.stringify(value,null,2);box.appendChild(el);}
  async function showHistory(){
    const box=modal('변경 이력 · 복원');
    if(!user){preview(box,'서버에 로그인하면 저장된 업무별 이전 내용을 확인하고 복원할 수 있습니다. 기기 백업은 관리 메뉴에서 보관할 수 있습니다.');return;}
    const select=document.createElement('select');select.style.width='100%';box.appendChild(select);
    const records=Object.values(engine.model).filter(r=>!['date','attachments'].includes(r.kind));
    for(const r of records){const o=document.createElement('option');o.value=r.key;o.textContent=r.kind==='task'?'업무: '+r.value?.task?.text:r.kind==='list'?(r.value?.name||r.value?.text||r.field):r.key;select.appendChild(o);}
    const list=document.createElement('div');box.appendChild(list);let queryVersion=0;
    async function load(beforeRevision){
      const key=select.value,request=++queryVersion;if(!beforeRevision)list.replaceChildren();
      try{const rows=await backend.history(user.uid,key,beforeRevision);if(request!==queryVersion)return;
        for(const r of rows){const section=document.createElement('section');section.style.cssText='border-top:1px solid #ddd;margin-top:12px;padding:10px;';const label=document.createElement('strong');label.textContent=`버전 ${r.revision} · ${r.savedAt?new Date(r.savedAt).toLocaleString('ko-KR'):''}${r.deleted?' · 삭제 기록':''}`;section.appendChild(label);preview(section,r.value);
          button('이 버전으로 복원',()=>{
            if(!confirm('선택한 업무를 이 버전으로 복원할까요? 현재 내용도 변경 이력에 보존됩니다.'))return;
            capture();checkpoint();engine.queue[key]={...R.operation(engine.server[key],r,id()),actor};engine.model[key]=R.clone(r);state=R.join(engine.model,state);sequence++;persist();schedule(0);box.parentElement.remove();redraw();status();
          },section);list.appendChild(section);
        }
        if(!rows.length)preview(list,'이 항목의 서버 저장 이력이 아직 없습니다.');
        if(rows.length===50){const more=button('이전 기록 50개 더 보기',()=>{more.remove();load(rows.at(-1).revision);},list);}
      }catch(e){if(request===queryVersion)preview(list,'변경 이력 연결 대기 · '+e.message);}
    }
    select.onchange=()=>load();load();
  }
  function showConflicts(){
    const box=modal('수정 충돌 · 양쪽 내용 보관');
    for(const c of Object.values(engine.conflicts)){
      const section=document.createElement('section');section.style.cssText='border-top:1px solid #ddd;padding:12px;';box.appendChild(section);
      const local=JSON.parse(c.local),remote=JSON.parse(c.remote);const label=document.createElement('strong');label.textContent='이 기기에서 작성한 내용';section.appendChild(label);preview(section,local.deleted?'삭제 요청':local.value);
      const remoteLabel=document.createElement('strong');remoteLabel.textContent='서버에 저장된 내용';section.appendChild(remoteLabel);preview(section,remote?.deleted?'삭제 기록':remote?.value);
      const choose=r=>{capture();checkpoint();engine.choose(c.id,r||{...local,value:null,deleted:true});state=R.join(engine.model,state);sequence++;persist();schedule(0);section.remove();redraw();status();};
      button('이 기기 내용 사용',()=>choose(local),section);button('서버 내용 사용',()=>choose(remote),section);
    }
  }
  button('변경 이력 · 복원',showHistory);
  button('기기 복구본 내보내기',window.exportSyncRecovery);
  const conflictButton=button('수정 충돌 확인',showConflicts);conflictButton.id='cloudConflictButton';conflictButton.style.display='none';
  window.WorklogCloud={flush,status,get user(){return user;},get engine(){return engine;},get ready(){return readyAuth;},get backend(){return backend;}};
  window.worklogSyncDiagnostics={version:5,get pending(){return Object.keys(engine.queue).length;},get conflicts(){return Object.keys(engine.conflicts).length;},get localError(){return !localOK;}};
  status();
};
