import test from "node:test";import assert from "node:assert";
import {verifyFirebaseToken,_reset} from "../src/auth.js";
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const te=new TextEncoder(),env={FIREBASE_PROJECT_ID:"proj"};
const kp=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
const jwk={...(await crypto.subtle.exportKey("jwk",kp.publicKey)),kid:"k1",alg:"RS256",use:"sig"};
const fetchJwks=async()=>({ok:true,json:async()=>({keys:[jwk]})});
const now=1.8e12;
async function mk(over={},tamper=false){
  const h=b64u(te.encode(JSON.stringify({alg:"RS256",kid:"k1",typ:"JWT"})));
  const c=b64u(te.encode(JSON.stringify({iss:"https://securetoken.google.com/proj",aud:"proj",sub:"uid1",iat:now/1000-10,exp:now/1000+3600,firebase:{sign_in_provider:"google.com"},...over})));
  let s=b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",kp.privateKey,te.encode(h+"."+c)));
  if(tamper)s=s.slice(0,-4)+"AAAA";
  return h+"."+c+"."+s;
}
const req=t=>new Request("https://w/x",{headers:t?{Authorization:"Bearer "+t}:{}});
test("有效 token",async()=>{_reset();assert.deepEqual(await verifyFirebaseToken(req(await mk()),env,fetchJwks,now),{uid:"uid1",provider:"google.com"});});
test("拒絕：無 token / 簽章被改 / aud 錯 / 過期 / iss 錯",async()=>{
  _reset();
  for(const r of [req(null),req(await mk({},true)),req(await mk({aud:"other"})),req(await mk({exp:now/1000-1})),req(await mk({iss:"https://evil"}))])
    await assert.rejects(verifyFirebaseToken(r,env,fetchJwks,now),e=>e.status===401);
});
