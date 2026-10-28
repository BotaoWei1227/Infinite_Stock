// 練金大富翁：棋盤與卡片資料。前端與 Worker 共用（沒有任何機密）。
// 想調整遊戲節奏，改這裡的常數即可。
export const SIZE=52;            // 一圈 52 格（14×14 的外圈）
export const ROLL_COST=100;      // 每次擲骰費用（沒有回合制，想擲就花錢擲）
export const START_BONUS=500;    // 經過／停在起點的薪水
export const TAX=200;            // 稅務所
export const JAIL_FINE=150;      // 被押送入獄的罰款（只是移到探監格，不會真的關進 24 小時監獄）
export const COOLDOWN_MS=2000;   // 同一位玩家兩次擲骰的最短間隔
export const MAX_LV=3;           // 地產最高等級
export const LOG_MAX=30;
export const JAIL_IDX=13;
export const RENT_MULT=[1,3,6,10];   // 地產各等級的租金倍率
export const SET_BONUS=2;            // 同色地產全部持有時租金再 ×2
export const RAIL_RENT=[100,200,400,800]; // 持有 1～4 座煉爐的過路費

const CORNERS={0:["start","起點・練金村","🏘"],13:["jail","探監","🔒"],26:["park","賢者之泉","⛲"],39:["gojail","押送入獄","🚔"]};
const RAILS={6:"東方煉爐",19:"南方煉爐",32:"西方煉爐",45:"北方煉爐"};
const CHANCES=[3,16,29,42,49],FATES=[9,22,35,46,51],TAXES=[20,44];
const GROUPS=[4,4,4,4,4,4,4,4];
const GROUP_COLORS=["#a16207","#38bdf8","#f472b6","#fb923c","#f87171","#facc15","#4ade80","#818cf8"];
const NAMES=[
  "焦土坡","灰燼巷","煤渣街","枯井村",
  "螢石礦區","硫磺泉","銅綠橋","鉛灰港",
  "蒸氣工坊","齒輪廣場","銅管大道","鍋爐街",
  "水銀湖畔","鏡湖碼頭","雨雲塔","霧港",
  "雷鳴高地","避雷針街","電光市集","落雷谷",
  "風語平原","風鈴古道","颶風角","雲端渡口",
  "賢者之塔","鍊金術學院","星象台","魔法書庫",
  "練金村廣場","Funtuan 莊園","黃金大道","賢者之石殿"];
const round=(n,s)=>Math.round(n/s)*s;

function build(){
  const b=[];let k=0,g=0,left=GROUPS[0];
  for(let i=0;i<SIZE;i++){
    if(CORNERS[i]){const [type,name,emoji]=CORNERS[i];b.push({type,name,emoji});}
    else if(RAILS[i])b.push({type:"rail",name:RAILS[i],emoji:"🔥",price:500});
    else if(CHANCES.includes(i))b.push({type:"chance",name:"機會",emoji:"❓"});
    else if(FATES.includes(i))b.push({type:"fate",name:"命運",emoji:"🎴"});
    else if(TAXES.includes(i))b.push({type:"tax",name:"稅務所",emoji:"💸"});
    else{
      const price=200+40*k;
      b.push({type:"prop",name:NAMES[k],emoji:"🏠",price,rent:round(price/10,5),up:round(price/2,10),group:g,color:GROUP_COLORS[g]});
      k++;if(--left===0){g++;left=GROUPS[g]||0;}
    }
  }
  return b;
}
export const BOARD=build();
export const groupTiles=g=>BOARD.map((t,i)=>t.type==="prop"&&t.group===g?i:-1).filter(i=>i>=0);
export const idxOf=name=>BOARD.findIndex(t=>t.name===name);

// 卡片效果：cash（得失現金）、move（前進／後退格數）、goto（傳送到某格，bonus=true 時經過起點領薪水）、jail（押送入獄）、free（免費擲骰次數）
const T=n=>idxOf(n);
export const CHANCE_CARDS=[
  {text:"賢者之石發光，獲得 300 元",e:{k:"cash",v:300}},
  {text:"撿到金色齒輪，獲得 150 元",e:{k:"cash",v:150}},
  {text:"煉爐爆炸，支付修理費 200 元",e:{k:"cash",v:-200}},
  {text:"前進 5 格",e:{k:"move",v:5}},
  {text:"後退 3 格",e:{k:"move",v:-3}},
  {text:"前進到起點，領薪水",e:{k:"goto",v:0,bonus:true}},
  {text:"前往賢者之塔（經過起點領薪水）",e:{k:"goto",v:T("賢者之塔"),bonus:true}},
  {text:"獲得 1 次免費擲骰",e:{k:"free",v:1}},
  {text:"獲得 2 次免費擲骰",e:{k:"free",v:2}},
  {text:"魔法實驗失控，被押送入獄",e:{k:"jail"}},
  {text:"鄰居送來煉金材料，獲得 100 元",e:{k:"cash",v:100}},
  {text:"傳送卷軸失靈，後退 6 格",e:{k:"move",v:-6}}
];
export const FATE_CARDS=[
  {text:"Funtuan 發紅包，獲得 400 元",e:{k:"cash",v:400}},
  {text:"稅務員上門，繳 250 元",e:{k:"cash",v:-250}},
  {text:"古董變賣，獲得 200 元",e:{k:"cash",v:200}},
  {text:"材料漲價，支付 100 元",e:{k:"cash",v:-100}},
  {text:"前進 10 格",e:{k:"move",v:10}},
  {text:"後退 5 格",e:{k:"move",v:-5}},
  {text:"被傳送回起點（不領薪水）",e:{k:"goto",v:0,bonus:false}},
  {text:"前往黃金大道（經過起點領薪水）",e:{k:"goto",v:T("黃金大道"),bonus:true}},
  {text:"獲得 3 次免費擲骰",e:{k:"free",v:3}},
  {text:"賢者之泉祝福，獲得 1 次免費擲骰",e:{k:"free",v:1}},
  {text:"煉金公會年終獎金，獲得 500 元",e:{k:"cash",v:500}},
  {text:"違規煉製被舉報，被押送入獄",e:{k:"jail"}}
];

// 租金：地產看等級與是否湊齊同色，煉爐看持有座數。owners：{ 格子編號: {u,n,lv} }
export function rentOf(idx,owners){
  const t=BOARD[idx],o=owners?.[idx];if(!t||!o)return 0;
  if(t.type==="rail"){const n=Object.keys(owners).filter(i=>BOARD[i]?.type==="rail"&&owners[i].u===o.u).length;return RAIL_RENT[Math.min(4,Math.max(1,n))-1];}
  if(t.type!=="prop")return 0;
  const full=groupTiles(t.group).every(i=>owners[i]?.u===o.u);
  return t.rent*RENT_MULT[Math.min(MAX_LV,o.lv||0)]*(full?SET_BONUS:1);
}
// 玩家持有地產的成本總值（買價＋已花的升級費），給排行榜用
export function propertyValue(owners,uid){
  let v=0;for(const [i,o] of Object.entries(owners||{})){const t=BOARD[i];if(t&&o.u===uid)v+=t.price+(t.type==="prop"?(o.lv||0)*t.up:0);}
  return v;
}
