// 成就與稱號（前端與 Worker 共用，沒有任何機密）。成就都由伺服器依玩家資料計算，前端只負責顯示。
// 財富稱號看「歷史最高淨資產」（peak）。大數用中數：萬億＝10^12，兆＝10^16（萬萬為億，萬萬億為兆）。
export const WEALTH=[
  {min:1e3,name:"千元戶",icon:"💴"},{min:1e4,name:"萬元戶",icon:"💴"},{min:1e5,name:"十萬富翁",icon:"💵"},
  {min:1e6,name:"百萬富翁",icon:"💰"},{min:1e7,name:"千萬富翁",icon:"💰"},{min:1e8,name:"億萬富翁",icon:"🤑"},
  {min:1e9,name:"十億富翁",icon:"🤑"},{min:1e10,name:"百億富翁",icon:"💎"},{min:1e11,name:"千億富翁",icon:"💎"},
  {min:1e12,name:"萬億富翁",icon:"👑"},{min:1e13,name:"十萬億富翁",icon:"👑"},{min:1e14,name:"百萬億富翁",icon:"👑"},
  {min:1e15,name:"千萬億富翁",icon:"🌌"},{min:1e16,name:"兆富翁",icon:"🌌"}];
// stat：統計欄位名稱；goal：達成門檻
export const ACHIEVEMENTS=[
  {id:"trade1",name:"初次下單",icon:"📈",desc:"買賣股票 1 次",stat:"trades",goal:1},
  {id:"trade50",name:"股市常客",icon:"📊",desc:"買賣股票 50 次",stat:"trades",goal:50},
  {id:"trade500",name:"盤中老手",icon:"🧓",desc:"買賣股票 500 次",stat:"trades",goal:500},
  {id:"inject1",name:"初試身手",icon:"🧪",desc:"投入物品 1 次",stat:"injects",goal:1},
  {id:"inject30",name:"投入達人",icon:"💉",desc:"投入物品 30 次",stat:"injects",goal:30},
  {id:"inject200",name:"煉金大戶",icon:"🏦",desc:"投入物品 200 次",stat:"injects",goal:200},
  {id:"craft1",name:"煉金學徒",icon:"⚗️",desc:"三物合成 1 次",stat:"crafts",goal:1},
  {id:"craft25",name:"煉金術士",icon:"🔮",desc:"三物合成 25 次",stat:"crafts",goal:25},
  {id:"craft150",name:"大煉金師",icon:"🧙",desc:"三物合成 150 次",stat:"crafts",goal:150},
  {id:"rec10",name:"配方收藏家",icon:"📖",desc:"發現 10 種配方",stat:"recipes",goal:10},
  {id:"rec40",name:"配方百科",icon:"📚",desc:"發現 40 種配方",stat:"recipes",goal:40},
  {id:"gift1",name:"收到禮物",icon:"🎁",desc:"領取 1 個《無限煉製》傳授連結",stat:"imports",goal:1},
  {id:"gift10",name:"人緣很好",icon:"🤝",desc:"領取 10 個傳授連結",stat:"imports",goal:10},
  {id:"roll1",name:"踏上棋盤",icon:"🎲",desc:"大富翁擲骰 1 次",stat:"mrolls",goal:1},
  {id:"roll100",name:"棋盤常客",icon:"🎯",desc:"大富翁擲骰 100 次",stat:"mrolls",goal:100},
  {id:"roll1000",name:"棋盤傳說",icon:"🏆",desc:"大富翁擲骰 1000 次",stat:"mrolls",goal:1000},
  {id:"prop1",name:"有了自己的地",icon:"🏠",desc:"持有 1 塊地產",stat:"props",goal:1},
  {id:"prop8",name:"地產大亨",icon:"🏘️",desc:"同時持有 8 塊地產",stat:"props",goal:8},
  {id:"set1",name:"湊齊一色",icon:"🌈",desc:"湊齊一整組同色地產",stat:"sets",goal:1},
  {id:"set3",name:"壟斷市場",icon:"🎩",desc:"湊齊 3 組同色地產",stat:"sets",goal:3},
  {id:"bank1",name:"東山再起",icon:"🔨",desc:"被黑道清空資產 1 次",stat:"bankrupt",goal:1},
  {id:"bail1",name:"保釋常客",icon:"⛓️",desc:"借貸保釋出獄 1 次",stat:"bails",goal:1},
  {id:"rob1",name:"劫富濟貧",icon:"🥷",desc:"搶劫成功 1 次",stat:"robWins",goal:1},
  {id:"rob10",name:"黑市傳奇",icon:"🕶️",desc:"搶劫成功 10 次",stat:"robWins",goal:10},
  {id:"jail1",name:"吃牢飯",icon:"🚔",desc:"搶劫失敗被捕 1 次",stat:"robJails",goal:1}];
const num=v=>Number.isFinite(Number(v))?Number(v):0;
// 財富稱號：回傳目前達到的最高稱號（沒有就是 null）與下一個目標
export function wealthTitle(peak){
  const p=num(peak);let i=-1;WEALTH.forEach((w,k)=>{if(p>=w.min)i=k;});
  return {tier:i,current:i>=0?WEALTH[i]:null,next:WEALTH[i+1]||null};
}
// 依統計資料算出所有成就（含進度）。財富稱號的每一級也是一個成就
export function evaluate(stats){
  const s=stats||{},list=[];
  WEALTH.forEach((w,i)=>list.push({id:`wealth${i}`,name:w.name,icon:w.icon,desc:`歷史最高淨資產達 ${w.min.toLocaleString("en-US")}`,kind:"wealth",stat:"peak",goal:w.min,progress:Math.min(num(s.peak),w.min),unlocked:num(s.peak)>=w.min}));
  for(const a of ACHIEVEMENTS)list.push({...a,kind:"achv",progress:Math.min(num(s[a.stat]),a.goal),unlocked:num(s[a.stat])>=a.goal});
  return list;
}
