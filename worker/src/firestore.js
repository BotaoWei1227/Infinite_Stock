// 以服務帳戶透過 Firestore REST 讀寫（Worker 不能用 Admin SDK）
import {HttpError} from "./errors.js";
const te=new TextEncoder();
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");

export function encode(v){
  if(v===null)return {nullValue:null};
  if(typeof v==="boolean")return {booleanValue:v};
  if(typeof v==="number")return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
  if(typeof v==="string")return {stringValue:v};
  return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]))}};
}
export function decode(f){
  if("integerValue" in f)return Number(f.integerValue);
  if("doubleValue" in f)return f.doubleValue;
  if("stringValue" in f)return f.stringValue;
  if("booleanValue" in f)return f.booleanValue;
  if("timestampValue" in f)return Date.parse(f.timestampValue);
  if("mapValue" in f)return Object.fromEntries(Object.entries(f.mapValue.fields||{}).map(([k,x])=>[k,decode(x)]));
  return null;
}

let cache={tok:null,exp:0};
export const _resetToken=()=>{cache={tok:null,exp:0};};
async function accessToken(env,fetchFn){
  if(cache.tok&&Date.now()<cache.exp-60000)return cache.tok;
  let sa;try{sa=JSON.parse(env.FIREBASE_SA);}catch{throw new HttpError(500,"internal","伺服器設定錯誤");}
  const now=Math.floor(Date.now()/1000);
  const hdr=b64u(te.encode(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const pl=b64u(te.encode(JSON.stringify({iss:sa.client_email,scope:"https://www.googleapis.com/auth/datastore",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})));
  const der=Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g,"")),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey("pkcs8",der,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const sig=b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,te.encode(hdr+"."+pl)));
  const r=await fetchFn("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${hdr}.${pl}.${sig}`})});
  if(!r.ok)throw new HttpError(503,"unavailable","資料庫授權失敗");
  const j=await r.json();cache={tok:j.access_token,exp:Date.now()+j.expires_in*1000};return cache.tok;
}

export function makeDb(env,fetchFn=fetch){
  const root=`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
  const api=`https://firestore.googleapis.com/v1/${root}/documents`;
  const H=async()=>({Authorization:"Bearer "+await accessToken(env,fetchFn),"Content-Type":"application/json"});
  return {
    async get(path){
      const r=await fetchFn(`${api}/${path}`,{headers:await H()});
      if(r.status===404)return null;
      if(!r.ok)throw new HttpError(503,"unavailable","資料庫暫時無法使用");
      const d=await r.json();
      return {data:decode({mapValue:{fields:d.fields||{}}}),version:d.updateTime};
    },
    async empty(col){
      const r=await fetchFn(`${api}/${col}?pageSize=1`,{headers:await H()});
      if(!r.ok)throw new HttpError(503,"unavailable","資料庫暫時無法使用");
      const d=await r.json();return !(d.documents&&d.documents.length);
    },
    // ops: [{path, data, ts:[欄位], pre}]；pre=null 代表必須不存在，字串代表 updateTime 必須相符；整批原子提交
    async commit(ops){
      const writes=ops.map(o=>{
        const w={update:{name:`${root}/documents/${o.path}`,fields:encode(o.data||{}).mapValue.fields},updateMask:{fieldPaths:Object.keys(o.data||{})}};
        if(o.ts?.length)w.updateTransforms=o.ts.map(f=>({fieldPath:f,setToServerValue:"REQUEST_TIME"}));
        if(o.pre===null)w.currentDocument={exists:false};else if(o.pre)w.currentDocument={updateTime:o.pre};
        return w;
      });
      const r=await fetchFn(`${api}:commit`,{method:"POST",headers:await H(),body:JSON.stringify({writes})});
      if(r.ok)return;
      const st=(await r.json().catch(()=>({}))).error?.status;
      if(r.status===409||["ABORTED","FAILED_PRECONDITION","ALREADY_EXISTS"].includes(st))throw new HttpError(409,"conflict","系統忙碌，請再試一次");
      throw new HttpError(503,"unavailable","資料庫暫時無法使用");
    }
  };
}
