// 《無限煉製》Developer API（玩家授權的唯讀 API）與 Gemini 判定
import {HttpError} from "./errors.js";
export function iaClient(env,fetchFn=fetch,sleep=ms=>new Promise(s=>setTimeout(s,ms))){
  const base=(env.IA_BASE||"https://pillars-of-creation.funtuan.work").replace(/\/$/,"");
  async function get(path,token){
    if(typeof token!=="string"||token.length<8||token.length>512)throw new HttpError(401,"unauthenticated","請先連結《無限煉製》帳號");
    for(let i=0;i<3;i++){
      const r=await fetchFn(`${base}/developer-api/v1/${path}`,{headers:{Authorization:"Bearer "+token}});
      if(r.status===429){await sleep((2**i)*700+Math.random()*300);continue;}
      if(r.status===401)throw new HttpError(401,"unauthenticated","授權失效，請重新連結《無限煉製》");
      if(r.status===403)throw new HttpError(403,"permission-denied","缺少所需授權範圍");
      if(!r.ok)throw new HttpError(503,"unavailable","《無限煉製》服務暫時無法使用");
      return r.json();
    }
    throw new HttpError(429,"resource-exhausted","請求過於頻繁，請稍後再試");
  }
  return {
    me:t=>get("me",t),
    async history(t){ // 官方最多提供最近 500 筆；不假設排序，全部掃過
      const all=[];let off=0;
      for(let n=0;off!=null&&n<5;n++){const p=await get(`history?limit=100&offset=${off}`,t);all.push(...p.items);off=p.nextOffset;}
      return all;
    }
  };
}
// 固定使用的模型（玩家無法更改）。Google 官方目前沒有「3.6 Flash-Lite」，Flash-Lite 最新是 3.5；要換成 3.6 Flash 只需改這一行
export const MODEL="gemini-3.5-flash-lite";
export async function judge(fetchFn,stock,item,key){
  if(typeof key!=="string"||key.length<10||key.length>200)throw new HttpError(400,"invalid-argument","請先填入 Google API Key");
  const prompt=`你是奇幻煉金交易所的裁判。股票主題：「${stock}」。玩家投入的造物：「${item}」。判斷這個造物與該主題的關聯程度（元素、組成、象徵、常識聯想皆可），只回傳 JSON：{"score":0到100的整數,"reason":"20字內繁體中文理由"}。`;
  const r=await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,{method:"POST",
    headers:{"Content-Type":"application/json","x-goog-api-key":key},
    body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json"}})});
  if(!r.ok)throw new HttpError(412,"failed-precondition",r.status===429?"Gemini 額度用盡或請求過快":`Gemini 錯誤 ${r.status}（請確認 Key 與模型名稱）`);
  const j=await r.json();let o;
  try{o=JSON.parse((j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").replace(/```json|```/g,"").trim());}
  catch{throw new HttpError(502,"internal","AI 回應格式錯誤，請重試");}
  return {score:Math.max(0,Math.min(100,parseInt(o.score)||0)),reason:String(o.reason||"").slice(0,40)};
}
