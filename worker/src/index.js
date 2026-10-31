import {route,tick,generateAutoNews,publishScheduledNews} from "./app.js";
import {makeDb} from "./firestore.js";
import {verifyFirebaseToken} from "./auth.js";
import {autoNews as generateNews,craftJudge,judgeRelevance} from "./ia.js";
const API=new Set(["/inject","/trade","/bank","/news","/odds","/whoami","/ensure-market","/profile","/leaderboard","/blackmarket","/analyst","/admin-settings","/monopoly","/craft"]);
const deps=env=>({
  db:makeDb(env),
  verify:r=>verifyFirebaseToken(r,env),
  now:()=>Date.now(),rand:Math.random,secureRand:()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296,
  autoNews:env.GEMINI_API_KEY?(stocks,slot,date)=>generateNews(fetch,env.GEMINI_API_KEY,stocks,slot,date):null,
  fetchShare:async url=>{   // 讀《無限煉製》傳授連結的網頁（只允許 shareUrl 驗證過的網址，不跟隨轉址）
    const r=await fetch(url,{redirect:"manual",headers:{"User-Agent":"alchemy-exchange/1.0 (share link import)",Accept:"text/html"},signal:AbortSignal.timeout(5000)});
    if(r.status!==200)throw new Error("HTTP "+r.status);
    return (await r.text()).slice(0,200000);
  },
  craftAI:env.GEMINI_API_KEY?req=>craftJudge(fetch,env.GEMINI_API_KEY,req):null,
  judgeAI:env.GEMINI_API_KEY?req=>judgeRelevance(fetch,env.GEMINI_API_KEY,req):null,   // 沒設 Key 時：物品名稱和股票名稱相同才算直接相關   // 沒設 Key 時退回 logic.js 的固定配方
  devEmails:(env.DEV_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean)   // 機密，不放在倉庫裡
});
export default {
  fetch(req,env){
    // 非 API 路徑交給靜態網頁（public/）
    if(env.ASSETS&&!API.has(new URL(req.url).pathname))return env.ASSETS.fetch(req);
    return route(req,env,deps(env));
  },
  // 排程觸發：讓行情自己隨機漲跌
  async scheduled(event,env,ctx){
    const d=deps(env);
    ctx.waitUntil(tick(d).catch(e=>console.error("tick failed",e?.name)));
    ctx.waitUntil(publishScheduledNews(d).catch(e=>console.error("scheduled news failed",e?.name)));
    ctx.waitUntil(generateAutoNews(d).catch(e=>console.error("auto news failed",e?.name)));
  }
};
