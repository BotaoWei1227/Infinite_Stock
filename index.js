const {onCall,HttpsError}=require("firebase-functions/v2/https");
const {initializeApp}=require("firebase-admin/app");
const {getFirestore,FieldValue}=require("firebase-admin/firestore");
const L=require("./logic");
initializeApp();const db=getFirestore();
const IA=process.env.IA_BASE||"https://pillars-of-creation.funtuan.work";
const O={region:"asia-east1",maxInstances:10};
const START=50,COOLDOWN=8000;
const SEED=[["fire","火","🔥",12],["water","水","💧",10],["earth","土","🪨",8],["wind","風","🌪️",9],["steam","蒸氣","♨️",18],["thunder","雷","⚡",15]];
const bad=(m)=>new HttpsError("invalid-argument",m);

// Google 登入（Firebase Auth 已驗證）：只接受 google.com 提供者
function googleUid(req){
  if(!req.auth||req.auth.token?.firebase?.sign_in_provider!=="google.com")throw new HttpsError("unauthenticated","請先以 Google 帳號登入");
  return req.auth.uid;
}
// Google 帳號 ↔ IA 工坊一對一綁定（首次動作時建立，之後不得更換）
async function ensureBind(uid,iaId){
  const l=await db.doc(`links/${uid}`).get();
  if(l.exists){if(l.data().iaId!==iaId)throw new HttpsError("failed-precondition","此 Google 帳號已綁定另一個工坊");return;}
  await db.runTransaction(async t=>{
    const [a,b]=await Promise.all([t.get(db.doc(`links/${uid}`)),t.get(db.doc(`iaLinks/${iaId}`))]);
    if(a.exists&&a.data().iaId!==iaId)throw new HttpsError("failed-precondition","此 Google 帳號已綁定另一個工坊");
    if(b.exists&&b.data().uid!==uid)throw new HttpsError("failed-precondition","此工坊已綁定另一個 Google 帳號");
    t.set(db.doc(`links/${uid}`),{iaId,at:FieldValue.serverTimestamp()});
    t.set(db.doc(`iaLinks/${iaId}`),{uid,at:FieldValue.serverTimestamp()});
  });
}

