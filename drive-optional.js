/* Drive/Calendar are optional services; their short tokens never sign out the app. */
window.installOptionalDrive=function(){
  const actions=document.getElementById('syncActions');
  // Older HTML uses a class instead of an id for this container.
  const target=actions||document.querySelector('.sync-actions')||document.getElementById('syncBar');
  const connect=document.createElement('button');connect.type='button';connect.className='ghost small';connect.textContent='Drive·캘린더 연결';
  const info=document.createElement('span');info.style.fontSize='12px';
  let client,connecting=false,backupBusy=false;
  function paint(message){connect.textContent=Drive.accessToken&&Drive.tokenExpiresAt>Date.now()?'Drive·캘린더 연결됨':'Drive·캘린더 연결';info.textContent=message||'';}
  Drive._checkToken=function(){
    if(this.accessToken&&this.tokenExpiresAt>Date.now())return;
    this.accessToken=null;this.tokenExpiresAt=0;paint();const e=new Error('Drive·캘린더 연결 버튼을 눌러 연결해 주세요. 업무 서버 저장은 계속됩니다.');e.status=401;throw e;
  };
  Drive._apiFetch=async function(url,options={}){
    this._checkToken();const token=this.accessToken,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    let response;try{response=await fetch(url,{...options,cache:'no-store',signal:controller.signal,headers:{...(options.headers||{}),Authorization:'Bearer '+token}});}finally{clearTimeout(timer);}
    if(!response.ok){if(response.status===401&&token===this.accessToken){this.accessToken=null;this.tokenExpiresAt=0;paint('Drive 재연결 필요');}const e=new Error('Drive 연결 오류 ('+response.status+')');e.status=response.status;throw e;}
    return response;
  };
  Drive.connect=function(){
    if(connecting)return;
    if(!window.google?.accounts?.oauth2){paint('구글 연결 모듈을 불러온 후 다시 눌러 주세요.');return;}
    if(!client)client=google.accounts.oauth2.initTokenClient({client_id:GOOGLE_CLIENT_ID,scope:DRIVE_SCOPE,
      callback:async result=>{
        connecting=false;if(result.error){paint('Drive 연결을 완료하지 못했습니다.');return;}
        this.accessToken=result.access_token;this.tokenExpiresAt=Date.now()+Number(result.expires_in)*1000;
        try{
          const identity=await(await this._apiFetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')).json();
          const appEmail=window.WorklogCloud?.user?.email;
          if(appEmail&&appEmail.toLowerCase()!==identity.user?.emailAddress?.toLowerCase()){this.accessToken=null;this.tokenExpiresAt=0;paint('앱에 로그인한 구글 계정으로 연결해 주세요.');return;}
          paint();syncPendingPODeliveryReminders().catch(()=>{});warmImageCache();
        }catch(e){this.accessToken=null;this.tokenExpiresAt=0;paint(e.message);}
      },error_callback:()=>{connecting=false;paint('Drive 연결이 취소됐습니다.');}});
    const request={prompt:''};const email=window.WorklogCloud?.user?.email;if(email)request.login_hint=email;
    connecting=true;paint('Drive 연결 중…');try{client.requestAccessToken(request);}catch(e){connecting=false;paint(e.message);}
  };
  connect.onclick=()=>Drive.connect();target?.append(connect,info);
  const backup=document.createElement('button');backup.type='button';backup.className='ghost small';backup.textContent='Drive에 백업';
  backup.onclick=async()=>{
    if(!Drive.accessToken||Drive.tokenExpiresAt<=Date.now()){Drive.connect();return;}
    if(backupBusy)return;backupBusy=true;backup.disabled=true;
    try{
      saveData();const boundary='backup_'+crypto.randomUUID();
      const metadata={name:'업무일지_백업_v5_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',mimeType:'application/json'};
      const content=JSON.stringify({version:5,exportedAt:Date.now(),state:WorklogCloudCore.clone(state)});
      const body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+content+'\r\n--'+boundary+'--';
      await Drive._apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});paint('Drive 백업 완료');
    }catch(e){paint('백업 대기 · '+e.message);}finally{backupBusy=false;backup.disabled=false;}
  };
  target?.appendChild(backup);setInterval(()=>{if(Drive.accessToken&&Drive.tokenExpiresAt<=Date.now()){Drive.accessToken=null;Drive.tokenExpiresAt=0;paint();}},30000);
};
