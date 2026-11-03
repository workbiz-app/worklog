/* Firebase is the authority for records, sessions, and immutable history. */
window.WorklogCloudBackend = class {
  constructor(config){this.config=config;}
  async init(onUser){
    const version=this.config.sdkVersion;
    if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('서버 연결 모듈 버전을 확인해 주세요.');
    for(const name of ['app','auth','firestore']){
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src=`https://www.gstatic.com/firebasejs/${version}/firebase-${name}-compat.js`;
        script.onload=resolve;script.onerror=()=>reject(new Error('로그인 모듈을 불러오지 못했습니다. 기기 저장은 계속됩니다.'));document.head.appendChild(script);
      });
    }
    this.app=firebase.apps.find(a=>a.name==='worklog-v5')||firebase.initializeApp(this.config.firebase,'worklog-v5');
    this.auth=this.app.auth();this.db=this.app.firestore();
    // The SDK renews the app session; Drive OAuth expiry has no role here.
    await this.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    this.stopAuth=this.auth.onAuthStateChanged(onUser);
  }
  login(){const p=new firebase.auth.GoogleAuthProvider();p.setCustomParameters({prompt:'select_account'});return this.auth.signInWithPopup(p);}
  logout(){return this.auth.signOut();}
  scope(uid){return this.db.collection('users').doc(uid);}
  id(key){const bytes=new TextEncoder().encode(key);let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  encode(record){
    const {value,...info}=record;
    const payload=JSON.stringify(value??null), descriptor=JSON.stringify(Object.fromEntries(Object.entries(info).filter(([k])=>!['revision','operationId','deleted','updatedAt'].includes(k))));
    if(new TextEncoder().encode(payload).length>850000)throw new Error('첨부를 포함한 이 업무의 크기가 큽니다. 기기 기록은 보존돼 있습니다.');
    return {key:record.key,descriptor,payload,deleted:!!record.deleted,revision:record.revision,operationId:record.operationId,updatedAt:firebase.firestore.FieldValue.serverTimestamp()};
  }
  decode(d){return {...JSON.parse(d.descriptor),value:JSON.parse(d.payload),deleted:d.deleted,revision:d.revision,operationId:d.operationId};}
  watch(uid,onRecords,onError){return this.scope(uid).collection('records').onSnapshot({includeMetadataChanges:true},snapshot=>onRecords(snapshot.docs.map(d=>this.decode(d.data())),!snapshot.metadata.fromCache),onError);}
  watchConflicts(uid,onConflicts,onError){return this.scope(uid).collection('conflicts').where('resolved','==',false).onSnapshot(snapshot=>onConflicts(snapshot.docs.map(d=>({id:d.id,...d.data()})),snapshot.docChanges().filter(c=>c.type==='removed').map(c=>c.doc.id)),onError);}
  async commit(uid,op){
    const scope=this.scope(uid),id=this.id(op.key),ref=scope.collection('records').doc(id);
    const receipt=scope.collection('operations').doc(op.id),history=ref.collection('history').doc(op.id),conflict=scope.collection('conflicts').doc(op.id);
    return this.db.runTransaction(async tx=>{
      const acknowledged=await tx.get(receipt);
      if(acknowledged.exists){
        if(acknowledged.data().status==='conflict')return {conflict:{id:op.id,...(await tx.get(conflict)).data()}};
        return {record:this.decode((await tx.get(history)).data())};
      }
      const snap=await tx.get(ref),current=snap.exists?this.decode(snap.data()):null;
      const decision=WorklogCloudCore.resolve(current,op);
      if(decision.conflicts.length){
        const data={key:op.key,recordId:id,base:JSON.stringify(op.baseValue??null),baseDeleted:op.baseDeleted,
          local:JSON.stringify(op.record),remote:JSON.stringify(current),paths:decision.conflicts,resolved:false,createdAt:firebase.firestore.FieldValue.serverTimestamp()};
        tx.set(conflict,data);tx.set(receipt,{key:op.key,status:'conflict',createdAt:firebase.firestore.FieldValue.serverTimestamp()});
        return {conflict:{id:op.id,...data}};
      }
      const data=this.encode(decision.record);
      tx.set(ref,data);tx.set(history,data);tx.set(receipt,{key:op.key,status:'applied',revision:data.revision,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      return {record:decision.record};
    });
  }
  async history(uid,key,beforeRevision){
    let query=this.scope(uid).collection('records').doc(this.id(key)).collection('history').orderBy('revision','desc');
    if(beforeRevision)query=query.startAfter(beforeRevision);
    const snap=await query.limit(50).get();
    return snap.docs.map(d=>({id:d.id,...this.decode(d.data()),savedAt:d.data().updatedAt?.toDate?.()?.toISOString()||''}));
  }
  resolveConflict(uid,id){return this.scope(uid).collection('conflicts').doc(id).update({resolved:true,resolvedAt:firebase.firestore.FieldValue.serverTimestamp()});}
};
