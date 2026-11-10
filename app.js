'use strict';
/* Radar V4. Public market data only. All paths use Kraken-verified direct GBP pairs. */
const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = (key, value) => {try{localStorage.setItem(key, JSON.stringify(value));}catch(e){}};
const saved = (key, fallback) => {try {return JSON.parse(localStorage.getItem(key)) ?? fallback;}catch(e){return fallback;}};
const gbp = (n, opts={}) => {
  if(!Number.isFinite(Number(n))) return '—';
  const v=Number(n), a=Math.abs(v);
  const max = opts.decimals ?? (a===0?2:a>=1000?2:a>=1?4:a>=.01?5:a>=.001?6:a>=.00001?8:10);
  return '£'+v.toLocaleString('en-GB',{minimumFractionDigits:Math.min(2,max), maximumFractionDigits:max});
};
const money = n => gbp(n,{decimals:2});
const number = (n, dec=2) => Number.isFinite(Number(n))? Number(n).toLocaleString('en-GB',{maximumFractionDigits:dec}):'—';
const compactGBP = n => {if(!Number.isFinite(n))return '—';if(n>=1e9)return '£'+number(n/1e9,2)+'bn';if(n>=1e6)return '£'+number(n/1e6,2)+'m';if(n>=1e3)return '£'+number(n/1e3,1)+'k';return money(n);};
const pct = n => Number.isFinite(n)? (n>0?'+':'')+n.toFixed(2)+'%':'—';
const clock = ts => ts?new Date(ts*1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/London'})+' UK':'—';
const percentClass = n => n>0?'positive':n<0?'negative':'';
const statusClass = x => ({'SETUP':'pill-success','WATCH':'pill-warn','BLOCKED':'pill-muted','NO SETUP':'pill-muted','NO DATA':'pill-muted','ERROR':'pill-bad'})[x]||'pill-muted';
const statusText = x => ({'SETUP':'POTENTIAL SETUP','WATCH':'WATCH','BLOCKED':'FILTERED','NO SETUP':'NO SETUP','NO DATA':'NO DATA','ERROR':'ERROR'})[x]||x;
const MEME = new Set('DOGE SHIB PEPE BONK WIF FLOKI TRUMP FARTCOIN PENGU POPCAT BRETT MOG TURBO BOME MEW NEIRO GIGA PNUT GOAT SPX DEGEN TOSHI BABYDOGE LADYS PONKE WOJAK DOGS CHEEMS ACT AI16Z MOODENG SNEK ZEREBRO CHILLGUY PIPPIN CAT ZKJ MICHI FOOF MYRO'.split(' '));
const S={page:'overview', markets:[],byId:new Map(),fetchedAt:0,loading:false,err:false,favorites:new Set(saved('radar_favorites',[])),newMarkets:new Set(),pageCount:40,chartId:null,chartInterval:15,chartData:null,chartType:'candles',showVolume:true,chartRequest:0,bookRequest:0,scanResults:new Map(),scanRunning:false,scanStop:false,scanTotal:0,scanDone:0,scanErrors:0,calcId:null,lastBookTime:0,scanScope:[]};
let toastTimer;
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),4500);}
function banner(message){$('error-message').textContent=message;$('error-banner').classList.remove('hidden');}
function clearBanner(){$('error-banner').classList.add('hidden');}
async function api(path, body, signal){
  const options={headers:{'Accept':'application/json'},cache:'no-store',signal};
  if(body){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  let r;
  try{r=await fetch(path,options);}catch(e){if(e.name==='AbortError')throw e;throw Error('Cannot connect to the app server. Check your internet connection.');}
  let data;try{data=await r.json();}catch(e){throw Error('Server returned an unreadable response.');}
  if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:('Market data request failed ('+r.status+').'));
  return data;
}
function navigate(page){
  if(!$("page-"+page))return;
  S.page=page;
  all('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page));
  all('[data-page]').forEach(btn=>btn.classList.toggle('active',btn.dataset.page===page));
  const labels={overview:'Overview',radar:'Signal radar',markets:'All markets',chart:'Advanced chart',calculator:'Trade calculator',settings:'Preferences'};
  $('current-page-label').textContent=labels[page];
  window.scrollTo({top:0,behavior:'instant'});
  if(page==='chart'&&S.chartId)loadChart();
  if(page==='markets')renderMarkets();
  if(page==='calculator')chooseCalcMarket(S.calcId||S.chartId);
  if(page==='settings')$('setting-watch-count').textContent=S.favorites.size+' starred';
  if(page==='overview')renderHomeSignals();
}
function initNav(){
  all('[data-page]').forEach(e=>e.addEventListener('click',()=>navigate(e.dataset.page)));
  all('[data-goto]').forEach(e=>e.addEventListener('click',()=>navigate(e.dataset.goto)));
  $('error-dismiss').onclick=clearBanner;
  $('global-refresh').onclick=()=>refreshMarkets(true);
  $('market-search').addEventListener('input',()=>{S.pageCount=40;renderMarkets();});
  $('market-filter').onchange=()=>{S.pageCount=40;renderMarkets();};
  $('market-sort').onchange=()=>{S.pageCount=40;renderMarkets();};
  $('show-more').onclick=()=>{S.pageCount+=40;renderMarkets();};
  $('clear-favorites').onclick=()=>{S.favorites.clear();store('radar_favorites',[]);renderMarkets();$('setting-watch-count').textContent='0 starred';toast('Starred markets cleared.');};
  $('scan-button').onclick=runScan;
  $('stop-button').onclick=()=>{S.scanStop=true;$('stop-button').disabled=true;$('scan-status').textContent='STOPPING…';};
  $('chart-pair').onchange=e=>{S.chartId=e.target.value;S.calcId=S.chartId;loadChart();};
  all('#timeframes button').forEach(b=>b.onclick=()=>{S.chartInterval=Number(b.dataset.interval);all('#timeframes button').forEach(c=>c.classList.toggle('selected',c===b));loadChart();});
  $('chart-candles').onclick=()=>{S.chartType='candles';selectChartType();renderPlot();};
  $('chart-lines').onclick=()=>{S.chartType='line';selectChartType();renderPlot();};
  $('chart-volume').onclick=()=>{S.showVolume=!S.showVolume;$('chart-volume').classList.toggle('active',S.showVolume);renderPlot();};
  $('book-refresh').onclick=()=>loadBook(true);
  $('chart-calc-button').onclick=()=>{S.calcId=S.chartId;navigate('calculator');};
  $('calc-pair').onchange=e=>chooseCalcMarket(e.target.value);
  $('calc-button').onclick=runCalculator;
  $('scan-stake').addEventListener('change',()=>{$('calc-stake').value=$('scan-stake').value;});
  $('scan-fee').addEventListener('change',()=>{$('calc-fee').value=$('scan-fee').value;});
  $('scan-slip').addEventListener('change',()=>{$('calc-slip').value=$('scan-slip').value;});
}
function selectChartType(){
  $('chart-candles').classList.toggle('active',S.chartType==='candles');
  $('chart-lines').classList.toggle('active',S.chartType==='line');
}
async function refreshMarkets(manual=false){
  if(S.loading)return;
  S.loading=true;
  if(manual)toast('Refreshing Kraken GBP market snapshots…');
  try{
    const obj=await api('/api/markets');
    if(obj.quote!=='GBP'||!Array.isArray(obj.markets))throw Error('Market source did not confirm GBP pairs.');
    const markets=obj.markets.filter(m=>m.quote==='GBP'&&m.symbol.endsWith('/GBP')&&m.status==='online'&&m.has_quote&&m.last>0);
    if(!markets.length)throw Error('Kraken returned no active direct GBP markets.');
    const hadCatalogue=saved('radar_known_pairs_v4',null);
    const prior=new Set(Array.isArray(hadCatalogue)?hadCatalogue:[]);
    S.newMarkets=new Set([...S.newMarkets,...(hadCatalogue?markets.filter(m=>!prior.has(m.id)).map(m=>m.id):[])]);
    store('radar_known_pairs_v4',markets.map(m=>m.id));
    S.markets=markets;S.byId=new Map(markets.map(m=>[m.id,m]));S.fetchedAt=obj.retrieved_at;S.err=false;clearBanner();
    $('sidebar-connection').textContent='Snapshot '+clock(S.fetchedAt);
    document.querySelector('.network-box .online-orb').classList.remove('offline');
    $('overview-time').textContent='Price snapshot received '+clock(S.fetchedAt);
    renderStats();renderMovers();renderMarkets();renderHomeSignals();
    const oldChart=S.chartId;
    if(!oldChart||!S.byId.has(oldChart))S.chartId=markets.find(m=>m.symbol==='BEAM/GBP')?.id||markets.find(m=>m.symbol==='XBT/GBP'||m.symbol==='BTC/GBP')?.id||markets[0].id;
    if(!S.calcId||!S.byId.has(S.calcId))S.calcId=S.chartId;
    fillPairSelect('chart-pair',S.chartId);fillPairSelect('calc-pair',S.calcId);
    updateChartMarketPrice();
    if(S.page==='chart')loadChart(Boolean(S.chartData&&oldChart===S.chartId));
    if(S.page==='calculator')chooseCalcMarket(S.calcId);
    if(manual)toast('GBP market data updated.');
  }catch(e){
    S.err=true;banner(e.message+' Previously loaded prices, if shown, may be stale.');
    $('sidebar-connection').textContent='Connection issue';document.querySelector('.network-box .online-orb').classList.add('offline');
    if(!S.markets.length){$('top-movers').innerHTML='<div class="list-placeholder">Unable to retrieve Kraken market data. Try refreshing.</div>';$('market-rows').innerHTML='<tr><td colspan="6" class="table-empty">'+safe(e.message)+'</td></tr>';}
  }finally{S.loading=false;}
}
function fillPairSelect(id,chosen){
  const el=$(id); const prior=el.value;
  const arr=[...S.markets].sort((a,b)=>a.symbol.localeCompare(b.symbol));
  el.innerHTML=arr.map(m=>'<option value="'+safe(m.id)+'">'+safe(m.symbol)+'</option>').join('');
  el.value=S.byId.has(chosen)?chosen:S.byId.has(prior)?prior:arr[0]?.id||'';
}
function renderStats(){
  $('stat-pairs').textContent=number(S.markets.length,0);
  const rising=S.markets.filter(m=>Number.isFinite(m.change24)&&m.change24>0).length;
  $('stat-winners').textContent=number(rising,0);
  $('stat-volume').textContent=compactGBP(S.markets.reduce((a,m)=>a+(m.volume_gbp24||0),0));
  $('stat-signals').textContent=number([...S.scanResults.values()].filter(r=>r.status==='SETUP').length,0);
}
function avatar(m){return '<span class="coin-avatar">'+safe(m.base.length>4?m.base.slice(0,2):m.base.slice(0,3))+'</span>';}
function renderMovers(){
  const markets=S.markets.filter(x=>Number.isFinite(x.change24)).sort((a,b)=>b.change24-a.change24).slice(0,5);
  $('top-movers').innerHTML=markets.length?markets.map(m=>'<div class="mover-row" data-open-chart="'+safe(m.id)+'"><div class="coin-head">'+avatar(m)+'<div><strong>'+safe(m.base)+'</strong><small>'+safe(m.symbol)+'</small></div></div><div class="mover-price"><strong>'+gbp(m.last)+'</strong><small class="'+percentClass(m.change24)+'">'+pct(m.change24)+'</small></div></div>').join(''):'<div class="list-placeholder">No daily mover data available.</div>';
  all('#top-movers [data-open-chart]').forEach(row=>row.onclick=()=>openChart(row.dataset.openChart));
}
function marketPool(){
  const term=$('market-search').value.trim().toUpperCase();
  const filter=$('market-filter').value,sort=$('market-sort').value;
  let arr=S.markets.filter(m=>(!term||m.symbol.includes(term)||m.base.includes(term)) && (filter==='all'||filter==='meme'&&MEME.has(m.base)||filter==='favorites'&&S.favorites.has(m.id)||filter==='new'&&S.newMarkets.has(m.id)));
  arr=arr.slice().sort((a,b)=>sort==='gainers'?(b.change24??-1e9)-(a.change24??-1e9):sort==='losers'?(a.change24??1e9)-(b.change24??1e9):sort==='alphabetical'?a.symbol.localeCompare(b.symbol):b.volume_gbp24-a.volume_gbp24);
  return arr;
}
function renderMarkets(){
  if(!S.markets.length)return;
  const arr=marketPool();
  $('market-paging').textContent=arr.length?'Showing '+Math.min(arr.length,S.pageCount)+' of '+arr.length+' GBP markets':'0 matches';
  $('show-more').classList.toggle('hidden',arr.length<=S.pageCount);
  $('market-rows').innerHTML=arr.length?arr.slice(0,S.pageCount).map(m=>'<tr data-open-chart="'+safe(m.id)+'"><td><div class="market-name">'+avatar(m)+'<div><strong>'+safe(m.base)+'</strong>'+ (S.newMarkets.has(m.id)?'<span class="market-new">NEW HERE</span>':'')+'<small>'+safe(m.symbol)+'</small></div></div></td><td class="right market-price">'+gbp(m.last)+'</td><td class="right market-pct '+(m.change24>0?'up':m.change24<0?'down':'')+'">'+pct(m.change24)+'</td><td class="right hide-small">'+compactGBP(m.volume_gbp24)+'</td><td class="right hide-small">'+(Number.isFinite(m.spread_pct)?m.spread_pct.toFixed(2)+'%':'—')+'</td><td class="right"><button class="star-btn '+(S.favorites.has(m.id)?'starred':'')+'" data-star="'+safe(m.id)+'" aria-label="'+(S.favorites.has(m.id)?'Unstar ':'Star ')+safe(m.symbol)+'"><svg class="ico"><use href="#i-star"/></svg></button></td></tr>').join(''):'<tr><td colspan="6" class="table-empty">No matching direct GBP markets found.</td></tr>';
  all('#market-rows [data-open-chart]').forEach(row=>row.onclick=()=>openChart(row.dataset.openChart));
  all('#market-rows [data-star]').forEach(btn=>btn.onclick=e=>{e.stopPropagation();toggleStar(btn.dataset.star);});
}
function toggleStar(id){
  if(S.favorites.has(id))S.favorites.delete(id);else S.favorites.add(id);
  store('radar_favorites',[...S.favorites]);renderMarkets();
  toast(S.favorites.has(id)?'Added to your starred GBP markets.':'Removed from starred markets.');
}
function openChart(pairId){S.chartId=pairId;S.calcId=pairId;$('chart-pair').value=pairId;navigate('chart');}
function updateChartMarketPrice(){
  const m=S.byId.get(S.chartId);if(!m)return;
  $('chart-last').textContent=gbp(m.last);
  $('chart-change').textContent=pct(m.change24)+' 24H';
  $('chart-change').className='pill '+(m.change24>=0?'pill-success':'pill-bad');
  $('chart-metrics').innerHTML=[
    ['Market',m.symbol],['Last trade',gbp(m.last)],['Best bid',gbp(m.bid)],['Best ask',gbp(m.ask)],['Bid/ask spread',Number.isFinite(m.spread_pct)?m.spread_pct.toFixed(3)+'%':'—'],['24h high',gbp(m.high24)],['24h low',gbp(m.low24)],['24h turnover',compactGBP(m.volume_gbp24)],['Snapshot fetched',clock(S.fetchedAt)]
  ].map(([n,v])=>'<div><span>'+safe(n)+'</span><strong>'+safe(v)+'</strong></div>').join('');
}
async function loadChart(silent=false){
  const m=S.byId.get(S.chartId);if(!m||S.page!=='chart')return;
  $('chart-pair').value=m.id;updateChartMarketPrice();
  const key=++S.chartRequest;
  const chart=$('chart-plot');
  if(!silent)chart.innerHTML='<div class="chart-wait"><div class="loading-ring"></div><span>Loading '+safe(m.symbol)+' candles…</span></div>';
  if(!silent)$('chart-freshness').textContent='Retrieving completed GBP candles…';
  try{
    const obj=await api('/api/candles?pair='+encodeURIComponent(m.id)+'&interval='+S.chartInterval);
    if(key!==S.chartRequest)return;
    if(obj.quote!=='GBP'||obj.pair.symbol!==m.symbol)throw Error('Chart did not verify direct GBP data.');
    S.chartData=obj;
    renderPlot();
    const recentClose=obj.candles[obj.candles.length-2];
    const end=recentClose?.time+obj.interval*60;
    const age=end?Math.max(0,Date.now()/1000-end):NaN;
    $('chart-freshness').innerHTML='<span class="online-orb '+(age>obj.interval*60*2.5?'offline':'')+'"></span> '+safe('Fetched '+clock(obj.retrieved_at)+' · '+obj.complete_count+' closed candles · last candle forming'+(Number.isFinite(age)&&age>obj.interval*60*2.5?' · possible low activity':''));
  }catch(e){if(key!==S.chartRequest)return;S.chartData=null;chart.innerHTML='<div class="chart-wait">'+safe(e.message)+'</div>';toast(e.message);}
  loadBook();
}
function renderPlot(){
  const data=S.chartData;if(!data||S.page!=='chart'||!window.Plotly)return;
  const bars=data.candles;if(!bars.length){$('chart-plot').innerHTML='<div class="chart-wait">Kraken returned no candles for this market.</div>';return;}
  const t=bars.map(x=>new Date(x.time*1000).toISOString()),up=bars.map(x=>x.close>=x.open);
  const traces=[];
  if(S.chartType==='candles')traces.push({type:'candlestick',x:t,open:bars.map(x=>x.open),high:bars.map(x=>x.high),low:bars.map(x=>x.low),close:bars.map(x=>x.close),name:'GBP price',increasing:{line:{color:'#64dea7',width:1},fillcolor:'#3eaf89'},decreasing:{line:{color:'#f6828c',width:1},fillcolor:'#e26c80'},hoverlabel:{namelength:0},showlegend:false,yaxis:'y'});
  else traces.push({type:'scatter',mode:'lines',x:t,y:bars.map(x=>x.close),name:'GBP price',line:{color:'#8df2bd',width:2},hovertemplate:'%{y}<extra></extra>',showlegend:false,yaxis:'y',fill:'tozeroy',fillcolor:'rgba(106,217,164,.025)'});
  if(S.showVolume)traces.push({type:'bar',x:t,y:bars.map(x=>x.volume),marker:{color:up.map(v=>v?'rgba(70,202,144,.49)':'rgba(233,110,131,.42)')},name:'Volume (tokens)',yaxis:'y2',hovertemplate:'%{y:.3s} tokens<extra>Volume</extra>',showlegend:false});
  const last=bars[bars.length-1].close;
  const digits=last>=1?2:last>=.01?4:last>=.001?6:last>=.0001?7:9;
  const mobile=window.innerWidth<700;
  const layout={paper_bgcolor:'#101822',plot_bgcolor:'#101822',font:{family:'Inter,system-ui,sans-serif',color:'#8297a5',size:10},showlegend:false,
    margin:{l:mobile?58:76,r:mobile?13:34,t:16,b:40},height:mobile?350:450,autosize:true,
    xaxis:{type:'date',gridcolor:'#1e2d37',showgrid:true,zeroline:false,showline:false,tickfont:{size:10},tickformat:mobile?'%e %b\n%H:%M':'%e %b %H:%M',rangeslider:{visible:false},showspikes:true,spikethickness:1,spikecolor:'#607a80',spikedash:'dot',range:[t[Math.max(0,t.length-Math.min(120,t.length))],t[t.length-1]],fixedrange:false},
    yaxis:{domain:S.showVolume?[.23,1]:[.07,1],side:'left',showgrid:true,gridcolor:'#21313d',zeroline:false,tickprefix:'£',tickformat:'.'+digits+'f',tickfont:{size:10},showspikes:true,spikecolor:'#647f89',spikedash:'dot',spikethickness:1,fixedrange:false},
    yaxis2:{domain:[0,.18],side:'right',showgrid:false,zeroline:false,showticklabels:false,fixedrange:true},
    uirevision:S.chartId+'-'+S.chartInterval,dragmode:'pan',hovermode:'x unified',hoverlabel:{bgcolor:'#172b30',bordercolor:'#3c6258',font:{size:11,color:'#dff8e6'}},
    bargap:.17,shapes:[]};
  // No retroactive data extrapolation: the last bar is genuinely uncommitted.
  const plot=$('chart-plot');
  Plotly.react(plot,traces,layout,{responsive:true,scrollZoom:true,displaylogo:false,modeBarButtonsToRemove:['toImage','select2d','lasso2d','autoScale2d','toggleSpikelines','hoverClosestCartesian','hoverCompareCartesian'],displayModeBar:!mobile,doubleClick:'reset'});
}
async function loadBook(force=false){
  const m=S.byId.get(S.chartId);if(!m||S.page!=='chart')return;
  if(!force&&S.lastBookTime&&Date.now()-S.lastBookTime<10000)return;
  const key=++S.bookRequest;
  try{
    const obj=await api('/api/book?pair='+encodeURIComponent(m.id));
    if(key!==S.bookRequest||obj.pair!==m.symbol)return;
    for(const side of ['bids','asks']){
      const el=$('book-'+side);
      el.innerHTML=(obj[side]||[]).slice(0,9).map(level=>'<div class="book-level '+(side==='asks'?'ask':'')+'"><span>'+gbp(level.price)+'</span><span>'+compactGBP(level.total_gbp)+'</span></div>').join('')||'<div class="list-placeholder">No levels</div>';
    }
    S.lastBookTime=Date.now();$('book-asof').textContent='Order book received '+clock(obj.retrieved_at);
  }catch(e){if(key!==S.bookRequest)return;$('book-asof').textContent='Order book unavailable: '+e.message;}
}
function scanSettings(){
  const st={stake:Number($('scan-stake').value),fee_pct:Number($('scan-fee').value),slippage_pct:Number($('scan-slip').value),min_volume_gbp:Number($('scan-min-volume').value),max_spread_pct:Number($('scan-max-spread').value),interval:Number($('scan-interval').value)};
  if(!(st.stake>=1&&st.stake<=100000&&st.fee_pct>=0&&st.fee_pct<20&&st.slippage_pct>=0&&st.slippage_pct<20&&st.min_volume_gbp>=0&&st.max_spread_pct>0&&st.max_spread_pct<=20))throw Error('Check your stake, fees, slippage and filter values.');
  return st;
}
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function runScan(){
  if(S.scanRunning)return;
  if(!S.markets.length){toast('Connect to Kraken before starting a scan.');return;}
  let settings;try{settings=scanSettings();}catch(e){toast(e.message);return;}
  const mode=$('scan-universe').value;
  const markets=S.markets.filter(m=>mode==='all'||mode==='volume'||mode==='meme'&&MEME.has(m.base)||mode==='favorites'&&S.favorites.has(m.id));
  const universe=mode==='volume'?markets.slice(0,50):markets;
  if(!universe.length){toast('No direct GBP markets found in this selection.');return;}
  S.scanRunning=true;S.scanStop=false;S.scanResults.clear();S.scanTotal=universe.length;S.scanDone=0;S.scanErrors=0;S.scanScope=universe.map(x=>x.id);
  $('scan-button').disabled=true;$('stop-button').disabled=false;$('stop-button').classList.remove('hidden');
  $('scan-results').innerHTML='<div class="list-placeholder">Retrieving fresh Kraken candles…</div>';
  $('scan-status').className='pill pill-success';$('scan-status').textContent='SCANNING';
  updateScanProgress();let failedBatches=0;
  try{
    for(let index=0;index<universe.length;index+=6){
      if(S.scanStop)break;
      const chunk=universe.slice(index,index+6).map(m=>m.id);
      try{
        const result=await api('/api/scan',{...settings,pairs:chunk});
        if(result.quote!=='GBP')throw Error('Batch not verified as GBP.');
        for(const r of result.results){S.scanResults.set(r.id,r);if(r.status==='ERROR')S.scanErrors++;}
        failedBatches=0;
      }catch(e){
        failedBatches++;
        for(const id of chunk){S.scanResults.set(id,{id,pair:S.byId.get(id)?.symbol,status:'ERROR',reason:e.message});S.scanErrors++;}
        banner('Scan encountered a Kraken / server error: '+e.message+'. Some markets could not be analysed.');
        if(failedBatches>=3){S.scanStop=true;toast('Scan paused after repeated data errors.');}
      }
      S.scanDone=Math.min(index+chunk.length,universe.length);updateScanProgress();renderScanResults();renderStats();renderHomeSignals();
      if(index+6<universe.length&&!S.scanStop)await wait(1700);
    }
  }finally{
    S.scanRunning=false;$('scan-button').disabled=false;$('stop-button').classList.add('hidden');
    $('scan-status').className='pill '+(S.scanStop?'pill-warn':'pill-success');
    $('scan-status').textContent=S.scanStop?'STOPPED':'SCAN COMPLETE';
    updateScanProgress();toast((S.scanStop?'Stopped':'Finished')+' · '+S.scanDone+' of '+S.scanTotal+' markets processed.');
  }
}
function updateScanProgress(){
  $('scan-count').textContent=S.scanDone+' / '+S.scanTotal;
  $('scan-qualified').textContent=[...S.scanResults.values()].filter(r=>r.status==='SETUP').length;
  $('scan-watching').textContent=[...S.scanResults.values()].filter(r=>r.status==='WATCH').length;
  $('scan-progress').style.width=(S.scanTotal?100*S.scanDone/S.scanTotal:0)+'%';
}
function rankedResults(){const order={SETUP:0,WATCH:1,BLOCKED:2,'NO SETUP':3,'NO DATA':4,ERROR:5};return [...S.scanResults.values()].sort((a,b)=>(order[a.status]??9)-(order[b.status]??9)|| (b.score??0)-(a.score??0));}
function signalMarkup(r,short=false){
  const m=S.byId.get(r.id);const scenario=r.scenario;
  const label=safe(r.pair||m?.symbol||r.id);
  let html='<article class="signal-card '+(r.status==='SETUP'?'setup':r.status==='WATCH'?'watch':'')+'"><div class="signal-head"><div><h3>'+label+'</h3><small>'+(r.score!==undefined?r.score+'/5 conditions · '+r.bars_used+' closed bars · '+r.interval+'m':'Unscanned / market data error')+'</small></div><span class="pill '+statusClass(r.status)+'">'+statusText(r.status)+'</span></div>';
  if(scenario)html+='<div class="signal-metrics"><div><small>Reference entry ask</small><strong>'+gbp(scenario.entry_gbp)+'</strong></div><div><small>Hypothetical target</small><strong>'+gbp(scenario.target_gbp)+'</strong></div><div><small>Stop level</small><strong>'+gbp(scenario.stop_gbp)+'</strong></div><div><small>Target net for '+money(scenario.stake_gbp)+'</small><strong class="'+percentClass(scenario.target_net_gbp)+'">'+(scenario.target_net_gbp>=0?'+':'')+money(scenario.target_net_gbp)+'</strong></div><div><small>If stop fills</small><strong class="negative">'+money(scenario.stop_net_gbp)+'</strong></div><div><small>Net reward : risk</small><strong>'+(scenario.reward_risk??'—')+':1</strong></div></div>';
  if(!short){
    html+='<div class="signal-actions"><button data-signal-chart="'+safe(r.id)+'">Inspect chart</button>'+(scenario?'<button data-signal-calc="'+safe(r.id)+'">Open risk calculator</button>':'')+'</div>';
    if(r.rules?.length || r.quality?.length || r.reason || r.reasons?.length){
      html+='<details class="signal-details"><summary>Why this result? · expand methodology</summary>';
      if(r.rules?.length)html+='<div class="rule-grid">'+r.rules.map(rule=>'<div class="rule-line '+(rule.passed?'pass':'')+'"><b>'+(rule.passed?'✓':'×')+'</b><span><strong>'+safe(rule.name)+'</strong><br>'+safe(rule.detail)+'</span></div>').join('')+'</div>';
      const reasons=[...(r.quality||[]),...(r.reasons||[]),...(r.reason?[r.reason]:[])];
      if(reasons.length)html+='<ul class="quality-warnings">'+reasons.map(x=>'<li>'+safe(x)+'</li>').join('')+'</ul>';
      html+='</details>';
    }
  }else html+='<div class="signal-actions"><button data-signal-chart="'+safe(r.id)+'">Inspect chart</button></div>';
  return html+'</article>';
}
function attachSignalActions(container){all(container+' [data-signal-chart]').forEach(btn=>btn.onclick=()=>openChart(btn.dataset.signalChart));all(container+' [data-signal-calc]').forEach(btn=>btn.onclick=()=>{S.calcId=btn.dataset.signalCalc;S.chartId=S.calcId;navigate('calculator');});}
function renderScanResults(){
  const ranked=rankedResults();
  const el=$('scan-results');
  if(!ranked.length){el.innerHTML='<div class="list-placeholder">No results received yet.</div>';return;}
  // Display every finished result; scroll to inspect no-setup and quality-filtered entries.
  el.innerHTML=ranked.map(r=>signalMarkup(r)).join('');attachSignalActions('#scan-results');
}
function renderHomeSignals(){
  const candidates=rankedResults().filter(r=>r.status==='SETUP').slice(0,3);
  if(!candidates.length){
    const tested=S.scanResults.size;
    $('home-signals').innerHTML='<div class="empty-state"><div class="empty-icon"><svg class="ico"><use href="#i-radar"/></svg></div><strong>'+(tested?'No qualified setups yet':'Your radar is ready')+'</strong><span>'+(tested?tested+' markets checked. No current setup has passed all quality gates.':'Run a scan to inspect GBP market setups.')+'</span><button class="btn btn-outline small" data-goto="radar">Open scanner</button></div>';
    all('#home-signals [data-goto]').forEach(b=>b.onclick=()=>navigate('radar'));
  }else {$('home-signals').innerHTML=candidates.map(x=>signalMarkup(x,true)).join('');attachSignalActions('#home-signals');}
}
function chooseCalcMarket(pairId){
  if(!pairId||!S.byId.has(pairId))return;
  S.calcId=pairId;$('calc-pair').value=pairId;
  const m=S.byId.get(pairId);
  const r=S.scanResults.get(pairId);
  const s=r?.scenario;
  $('calc-entry').value=String(s?.entry_gbp||m.ask||m.last||0);
  $('calc-target').value=String(s?.target_gbp||+(m.ask*1.04).toPrecision(9));
  $('calc-stop').value=String(s?.stop_gbp||+(m.ask*.98).toPrecision(9));
  $('calc-validation').textContent=s?'Using levels from the most recent scan. Quotes may have changed.':'Example target +4% and stop −2% for illustration only — not a prediction.';
  $('calc-profit').textContent='—';$('calc-loss').textContent='—';$('calc-rr').textContent='—';$('calc-units').textContent='—';$('calc-return').textContent='—';
  $('calc-initial').textContent=money(Number($('calc-stake').value));
}
async function runCalculator(){
  const payload={stake:Number($('calc-stake').value),entry:Number($('calc-entry').value),target:Number($('calc-target').value),stop:Number($('calc-stop').value),fee_pct:Number($('calc-fee').value),slippage_pct:Number($('calc-slip').value)};
  try{
    const v=await api('/api/calculate',payload);
    $('calc-profit').textContent=(v.target_net_gbp>=0?'+':'')+money(v.target_net_gbp);
    $('calc-loss').textContent=money(v.stop_net_gbp);
    $('calc-rr').textContent=v.reward_risk==null?'—':v.reward_risk+':1';
    $('calc-units').textContent=number(v.units,4);
    $('calc-return').textContent=pct(v.target_return_pct);
    $('calc-initial').textContent=money(v.stake_gbp);
    $('calc-validation').textContent='Scenario calculated from your inputs. Fees and slippage applied to both sides.';
  }catch(e){$('calc-validation').textContent=e.message;toast(e.message);}
}
function init(){
  initNav();
  $('clock').textContent=new Date().toLocaleString('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  setInterval(()=>{$('clock').textContent=new Date().toLocaleString('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});},30000);
  refreshMarkets();
  setInterval(()=>{if(!document.hidden)refreshMarkets(false);},60000);
  if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('/static/sw.js').catch(()=>{});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