// 以玩家的 IA access token 向官方 Developer API 驗證身分（token 不記錄、不儲存）
async function iaGet(path,token){
  if(typeof token!=="string"||token.length<8||token.length>512)throw new HttpsError("unauthenticated","請先連結《無限煉製》帳號");
  for(let i=0;i<3;i++){
    const r=await fetch(`${IA}/developer-api/v1/${path}`,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(8000)});
    if(r.status===429){await new Promise(s=>setTimeout(s,(2**i)*700+Math.random()*300));continue;}
    if(r.status===401)throw new HttpsError("unauthenticated","授權失效，請重新連結《無限煉製》");
    if(r.status===403)throw new HttpsError("permission-denied","缺少所需授權範圍");
    if(!r.ok)throw new HttpsError("unavailable","《無限煉製》服務暫時無法使用");
    return r.json();
  }
  throw new HttpsError("resource-exhausted","請求過於頻繁，請稍後再試");
}
async function history(token){ // 官方最多提供最近 500 筆；不假設排序，全部掃過
  const all=[];let off=0;
  for(let n=0;off!=null&&n<5;n++){const p=await iaGet(`history?limit=100&offset=${off}`,token);all.push(...p.items);off=p.nextOffset;}
  return all;
}
async function judge(stock,item,key,model){
  if(typeof key!=="string"||key.length<10||key.length>200)throw bad("請先填入 Google API Key");
  const m=/^[a-z0-9.\-]{3,40}$/.test(model||"")?model:"gemini-3.5-flash";
  const prompt=`你是奇幻煉金交易所的裁判。股票主題：「${stock}」。玩家投入的造物：「${item}」。判斷這個造物與該主題的關聯程度（元素、組成、象徵、常識聯想皆可），只回傳 JSON：{"score":0到100的整數,"reason":"20字內繁體中文理由"}。`;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,{method:"POST",
    headers:{"Content-Type":"application/json","x-goog-api-key":key},signal:AbortSignal.timeout(20000),
    body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json",temperature:.2}})});
  if(!r.ok)throw new HttpsError("failed-precondition",r.status===429?"Gemini 額度用盡或請求過快":`Gemini 錯誤 ${r.status}（請確認 Key 與模型名稱）`);
  const j=await r.json();
  let o;try{o=JSON.parse((j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").replace(/```json|```/g,"").trim());}
  catch{throw new HttpsError("internal","AI 回應格式錯誤，請重試");}
  return {score:Math.max(0,Math.min(100,parseInt(o.score)||0)),reason:String(o.reason||"").slice(0,40)};
}

exports.ensureMarket=onCall(O,async()=>{
  await db.runTransaction(async t=>{
    if(!(await t.get(db.collection("stocks").limit(1))).empty)return;
    for(const [id,name,emoji,price] of SEED)t.set(db.doc(`stocks/${id}`),{name,emoji,price,last:"",updatedAt:FieldValue.serverTimestamp()});
  });
  return {ok:true};
});

exports.inject=onCall(O,async req=>{
  const {stockId,itemName,iaToken,geminiKey,model}=req.data||{};
  if(typeof stockId!=="string"||!/^[a-z]{2,20}$/.test(stockId)||typeof itemName!=="string"||!itemName||itemName.length>60)throw bad("參數錯誤");
  const uid=googleUid(req);
  const me=await iaGet("me",iaToken);                       // 身分一律由 IA 回傳，不信任客戶端
  await ensureBind(uid,me.id);
  const pref=db.doc(`players/${me.id}`),sref=db.doc(`stocks/${stockId}`);
  const [p0,s0]=await Promise.all([pref.get(),sref.get()]);
  if(!s0.exists)throw new HttpsError("not-found","找不到這檔股票");
  const cool=p=>p.exists&&Date.now()-(p.data().lastInjectAt||0)<COOLDOWN;
  if(cool(p0))throw new HttpsError("resource-exhausted","投入太頻繁，請稍候幾秒");
  if(!L.recent(await history(iaToken),Date.now()).has(itemName))throw new HttpsError("permission-denied","只能投入 24 小時內做出的造物");
  const j=await judge(s0.data().name,itemName,geminiKey,model);
  const pct=L.roll(j.score,Math.random(),Math.random());
  let price;
  await db.runTransaction(async t=>{
    const [p,s]=await Promise.all([t.get(pref),t.get(sref)]);
    if(cool(p))throw new HttpsError("resource-exhausted","投入太頻繁，請稍候幾秒");
    price=L.applyPct(s.data().price,pct);
    const who=me.workshopName||"無名工坊";
    t.update(sref,{price,updatedAt:FieldValue.serverTimestamp(),last:`${itemName}（${j.score}分）`});
    t.set(pref,{...(p.exists?{}:{cash:START,hold:{}}),name:who,lastInjectAt:Date.now()},{merge:true});
    t.set(db.collection("feed").doc(),{who,stock:s.data().name,item:itemName,score:j.score,reason:j.reason,pct:Math.round(pct*1000)/10,at:FieldValue.serverTimestamp()});
  });
  return {...j,pct:Math.round(pct*1000)/10,price};
});

exports.trade=onCall(O,async req=>{
  const {stockId,dir,iaToken}=req.data||{};
  if(typeof stockId!=="string"||!/^[a-z]{2,20}$/.test(stockId)||(dir!==1&&dir!==-1))throw bad("參數錯誤");
  const uid=googleUid(req);
  const me=await iaGet("me",iaToken);
  await ensureBind(uid,me.id);
  const pref=db.doc(`players/${me.id}`),sref=db.doc(`stocks/${stockId}`);
  await db.runTransaction(async t=>{
    const [p,s]=await Promise.all([t.get(pref),t.get(sref)]);
    if(!s.exists)throw new HttpsError("not-found","找不到這檔股票");
    let r;try{r=L.trade(p.exists?p.data():{cash:START,hold:{}},stockId,s.data().price,dir);}
    catch(e){throw new HttpsError("failed-precondition",e.message);}
    t.set(pref,{name:me.workshopName||"無名工坊",cash:r.cash,hold:r.hold},{merge:true});
  });
  return {ok:true};
});
