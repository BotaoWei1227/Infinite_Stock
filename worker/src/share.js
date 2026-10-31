// 《無限煉製》傳授連結：玩家貼上 https://pillars-of-creation.funtuan.work/s/{代碼}，伺服器讀取網頁的 <title> 取得造物名稱與圖示。
// 標題格式：「🎁 {圖示} {造物名稱} — {傳授者} 傳授給你的造物」。網址與標題的格式都必須完全符合，否則一律拒絕。
import {normName,validName,MAX_NAME} from "../../public/items.js";
export const SHARE_ORIGIN="https://pillars-of-creation.funtuan.work";
export const SHARE_RE=/^https:\/\/pillars-of-creation\.funtuan\.work\/s\/([A-Z0-9]{16,40})\/?(?:[?#].*)?$/;
export const shareUrl=text=>{const m=SHARE_RE.exec(String(text??"").trim());return m?{code:m[1],url:`${SHARE_ORIGIN}/s/${m[1]}`}:null;};
const EMOJI="(\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}])*)";
const TITLE_RE=new RegExp(`^🎁\\s+(?:${EMOJI}\\s+)?(.+?)\\s+[—–-]\\s+(.+?)\\s+傳授給你的造物$`,"u");
export function decodeEntities(s){
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(m,g)=>{
    const k=g.toLowerCase();
    if(k==="amp")return "&";if(k==="lt")return "<";if(k==="gt")return ">";if(k==="quot")return '"';if(k==="apos")return "'";if(k==="nbsp")return " ";
    const n=k[1]==="x"?parseInt(k.slice(2),16):parseInt(k.slice(1),10);
    return Number.isInteger(n)&&n>0&&n<=0x10ffff?String.fromCodePoint(n):m;
  });
}
// 造物名稱可能比遊戲允許的長或含保留字元：把 + / 與控制字元換成空白、最多留 10 個字
export function cleanName(raw){
  let n=normName(String(raw).replace(/[+\/\u0000-\u001f\u007f]/g," "));
  n=[...n].slice(0,MAX_NAME).join("").trim();
  return validName(n)?n:"";
}
// 解析網頁：回傳 {name,e,sender,deadline}（deadline 為毫秒時間戳，沒有就是 null）；格式不符丟錯
export function parseShareHtml(html,now=Date.now()){
  const m=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html||"").slice(0,200000));
  if(!m)throw new Error("no title");
  const title=normName(decodeEntities(m[1])),t=TITLE_RE.exec(title);
  if(!t)throw new Error("title format");
  const name=cleanName(t[2]);if(!name)throw new Error("bad name");
  const d=/期限\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(decodeEntities(String(html).slice(0,200000)));   // 例：期限 10/31 19:27（台北時間）
  let deadline=null;
  if(d){
    const y0=new Date(now+8*36e5).getUTCFullYear();let best=null;
    for(const y of [y0-1,y0,y0+1]){const ts=Date.UTC(y,Number(d[1])-1,Number(d[2]),Number(d[3])-8,Number(d[4]));if(best===null||Math.abs(ts-now)<Math.abs(best-now))best=ts;}   // 年份取離現在最近的
    deadline=best;
  }
  return {name,e:t[1]||"✨",sender:normName(t[3]).slice(0,30),deadline};
}
