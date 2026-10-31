// 個人資料頁的畫面（自己的與公開分享的共用）。資料全部由伺服器計算，這裡只負責顯示。
import {WEALTH} from "./achievements.js";
const trim=n=>String(Math.round(n*100)/100);
// 大數用中文單位：萬、億、萬億（10^12）、兆（10^16）
export function zhBig(n){
  n=Number(n)||0;const a=Math.abs(n);
  for(const [u,name] of [[1e16,"兆"],[1e12,"萬億"],[1e8,"億"],[1e4,"萬"]])if(a>=u)return `${trim(n/u)} ${name}`;
  return Math.round(n).toLocaleString("en-US");
}
export const STAT_LABELS=[["trades","買賣股票"],["injects","投入物品"],["crafts","三物合成"],["recipes","發現配方"],["imports","領取傳授"],["mrolls","大富翁擲骰"],["props","持有地產"],["sets","湊齊同色"],["bankrupt","被黑道清空"],["bails","借貸保釋"],["robWins","搶劫成功"],["robJails","搶劫被捕"]];
// 頂部資料卡：稱號、名稱、簡介、歷史最高淨資產、下一個財富目標的進度
export function profileHead(el,d,peak){
  const head=el("div",{class:"pf-head"},
    el("div",{class:"pf-badge","aria-hidden":"true",text:d.titleIcon||"🪙"}),
    el("div",{class:"pf-who"},el("div",{class:"pf-title",text:d.title||"平民"}),el("div",{class:"pf-name",text:d.name||"玩家"}),d.bio?el("div",{class:"pf-bio",text:d.bio}):null));
  const box=el("div",{class:"pf-card"},head,el("div",{class:"mu",text:`歷史最高淨資產：${zhBig(peak)}`}));
  if(d.next){
    const cur=d.title?WEALTH.find(w=>w.name===d.title)?.min||0:0,pct=Math.max(0,Math.min(100,((peak-cur)/(d.next.min-cur))*100));
    box.append(el("div",{class:"pf-next"},el("span",{class:"mu",text:`下一個稱號：${d.next.icon} ${d.next.name}（${zhBig(d.next.min)}）`}),
      el("div",{class:"pf-bar",role:"progressbar","aria-valuemin":"0","aria-valuemax":"100","aria-valuenow":String(Math.round(pct))},el("i",{style:`width:${pct}%`}))));
  }else if(d.title&&d.next===null)box.append(el("div",{class:"mu",text:"已經是最高的財富稱號了 🎉"}));   // 只有伺服器明確說沒有下一級（null）才顯示；公開頁沒有這個欄位（undefined）就不顯示
  return box;
}
export function statGrid(el,stats){
  return el("div",{class:"pf-stats"},...STAT_LABELS.filter(([k])=>Number(stats?.[k])>0).map(([k,l])=>el("div",{class:"pf-stat"},el("b",{text:Number(stats[k]).toLocaleString("en-US")}),el("span",{class:"mu",text:l}))));
}
// 成就清單：locked=true 時一併顯示還沒解鎖的（含進度）
export function achievementList(el,list,{locked=false}={}){
  const item=a=>el("li",{class:"pf-ach"+(a.unlocked===false?" lock":"")},el("span",{class:"pf-ico","aria-hidden":"true",text:a.unlocked===false?"🔒":a.icon}),
    el("div",{},el("b",{text:a.name}),el("div",{class:"mu",text:a.desc+(a.unlocked===false&&a.goal?`（${zhBig(a.progress)} / ${zhBig(a.goal)}）`:"")})));
  const got=list.filter(a=>a.unlocked!==false),rest=locked?list.filter(a=>a.unlocked===false):[];
  const out=[el("h3",{class:"h2",text:`已解鎖（${got.length}${locked?" / "+list.length:""}）`}),got.length?el("ul",{class:"pf-list"},...got.map(item)):el("p",{class:"mu",text:"還沒有成就，去玩玩看吧。"})];
  if(rest.length)out.push(el("h3",{class:"h2",text:`尚未解鎖（${rest.length}）`}),el("ul",{class:"pf-list"},...rest.map(item)));
  return out;
}
