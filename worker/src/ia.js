// 伺服器端的 Gemini 呼叫（金鑰只存在 Cloudflare Secret GEMINI_API_KEY）：自動撰寫財經新聞、判定三物合成的結果。
export const NEWS_MODEL="gemini-3.6-flash";   // 這個模型已停用 temperature 參數，請求中不要帶
// 自動財經新聞：台北時間 10/14/18/22 點各一則，由 AI 依世界觀撰寫，並對 1～2 檔股票微調上漲基準機率（±1～±30 個百分點，依新聞嚴重程度）
export const AUTO_NEWS_MAX=30;
export async function autoNews(fetchFn,key,stocks,slot,date){
  if(typeof key!=="string"||key.length<10)throw new Error("missing GEMINI_API_KEY");
  const list=stocks.map(s=>`${s.id}（${s.name}）`).join("、");
  const prompt=`你是「練金世界」的財經記者。世界觀：這是一個煉金術世界，今天煉金世界剛連上了現代科技，於是有了股票市場。練金村的主人是 Funtuan。股票主題有：${list}。
請寫一則今日 ${slot} 點的突發財經新聞，風格像國際新聞社的連線報導：內文以「【地點連線報導】」開頭（地點用虛構的煉金世界地名，例如練金村、賢者之塔、蒸氣都市），再用 120～260 字的繁體中文描述事件、起因、各方反應與對市場的震撼，語氣正經誇張、帶點荒謬幽默。
日期：${date}。事件要有創意，必須和上列至少一檔股票的主題有關。人物與組織全部虛構（可以出現練金村主人 Funtuan），不得使用任何現實中的真人、政治人物或現實公司。內文不得提到機率、百分比預測或「上漲／下跌機率」。
另外請決定這則新聞對哪 1～2 檔股票有利多或利空：effects 的鍵是股票代號，值是 -${AUTO_NEWS_MAX} 到 ${AUTO_NEWS_MAX} 的非零整數（正數利多、負數利空，方向要與新聞內容一致；幅度依事件嚴重程度決定：小事 ±5～10、中型事件 ±10～20、震撼全市場的大事 ±20～${AUTO_NEWS_MAX}，不要每則都給最大值）。
只回傳 JSON：{"title":"標題（8～30 字）","body":"內文","effects":{"股票代號":整數}}`;
  const r=await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${NEWS_MODEL}:generateContent`,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json"}})});
  if(!r.ok)throw new Error(`Gemini ${r.status}`);
  const j=await r.json(),raw=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("");
  let x;try{x=JSON.parse(raw.replace(/```json|```/g,"").trim());}catch{throw new Error("invalid news response");}
  const title=typeof x.title==="string"?x.title.trim():"",body=typeof x.body==="string"?x.body.trim():"";
  if(title.length<4||title.length>40||/[\u0000-\u001f]/.test(title)||body.length<60||body.length>600||/[\u0000-\u0008\u000b-\u001f]/.test(body))throw new Error("invalid news fields");
  const ids=new Set(stocks.map(s=>s.id)),effects={};
  for(const [id,v] of Object.entries(x.effects&&typeof x.effects==="object"?x.effects:{})){
    const n=Math.round(Number(v));
    if(ids.has(id)&&Number.isFinite(n)&&n!==0&&Object.keys(effects).length<2)effects[id]=Math.max(-AUTO_NEWS_MAX,Math.min(AUTO_NEWS_MAX,n));
  }
  return {title,body,effects};
}

// 三物合成判定：AI 依煉金術的直覺，決定三個元素合成出六種元素中的哪一個。
// 同一個組合只會問一次（伺服器把結果記在私密文件），之後所有玩家都得到同樣的結果。
export const CRAFT_ELEMENTS={fire:"火",water:"水",earth:"土",wind:"風",steam:"蒸氣",thunder:"雷"};
export async function craftJudge(fetchFn,key,items){
  if(typeof key!=="string"||key.length<10)throw new Error("missing GEMINI_API_KEY");
  if(!Array.isArray(items)||items.length!==3||items.some(x=>!CRAFT_ELEMENTS[x]))throw new Error("invalid items");
  const list=Object.entries(CRAFT_ELEMENTS).map(([id,n])=>`${id}（${n}）`).join("、");
  const prompt=`你是「練金世界」的資深煉金師。世界觀：煉金術世界剛連上現代科技，有了股票，股票的名稱就是六種元素：${list}。其中火、水、土、風是基礎元素，蒸氣與雷是進階元素。
玩家把三個元素放進煉金爐合成，請你判定會煉出哪一種元素。結果必須是上面六種元素之一（用英文代號）。
判定原則：
1. 以煉金術與自然現象的直覺為準：例如火遇水會變成蒸氣；風、水、火交會（雷雨）或風推動蒸氣會產生雷；三個相同的元素只會煉出該元素；組成單純的組合通常得到基礎元素。
2. 只有組合明顯符合時才給蒸氣或雷，不要因為想獎勵玩家就隨便給進階元素；也不要讓所有組合都得到同一種結果。
3. 同樣的三個元素，不管放的順序，答案都一樣。
這次的三個元素是：${items.map(x=>`${x}（${CRAFT_ELEMENTS[x]}）`).join("、")}。
只回傳 JSON：{"result":"元素英文代號","reason":"用繁體中文寫一句 12～40 字的煉金師解說，說明為什麼會煉出這個元素，語氣帶點神祕感，不要提機率或數值"}`;
  const r=await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${NEWS_MODEL}:generateContent`,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json"}})});
  if(!r.ok)throw new Error(`Gemini ${r.status}`);
  const j=await r.json(),raw=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("");
  let x;try{x=JSON.parse(raw.replace(/```json|```/g,"").trim());}catch{throw new Error("invalid craft response");}
  const result=typeof x.result==="string"?x.result.trim().toLowerCase():"";
  if(!CRAFT_ELEMENTS[result])throw new Error("invalid craft result");
  const reason=typeof x.reason==="string"?x.reason.replace(/[\u0000-\u001f]/g," ").trim().slice(0,80):"";
  return {result,reason};
}
