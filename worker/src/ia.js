// 伺服器端的 Gemini 呼叫（金鑰只存在 Cloudflare Secret GEMINI_API_KEY）。目前只用來自動撰寫財經新聞。
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
