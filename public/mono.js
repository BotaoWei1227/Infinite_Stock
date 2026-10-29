// 練金大富翁：棋盤畫面（52 格，14×14 的外圈）。資料來自 Firestore 的 monopoly/state，動作都送到 Worker 的 /monopoly。
import {BOARD,SIZE,ROLL_COST,MAX_LV,RENT_MULT,SET_BONUS,RAIL_RENT,rentOf,propertyValue} from "./board.js";

const ring=i=>i<=13?[0,i]:i<=26?[i-13,13]:i<=39?[13,13-(i-26)]:[13-(i-39),0];   // 第 i 格在 14×14 網格的 [列, 欄]
const hue=s=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))%360;return h;};

export function createMono({host,el,fmt,say,act,getMe,getUser,isBusy}){
  let st={owners:{},pos:{},log:[],offers:{}},selected=null,last=null,built=false,scroller,boardEl,panel,below;
  const ZMIN=22,ZMAX=130;let cs=74;
  try{const z=Number(localStorage.getItem("monoZoom"));if(z>=ZMIN&&z<=ZMAX)cs=z;}catch{}
  // 縮放：改變格子邊長（--cs），並保持畫面中心不動；小於 44px 時隱藏文字，只剩圖示與棋子
  function setZoom(v,keep=true){
    v=Math.round(Math.max(ZMIN,Math.min(ZMAX,v)));if(!scroller||v===cs&&keep===true)return;
    const cx=(scroller.scrollLeft+scroller.clientWidth/2)/(14*cs),cy=(scroller.scrollTop+scroller.clientHeight/2)/(14*cs);
    cs=v;scroller.style.setProperty("--cs",cs+"px");scroller.classList.toggle("mini",cs<44);
    scroller.scrollLeft=cx*14*cs-scroller.clientWidth/2;scroller.scrollTop=cy*14*cs-scroller.clientHeight/2;
    try{localStorage.setItem("monoZoom",String(cs));}catch{}
  }
  const fitAll=()=>setZoom(Math.min(scroller.clientWidth,scroller.clientHeight)/14-1);
  const uid=()=>getUser()?.uid;
  const myPos=()=>Number(st.pos[uid()]?.p??0);

  function build(){
    host.replaceChildren();
    panel=el("section",{class:"win mono-panel","aria-label":"大富翁操作"});
    boardEl=el("div",{class:"mono-board"});
    scroller=el("div",{class:"mono-scroll",tabindex:"0","aria-label":"大富翁棋盤（可左右上下捲動）"},boardEl);
    below=el("section",{class:"win mono-below","aria-label":"交易市場與動態"});
    host.append(panel,scroller,below);
    scroller.style.setProperty("--cs",cs+"px");scroller.classList.toggle("mini",cs<44);
    // 兩指捏合縮放（手機）；電腦用 Ctrl＋滾輪
    let d0=0,z0=cs;const dist=t=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    scroller.addEventListener("touchstart",e=>{if(e.touches.length===2){d0=dist(e.touches);z0=cs;}},{passive:true});
    scroller.addEventListener("touchmove",e=>{if(e.touches.length===2&&d0>0){e.preventDefault();setZoom(z0*dist(e.touches)/d0);}},{passive:false});
    scroller.addEventListener("touchend",()=>{d0=0;},{passive:true});
    scroller.addEventListener("wheel",e=>{if(e.ctrlKey){e.preventDefault();setZoom(cs*(e.deltaY<0?1.12:1/1.12));}},{passive:false});
    built=true;
  }

  function tileEl(i){
    const t=BOARD[i],o=st.owners[i],[r,c]=ring(i);
    const all={...st.pos};if(uid()&&!all[uid()])all[uid()]={p:0,n:getUser()?.displayName||"我"};   // 還沒擲過骰的人也有棋子，站在起點
    const toks=Object.entries(all).filter(([,v])=>Number(v.p)===i).map(([u,v])=>el("span",{class:"tok"+(u===uid()?" me":""),title:v.n||"玩家",style:`background:hsl(${hue(u)} 70% 45%)`,text:[...String(v.n||"玩")][0]}));
    const kids=[];
    if(t.type==="prop")kids.push(el("i",{class:"band",style:`background:${t.color}`}));
    kids.push(el("span",{class:"te",text:t.emoji}),el("b",{class:"tn",text:t.name}));
    if(uid()&&i===myPos())kids.push(el("em",{class:"here-badge",text:"📍 你在這"}));
    if(t.price)kids.push(el("small",{class:"tp",text:o?`${o.n}${t.type==="prop"&&o.lv?" "+"★".repeat(o.lv):""}`:`${t.price}`}));
    if(toks.length)kids.push(el("div",{class:"toks"},...toks));
    return el("button",{type:"button",class:`tile t-${t.type}${i===myPos()&&uid()?" here":""}${o?" owned":""}${o&&o.u===uid()?" mine":""}${selected===i?" sel":""}`,style:`grid-row:${r+1};grid-column:${c+1}`,"aria-label":`第 ${i} 格 ${t.name}`,onclick:()=>{selected=i;render();}},...kids);
  }

  const offerList=()=>Object.entries(st.offers||{}).map(([id,o])=>({id,...o})).filter(o=>Date.now()-o.at<48*36e5&&BOARD[o.tile]).sort((a,b)=>b.at-a.at);
  const askPrice=(label,def)=>{const v=prompt(label,String(def));if(v===null)return null;const n=Math.round(Number(v));return Number.isFinite(n)&&n>=1?n:(say("價格要是正整數"),null);};
  const trade=async(body,done)=>{const r=await act("monopoly",body);if(r&&done)say(done(r));};
  function marketEl(){
    const me=uid(),all=offerList(),busy=isBusy(),m=getMe();
    const sells=all.filter(o=>o.k==="sell"),bids=all.filter(o=>o.k==="buy");
    const row=(text,...btns)=>el("li",{class:"trade-row"},el("span",{text}),...btns);
    const sellRows=sells.map(o=>{const t=BOARD[o.tile],mineO=o.u===me;
      return row(`${t.emoji} ${t.name}${st.owners[o.tile]?.lv?" ★"+st.owners[o.tile].lv:""}　${o.price} 元　賣家：${o.n}`,
        mineO?el("button",{type:"button",class:"px-btn",text:"取消掛牌",disabled:busy,onclick:()=>trade({action:"cancel",offerId:o.id},()=>"已取消掛牌")}):
          el("button",{type:"button",class:"px-btn pri",text:"買下",disabled:busy||m.cash<o.price,onclick:()=>{if(confirm(`以 ${o.price} 元買下「${t.name}」？`))trade({action:"accept",offerId:o.id},r=>`買下了「${r.name}」（${r.price} 元）`);}}),
        el("button",{type:"button",class:"px-btn",text:"看位置",onclick:()=>{selected=o.tile;render();focus(o.tile);}}));});
    const inBids=bids.filter(o=>o.to===me).map(o=>row(`${o.n} 想以 ${o.price} 元買你的「${BOARD[o.tile].name}」`,
      el("button",{type:"button",class:"px-btn pri",text:"賣給他",disabled:busy,onclick:()=>{if(confirm(`以 ${o.price} 元把「${BOARD[o.tile].name}」賣給 ${o.n}？`))trade({action:"accept",offerId:o.id},r=>`賣出「${r.name}」，收到 ${r.price} 元`);}}),
      el("button",{type:"button",class:"px-btn",text:"拒絕",disabled:busy,onclick:()=>trade({action:"cancel",offerId:o.id},()=>"已拒絕出價")})));
    const outBids=bids.filter(o=>o.u===me).map(o=>row(`你出價 ${o.price} 元想買「${BOARD[o.tile].name}」（持有人：${st.owners[o.tile]?.n||"?"}）`,
      el("button",{type:"button",class:"px-btn",text:"收回出價",disabled:busy,onclick:()=>trade({action:"cancel",offerId:o.id},()=>"已收回出價")})));
    const sec=(title,rows,empty)=>[el("h4",{class:"mono-sub",text:`${title}（${rows.length}）`}),rows.length?el("ul",{class:"trade-list"},...rows):el("p",{class:"mu",text:empty})];
    return el("div",{class:"mono-market"},el("h3",{class:"h2",text:"🤝 權狀交易市場"}),
      el("p",{class:"mu",text:"玩家之間可以直接買賣權狀（等級跟著權狀走），價格自己談，不用經過銀行。點棋盤上的地可以掛牌出售或出價購買；掛牌與出價 48 小時後自動失效。"}),
      ...sec("出售中",sellRows,"目前沒有人掛牌"),...(me?[...sec("收到的出價",inBids,"沒有人向你出價"),...sec("我的出價",outBids,"你沒有出價")]:[]));
  }
  // 棋盤中央只放標題；規則、交易市場、我的地產、最近動態都放在棋盤下方，不受縮放影響，比較好讀
  function centerEl(){
    return el("div",{class:"mono-center"},el("h2",{class:"px mono-title",text:"練金大富翁"}),el("p",{class:"mu",text:`一圈 ${SIZE} 格・擲骰 ${ROLL_COST} 元`}));
  }
  function belowEls(){
    const mine=Object.entries(st.owners).filter(([,o])=>o.u===uid()).map(([i])=>Number(i)).sort((a,b)=>a-b);
    const logs=[...(st.log||[])].reverse().slice(0,14);
    return [el("div",{class:"bar"},el("span",{class:"tt",text:"📋 MARKET.EXE"})),
      el("div",{class:"body"},
        marketEl(),
        el("h3",{class:"h2",text:`我的地產（${mine.length}）`}),
        mine.length?el("div",{class:"row"},...mine.map(i=>el("button",{type:"button",class:"px-btn",text:`${BOARD[i].name}${st.owners[i].lv?" ★"+st.owners[i].lv:""}`,onclick:()=>{selected=i;render();focus(i);scroller.scrollIntoView({block:"start",behavior:"smooth"});}}))):el("p",{class:"mu",text:"還沒有地產。擲到沒人持有的地就可以買下。"}),
        el("h3",{class:"h2",text:"最近動態"}),
        el("ul",{class:"mono-log"},...(logs.length?logs.map(l=>el("li",{text:`${l.who}：${l.text}`})):[el("li",{class:"mu",text:"還沒有人擲過骰子"})])),
        el("h3",{class:"h2",text:"遊戲規則"}),
        el("p",{class:"mu",text:`沒有回合制：想擲骰就花 ${ROLL_COST} 元，全服玩家同在一張棋盤上。買地收過路費、抽機會與命運卡，經過起點領薪水。點棋盤上的格子可以看租金與操作。`}))];
  }

  function infoEl(i){
    const t=BOARD[i],o=st.owners[i],me=getMe(),box=el("div",{class:"mono-info"});
    box.append(el("b",{text:`${t.emoji} 第 ${i} 格・${t.name}`}));
    if(t.type==="prop"||t.type==="rail"){
      box.append(el("span",{class:"mu",text:`　售價 ${t.price}　${o?"持有人："+o.n+(t.type==="prop"?"（"+o.lv+" 級）":""):"無人持有"}`}));
      box.append(el("p",{class:"mu",text:t.type==="prop"
        ?`租金：${[0,1,2,3].map(l=>t.rent*RENT_MULT[l]).join(" / ")}（0～${MAX_LV} 級）；同色全持有 ×${SET_BONUS}；升級每級 ${t.up} 元`
        :`過路費：持有 1～4 座煉爐 → ${RAIL_RENT.join(" / ")}`}));
      if(o)box.append(el("p",{class:"mu",text:`現在過路費：${rentOf(i,st.owners)} 元`}));
      const here=i===myPos(),busy=isBusy();
      if(here&&!o)box.append(el("button",{type:"button",class:"px-btn pri",text:`買下（${t.price} 元）`,disabled:busy||me.cash<t.price,onclick:async()=>{const r=await act("monopoly",{action:"buy"});if(r)say(`買下了「${r.name}」`);}}));
      if(o&&uid()&&o.u===uid()){const mineL=offerList().find(x=>x.k==="sell"&&x.tile===i&&x.u===uid());
        box.append(el("button",{type:"button",class:"px-btn",text:mineL?`改價重掛（現 ${mineL.price}）`:"掛牌出售",disabled:busy,onclick:async()=>{const v=askPrice(`「${t.name}」要賣多少元？（等級 ${o.lv||0} 會一起轉讓）`,mineL?.price||t.price);if(v)trade({action:"list",tile:i,price:v},()=>`已掛牌「${t.name}」${v} 元`);}}));}
      if(o&&uid()&&o.u!==uid()){const sale=offerList().find(x=>x.k==="sell"&&x.tile===i);
        if(sale)box.append(el("button",{type:"button",class:"px-btn pri",text:`以 ${sale.price} 元買下`,disabled:busy||me.cash<sale.price,onclick:()=>{if(confirm(`以 ${sale.price} 元買下「${t.name}」？`))trade({action:"accept",offerId:sale.id},r=>`買下了「${r.name}」（${r.price} 元）`);}}));
        box.append(el("button",{type:"button",class:"px-btn",text:"出價購買",disabled:busy,onclick:async()=>{const v=askPrice(`向 ${o.n} 出價買「${t.name}」，出多少元？`,sale?.price||t.price);if(v)trade({action:"bid",tile:i,price:v},()=>`已向 ${o.n} 出價 ${v} 元，等他回應`);}}));}
      if(o&&o.u===uid()&&t.type==="prop"&&(o.lv||0)<MAX_LV)box.append(el("button",{type:"button",class:"px-btn",text:`升級（${t.up} 元）`,disabled:busy||me.cash<t.up,onclick:async()=>{const r=await act("monopoly",{action:"upgrade",tile:i});if(r)say(`「${t.name}」升到 ${r.lv} 級`);}}));
    }
    else box.append(el("p",{class:"mu",text:{start:`經過或停在起點可領薪水`,jail:"探監：只是路過，沒有效果",park:"賢者之泉：休息一下，沒有效果",gojail:"押送入獄：移到探監格並罰款（不會被關 24 小時）",tax:"稅務所：繳稅",chance:"抽一張機會卡",fate:"抽一張命運卡"}[t.type]||""}));
    return box;
  }

  function panelEl(){
    const me=getMe(),user=getUser(),busy=isBusy(),free=Number(me.mfree||0),jailed=me.jailUntil>Date.now();
    const p=myPos(),sel=selected??p;
    const bar=el("div",{class:"bar"},el("span",{class:"tt",text:"🎲 MONOPOLY.EXE"}));
    const rollBtn=el("button",{type:"button",class:"px-btn pri roll",disabled:!user||busy||jailed||(!free&&me.cash<ROLL_COST),text:free?`🎲 免費擲骰（剩 ${free} 次）`:`🎲 擲骰（${ROLL_COST} 元）`,onclick:async()=>{
      const r=await act("monopoly",{action:"roll"});if(!r)return;
      last=r;selected=null;render();say(`擲出 ${r.dice[0]}+${r.dice[1]}，來到「${BOARD[r.to].name}」`);focus(r.to);}});
    const res=last?el("div",{class:"mono-result"},el("b",{text:`🎲 ${last.dice[0]} + ${last.dice[1]} = ${last.dice[0]+last.dice[1]}`}),el("ul",{},...last.events.map(e=>el("li",{text:e})))):el("p",{class:"mu",text:user?"按下擲骰開始。你的棋子是棋盤上發亮的那一個。":"請先以 Google 帳號登入，就能加入大富翁。"});
    return [bar,el("div",{class:"body"},
      el("div",{class:"row mono-row"},rollBtn,el("span",{class:"mu",text:`現金 ${fmt(me.cash)}　位置：第 ${p} 格「${BOARD[p].name}」`}),el("button",{type:"button",class:"px-btn",text:"找到我",onclick:()=>focus(p)})),
      el("div",{class:"row mono-zoom"},el("span",{class:"mu",text:"棋盤大小"}),el("button",{type:"button",class:"px-btn",text:"－ 縮小","aria-label":"縮小棋盤",onclick:()=>setZoom(cs/1.25)}),el("button",{type:"button",class:"px-btn",text:"＋ 放大","aria-label":"放大棋盤",onclick:()=>{setZoom(cs*1.25);}}),el("button",{type:"button",class:"px-btn",text:"全景",onclick:()=>fitAll()}),el("button",{type:"button",class:"px-btn",text:"預設",onclick:()=>{setZoom(74);focus(p);}})),
      res,infoEl(sel))];
  }

  function focus(i){
    if(!scroller)return;
    const [r,c]=ring(i),cs=boardEl.firstElementChild?boardEl.firstElementChild.offsetWidth:64;
    scroller.scrollTo({left:Math.max(0,(c+.5)*cs-scroller.clientWidth/2),top:Math.max(0,(r+.5)*cs-scroller.clientHeight/2),behavior:"smooth"});
  }

  function render(){
    if(!built)build();
    panel.replaceChildren(...panelEl());
    below.replaceChildren(...belowEls());
    const keepL=scroller.scrollLeft,keepT=scroller.scrollTop;
    boardEl.replaceChildren(...BOARD.map((_,i)=>tileEl(i)),centerEl());
    scroller.scrollLeft=keepL;scroller.scrollTop=keepT;
  }
  return {
    update(data){const before=myPos();st={owners:data?.owners||{},pos:data?.pos||{},log:data?.log||[],offers:data?.offers||{}};if(myPos()!==before)selected=null;render();},
    render,
    focusMe(){focus(myPos());},
    netValue:u=>propertyValue(st.owners,u)
  };
}
