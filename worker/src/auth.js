// 驗證 Firebase ID Token（RS256，Google 公鑰），不依賴 Admin SDK
import {HttpError} from "./errors.js";
const te=new TextEncoder(),td=new TextDecoder();
const unb64=s=>{s=s.replace(/-/g,"+").replace(/_/g,"/");s+="=".repeat((4-s.length%4)%4);return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
const J=s=>JSON.parse(td.decode(unb64(s)));
const JWKS="https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwks={keys:[],at:0};
export const _reset=()=>{jwks={keys:[],at:0};};
export async function verifyFirebaseToken(request,env,fetchFn=fetch,now=Date.now()){
  const bad=()=>new HttpError(401,"unauthenticated","請先以 Google 帳號登入");
  const m=/^Bearer (.+)$/.exec(request.headers.get("Authorization")||"");if(!m)throw bad();
  const p=m[1].split(".");if(p.length!==3)throw bad();
  let h,c;try{h=J(p[0]);c=J(p[1]);}catch{throw bad();}
  if(h.alg!=="RS256"||!h.kid)throw bad();
  let jwk=jwks.keys.find(k=>k.kid===h.kid);
  if(!jwk&&now-jwks.at>60000){
    const r=await fetchFn(JWKS);if(!r.ok)throw new HttpError(503,"unavailable","驗證服務暫時無法使用");
    jwks={keys:(await r.json()).keys||[],at:now};jwk=jwks.keys.find(k=>k.kid===h.kid);
  }
  if(!jwk)throw bad();
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  if(!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,unb64(p[2]),te.encode(p[0]+"."+p[1]))))throw bad();
  const pid=env.FIREBASE_PROJECT_ID;
  if(c.iss!==`https://securetoken.google.com/${pid}`||c.aud!==pid||!c.sub||!(c.exp*1000>now)||c.iat*1000>now+60000)throw bad();
  return {uid:c.sub,provider:c.firebase?.sign_in_provider,name:typeof c.name==="string"?c.name.slice(0,40):"",
    email:typeof c.email==="string"?c.email.toLowerCase():"",emailVerified:c.email_verified===true};
}
