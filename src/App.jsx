import { useState, useEffect, useRef } from "react";

// ── ASSETS ──────────────────────────────────────────────────────────────────
const ASSETS = [
  { symbol:"BTCUSDT",  display:"BTC",  name:"Bitcoin",   base:67400 },
  { symbol:"ETHUSDT",  display:"ETH",  name:"Ethereum",  base:3540  },
  { symbol:"BNBUSDT",  display:"BNB",  name:"BNB",       base:580   },
  { symbol:"SOLUSDT",  display:"SOL",  name:"Solana",    base:172   },
  { symbol:"XRPUSDT",  display:"XRP",  name:"XRP",       base:0.62  },
  { symbol:"ADAUSDT",  display:"ADA",  name:"Cardano",   base:0.47  },
  { symbol:"DOGEUSDT", display:"DOGE", name:"Dogecoin",  base:0.155 },
  { symbol:"AVAXUSDT", display:"AVAX", name:"Avalanche", base:38.4  },
  { symbol:"LINKUSDT", display:"LINK", name:"Chainlink", base:17.6  },
  { symbol:"DOTUSDT",  display:"DOT",  name:"Polkadot",  base:7.9   },
];

// ── HELPERS ──────────────────────────────────────────────────────────────────
const dp  = (v, base) => base < 1 ? v.toFixed(5) : base < 10 ? v.toFixed(3) : v.toFixed(2);
const fmt = (v, s="$") => `${v<0?"-":""}${s}${Math.abs(v)>=1000?(Math.abs(v)/1000).toFixed(1)+"k":Math.abs(v).toFixed(2)}`;
const ts  = () => new Date().toLocaleTimeString("en-US",{hour12:false});

// ── BINANCE HMAC SIGNING ─────────────────────────────────────────────────────
async function sign(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

// ── BINANCE SPOT API ─────────────────────────────────────────────────────────
async function spotRequest(ak, as_, method, path, params={}) {
  const q = new URLSearchParams({...params, timestamp:Date.now()}).toString();
  const sig = await sign(as_, q);
  const res = await fetch(`https://api.binance.com${path}?${q}&signature=${sig}`, {
    method, headers:{"X-MBX-APIKEY":ak}
  });
  const d = await res.json();
  if (d.code && d.code < 0) throw new Error(d.msg);
  return d;
}

// ── BINANCE FUTURES API ───────────────────────────────────────────────────────
async function futuresRequest(ak, as_, method, path, params={}) {
  const q = new URLSearchParams({...params, timestamp:Date.now()}).toString();
  const sig = await sign(as_, q);
  const res = await fetch(`https://fapi.binance.com${path}?${q}&signature=${sig}`, {
    method, headers:{"X-MBX-APIKEY":ak}
  });
  const d = await res.json();
  if (d.code && d.code < 0) throw new Error(d.msg);
  return d;
}

async function getSpotBalance(ak, as_) {
  const d = await spotRequest(ak, as_, "GET", "/api/v3/account");
  return parseFloat(d.balances?.find(b=>b.asset==="USDT")?.free || 0);
}

async function getFuturesBalance(ak, as_) {
  const d = await futuresRequest(ak, as_, "GET", "/fapi/v2/balance");
  return parseFloat(d.find?.(b=>b.asset==="USDT")?.availableBalance || 0);
}

async function getLivePrices() {
  const prices = {};
  await Promise.all(ASSETS.map(async a => {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${a.symbol}`);
      const d = await r.json();
      prices[a.symbol] = parseFloat(d.price);
    } catch { prices[a.symbol] = a.base; }
  }));
  return prices;
}

// Spot BUY/SELL
async function placeSpotOrder(ak, as_, symbol, side, usdtAmt) {
  return spotRequest(ak, as_, "POST", "/api/v3/order", {
    symbol, side, type:"MARKET", quoteOrderQty: usdtAmt.toFixed(2)
  });
}

// Futures LONG/SHORT open
async function placeFuturesOrder(ak, as_, symbol, side, qty, leverage=5) {
  // Set leverage first
  await futuresRequest(ak, as_, "POST", "/fapi/v1/leverage", {symbol, leverage});
  return futuresRequest(ak, as_, "POST", "/fapi/v1/order", {
    symbol, side, type:"MARKET", quantity: qty.toFixed(4), positionSide:"BOTH"
  });
}

// Futures close position
async function closeFuturesPosition(ak, as_, symbol, side, qty) {
  const closeSide = side === "LONG" ? "SELL" : "BUY";
  return futuresRequest(ak, as_, "POST", "/fapi/v1/order", {
    symbol, side:closeSide, type:"MARKET", quantity:qty.toFixed(4),
    positionSide:"BOTH", reduceOnly:"true"
  });
}

// ── SPOT ENGINE (long only) ───────────────────────────────────────────────────
function spotEngine(prices, positions, cash) {
  const actions = [];
  const scored = ASSETS.map(a => ({
    ...a, cur: prices[a.symbol]||a.base,
    chg: ((prices[a.symbol]||a.base) - a.base) / a.base,
    held: !!positions.find(p=>p.symbol===a.symbol)
  }));

  for (const pos of positions) {
    const cur = prices[pos.symbol]||pos.entry;
    const pct = (cur - pos.entry)/pos.entry;
    if (pct <= -0.025 || pct >= 0.045)
      actions.push({type:"SELL", symbol:pos.symbol, reason: pct<0?"stop-loss":"take-profit"});
  }

  if (positions.length < 4 && cash * 0.06 > 10) {
    scored.filter(s=>!s.held && !actions.find(a=>a.symbol===s.symbol) && s.chg>0.001)
      .sort((a,b)=>b.chg-a.chg).slice(0,2)
      .forEach(c=>actions.push({type:"BUY", symbol:c.symbol, reason:`momentum +${(c.chg*100).toFixed(2)}%`}));
  }

  const bull = scored.filter(s=>s.chg>0).length;
  const sent = bull>scored.length*0.6?"bullish 📈":bull<scored.length*0.4?"bearish 📉":"mixed ↔️";
  return {actions, commentary:`Spot: ${sent} — ${bull}/${scored.length} up`};
}

// ── PRICE HISTORY STORE (for indicators) ────────────────────────────────────
const priceHistory = {}; // { symbol: [price, price, ...] } max 50 candles

function updateHistory(prices) {
  ASSETS.forEach(a => {
    if (!priceHistory[a.symbol]) priceHistory[a.symbol] = [];
    const h = priceHistory[a.symbol];
    h.push(prices[a.symbol] || a.base);
    if (h.length > 50) h.shift();
  });
}

// ── TECHNICAL INDICATORS ──────────────────────────────────────────────────────
function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(data, period = 14) {
  if (data.length < period + 1) return null;
  const slice = data.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcMACD(data) {
  const ema12 = calcEMA(data, 12);
  const ema26 = calcEMA(data, 26);
  if (!ema12 || !ema26) return null;
  return ema12 - ema26; // positive = bullish, negative = bearish
}

function calcMomentum(data, period = 10) {
  if (data.length < period + 1) return null;
  const cur = data[data.length - 1];
  const prev = data[data.length - 1 - period];
  return ((cur - prev) / prev) * 100;
}

function calcBollingerBands(data, period = 20) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / period);
  return { upper: mean + 2 * std, lower: mean - 2 * std, mean, std };
}

// ── SIGNAL SCORER: returns score -100 to +100 ──────────────────────────────
function scoreAsset(symbol) {
  const h = priceHistory[symbol];
  if (!h || h.length < 27) return { score: 0, signals: [], confidence: "LOW" };

  const cur   = h[h.length - 1];
  const rsi   = calcRSI(h);
  const macd  = calcMACD(h);
  const mom   = calcMomentum(h, 10);
  const ema9  = calcEMA(h, 9);
  const ema21 = calcEMA(h, 21);
  const bb    = calcBollingerBands(h, 20);

  let score = 0;
  const signals = [];

  // RSI signal (oversold = bullish, overbought = bearish)
  if (rsi !== null) {
    if (rsi < 30)       { score += 35; signals.push(`RSI oversold(${rsi.toFixed(0)})`); }
    else if (rsi < 45)  { score += 15; signals.push(`RSI bullish(${rsi.toFixed(0)})`); }
    else if (rsi > 70)  { score -= 35; signals.push(`RSI overbought(${rsi.toFixed(0)})`); }
    else if (rsi > 55)  { score -= 15; signals.push(`RSI bearish(${rsi.toFixed(0)})`); }
  }

  // MACD crossover
  if (macd !== null) {
    if (macd > 0)  { score += 25; signals.push("MACD bullish"); }
    else           { score -= 25; signals.push("MACD bearish"); }
  }

  // EMA crossover (fast > slow = uptrend)
  if (ema9 && ema21) {
    if (ema9 > ema21)  { score += 20; signals.push("EMA cross UP"); }
    else               { score -= 20; signals.push("EMA cross DN"); }
  }

  // Momentum
  if (mom !== null) {
    if (mom > 1)       { score += 15; signals.push(`Mom +${mom.toFixed(1)}%`); }
    else if (mom < -1) { score -= 15; signals.push(`Mom ${mom.toFixed(1)}%`); }
  }

  // Bollinger Bands squeeze/breakout
  if (bb) {
    if (cur < bb.lower) { score += 10; signals.push("BB oversold"); }
    if (cur > bb.upper) { score -= 10; signals.push("BB overbought"); }
  }

  const abs = Math.abs(score);
  const confidence = abs >= 60 ? "HIGH" : abs >= 35 ? "MED" : "LOW";
  return { score, signals, confidence, rsi, macd, ema9, ema21 };
}

// ── TRAILING STOP UPDATER ───────────────────────────────────────────────────
function updateTrailingStops(positions, prices, trailingPct = 0.015) {
  return positions.map(p => {
    const cur = prices[p.symbol] || p.entry;
    if (p.side === "LONG") {
      const newSL = +(cur * (1 - trailingPct)).toFixed(2);
      return { ...p, sl: Math.max(p.sl, newSL), highWater: Math.max(p.highWater || p.entry, cur) };
    } else {
      const newSL = +(cur * (1 + trailingPct)).toFixed(2);
      return { ...p, sl: Math.min(p.sl, newSL), highWater: Math.min(p.highWater || p.entry, cur) };
    }
  });
}

// ── FULLY AUTOMATED FUTURES ENGINE ──────────────────────────────────────────
function futuresEngine(prices, positions, cash, leverage = 5) {
  // Update price history each call
  updateHistory(prices);

  const actions = [];
  const analysis = ASSETS.map(a => ({
    ...a,
    cur: prices[a.symbol] || a.base,
    ...scoreAsset(a.symbol),
    held: positions.find(p => p.symbol === a.symbol),
  }));

  // ── 1. Update trailing stops first ─────────────────────────────────────
  const updatedPositions = updateTrailingStops(positions, prices);

  // ── 2. Check exit conditions for every open position ───────────────────
  for (const pos of updatedPositions) {
    const cur = prices[pos.symbol] || pos.entry;
    const pnlPct = pos.side === "LONG"
      ? (cur - pos.entry) / pos.entry
      : (pos.entry - cur) / pos.entry;
    const leveragedPnl = pnlPct * pos.leverage;

    // Hard SL/TP
    const hitSL = pos.side === "LONG" ? cur <= pos.sl : cur >= pos.sl;
    const hitTP = pos.side === "LONG" ? cur >= pos.tp : cur <= pos.tp;

    // Signal reversal exit: if we're LONG but signal flipped strongly SHORT, exit
    const assetScore = analysis.find(a => a.symbol === pos.symbol)?.score || 0;
    const signalReversed = pos.side === "LONG" && assetScore < -40;
    const signalFlipped  = pos.side === "SHORT" && assetScore > 40;

    if (hitSL)          { actions.push({ type:"CLOSE", symbol:pos.symbol, side:pos.side, reason:`Trailing SL hit (${(leveragedPnl*100).toFixed(1)}%)`, updatedSL: pos.sl, updatedTP: pos.tp }); }
    else if (hitTP)     { actions.push({ type:"CLOSE", symbol:pos.symbol, side:pos.side, reason:`TP hit (+${(leveragedPnl*100).toFixed(1)}%)` }); }
    else if (signalReversed || signalFlipped) {
      actions.push({ type:"CLOSE", symbol:pos.symbol, side:pos.side, reason:`Signal reversed → rotating` });
    }
  }

  // ── 3. Open new positions based on scored signals ───────────────────────
  const openAfterCloses = updatedPositions.length - actions.filter(a => a.type === "CLOSE").length;
  const maxPos = 5;
  const slotsAvailable = maxPos - openAfterCloses;

  if (slotsAvailable > 0 && cash * 0.05 > 10) {
    const candidates = analysis
      .filter(a => {
        const alreadyHeld = !!updatedPositions.find(p => p.symbol === a.symbol);
        const beingClosed = !!actions.find(ac => ac.symbol === a.symbol);
        const strongSignal = Math.abs(a.score) >= 50;
        return !alreadyHeld && !beingClosed && strongSignal && a.confidence !== "LOW";
      })
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, Math.min(slotsAvailable, 2));

    for (const c of candidates) {
      const side = c.score > 0 ? "LONG" : "SHORT";
      const topSignal = c.signals.slice(0, 2).join(", ");
      actions.push({
        type: "OPEN", symbol: c.symbol, side,
        score: c.score, confidence: c.confidence,
        reason: `${side} | ${topSignal} | score:${c.score > 0 ? "+" : ""}${c.score}`
      });
    }
  }

  // ── 4. Build commentary ────────────────────────────────────────────────
  const longs  = updatedPositions.filter(p => p.side === "LONG").length;
  const shorts = updatedPositions.filter(p => p.side === "SHORT").length;
  const highConf = analysis.filter(a => a.confidence === "HIGH").length;
  const bullScore = analysis.reduce((s, a) => s + a.score, 0);
  const marketBias = bullScore > 50 ? "📈 Bullish bias" : bullScore < -50 ? "📉 Bearish bias" : "↔️ Neutral";
  const commentary = `${marketBias} | ${longs}L ${shorts}S | ${highConf} high-conf signals | ${actions.length} action(s)`;

  return { actions, commentary, analysis, updatedPositions };
}

// ── ROOT APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,     setScreen]     = useState("setup");
  const [apiKey,     setApiKey]     = useState("");
  const [apiSecret,  setApiSecret]  = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing,    setTesting]    = useState(false);
  const [tab,        setTab]        = useState("spot"); // spot | futures
  const [mode,       setMode]       = useState("paper");

  // Shared
  const [prices,    setPrices]    = useState({});
  const [flash,     setFlash]     = useState({});
  const prevP = useRef({});

  // Spot state
  const [spotPos,   setSpotPos]   = useState([]);
  const [spotCash,  setSpotCash]  = useState(0);
  const [spotPnl,   setSpotPnl]   = useState(0);
  const [spotBal,   setSpotBal]   = useState(0);
  const [spotLog,   setSpotLog]   = useState([]);
  const [spotNote,  setSpotNote]  = useState("Press RUN");
  const [spotRun,   setSpotRun]   = useState(false);
  const [spotTrades,setSpotTrades]= useState(0);
  const spotPosRef  = useRef([]);
  const spotCashRef = useRef(0);
  const spotPnlRef  = useRef(0);
  const spotTcRef   = useRef(0);
  const spotBusy    = useRef(false);
  const spotTimer   = useRef(null);

  // Futures state
  const [futPos,    setFutPos]    = useState([]);
  const [futCash,   setFutCash]   = useState(0);
  const [futPnl,    setFutPnl]    = useState(0);
  const [futBal,    setFutBal]    = useState(0);
  const [futLog,    setFutLog]    = useState([]);
  const [futNote,   setFutNote]   = useState("Press RUN");
  const [futRun,    setFutRun]    = useState(false);
  const [futTrades, setFutTrades] = useState(0);
  const [leverage,  setLeverage]  = useState(5);
  const futPosRef  = useRef([]);
  const futCashRef = useRef(0);
  const futPnlRef  = useRef(0);
  const futTcRef   = useRef(0);
  const futBusy    = useRef(false);
  const futTimer   = useRef(null);

  const keyRef = useRef({apiKey:"", apiSecret:""});

  useEffect(()=>{ spotPosRef.current=spotPos; },[spotPos]);
  useEffect(()=>{ spotCashRef.current=spotCash; },[spotCash]);
  useEffect(()=>{ futPosRef.current=futPos; },[futPos]);
  useEffect(()=>{ futCashRef.current=futCash; },[futCash]);

  // ── Test Connection ──────────────────────────────────────────────────────
  const testConnection = async () => {
    setTesting(true);
    setTestResult("Connecting…");
    try {
      const [sBal, livePrices] = await Promise.all([
        getSpotBalance(apiKey, apiSecret),
        getLivePrices()
      ]);
      let fBal = 0;
      try { fBal = await getFuturesBalance(apiKey, apiSecret); } catch {}
      setPrices(livePrices);
      setSpotBal(sBal); setSpotCash(sBal); spotCashRef.current = sBal;
      setFutBal(fBal);  setFutCash(fBal);  futCashRef.current  = fBal;
      keyRef.current = {apiKey, apiSecret};
      setTestResult(`✅ Spot: $${sBal.toFixed(2)} | Futures: $${fBal.toFixed(2)}`);
      setTimeout(()=>setScreen("live"), 1500);
    } catch(e) { setTestResult(`❌ ${e.message}`); }
    setTesting(false);
  };

  // ── Price refresh ────────────────────────────────────────────────────────
  useEffect(()=>{
    if (screen!=="live") return;
    const refresh = async () => {
      const live = await getLivePrices();
      const f = {};
      ASSETS.forEach(a=>{
        const c=live[a.symbol], p=prevP.current[a.symbol];
        if(c&&p&&c!==p) f[a.symbol]=c>p?"up":"dn";
      });
      prevP.current={...live};
      setPrices(live);
      if(Object.keys(f).length){setFlash(f); setTimeout(()=>setFlash({}),600);}
    };
    refresh();
    const id = setInterval(refresh, 3000);
    return ()=>clearInterval(id);
  },[screen]);

  // ── SPOT CYCLE ───────────────────────────────────────────────────────────
  const spotCycle = async () => {
    if (spotBusy.current) return;
    spotBusy.current = true;
    const {apiKey:ak, apiSecret:as_} = keyRef.current;
    try {
      const live = await getLivePrices();
      setPrices(live);
      const result = spotEngine(live, spotPosRef.current, spotCashRef.current);
      setSpotNote(result.commentary);
      let pos=[...spotPosRef.current], c=spotCashRef.current, pD=0, tD=0;
      const logs=[];

      for (const action of result.actions) {
        const adef = ASSETS.find(a=>a.symbol===action.symbol);
        if (!adef) continue;
        const cur = live[action.symbol]||adef.base;

        if (action.type==="BUY") {
          if (pos.length>=4||pos.find(p=>p.symbol===action.symbol)) continue;
          const alloc = c*0.06; if (alloc<10) continue;
          if (mode==="live") {
            try { await placeSpotOrder(ak,as_,action.symbol,"BUY",alloc); }
            catch(e){ logs.push({t:ts(),msg:`❌ Spot BUY failed: ${e.message}`,type:"err"}); continue; }
          }
          c -= alloc;
          pos.push({symbol:action.symbol, display:adef.display, qty:alloc/cur, entry:cur,
            sl:+(cur*0.975).toFixed(2), tp:+(cur*1.045).toFixed(2)});
          logs.push({t:ts(), msg:`${mode==="live"?"🟢 REAL":"📄"} BUY ${adef.display} @ $${dp(cur,adef.base)} — ${action.reason}`, type:"buy"});
          tD++;
        } else if (action.type==="SELL") {
          const idx=pos.findIndex(p=>p.symbol===action.symbol); if(idx===-1) continue;
          const p=pos[idx]; const cur2=live[p.symbol]||p.entry;
          const gain=p.qty*(cur2-p.entry);
          if (mode==="live") {
            try { await placeSpotOrder(ak,as_,action.symbol,"SELL",p.qty*cur2); }
            catch(e){ logs.push({t:ts(),msg:`❌ Spot SELL failed: ${e.message}`,type:"err"}); continue; }
          }
          pD+=gain; c+=p.qty*cur2; pos.splice(idx,1);
          logs.push({t:ts(), msg:`${mode==="live"?"🔴 REAL":"📄"} SELL ${p.display} | ${gain>=0?"+":""}$${Math.abs(gain).toFixed(2)} — ${action.reason}`, type:gain>=0?"win":"loss"});
          tD++;
        }
      }

      // SL/TP sweep
      [...pos].forEach(p=>{
        const cur=live[p.symbol]||p.entry;
        if(cur<=p.sl||cur>=p.tp){
          const gain=p.qty*(cur-p.entry);
          pD+=gain; c+=p.qty*cur; pos=pos.filter(x=>x.symbol!==p.symbol);
          logs.push({t:ts(),msg:`${cur<=p.sl?"SL🛑":"TP✅"} ${p.display} $${cur.toFixed(2)} | ${gain>=0?"+":""}$${Math.abs(gain).toFixed(2)}`,type:gain>=0?"win":"loss"});
          tD++;
        }
      });

      spotPosRef.current=pos; spotCashRef.current=c;
      spotPnlRef.current+=pD; spotTcRef.current+=tD;
      setSpotPos(pos); setSpotCash(c); setSpotPnl(spotPnlRef.current); setSpotTrades(spotTcRef.current);
      if(logs.length) setSpotLog(l=>[...logs,...l].slice(0,60));
      if(mode==="live"){ const b=await getSpotBalance(ak,as_); setSpotBal(b); }
    } catch(e){ setSpotNote(`⚠ ${e.message}`); }
    spotBusy.current=false;
  };

  useEffect(()=>{
    if(spotRun){spotCycle(); spotTimer.current=setInterval(spotCycle,15000);}
    else clearInterval(spotTimer.current);
    return()=>clearInterval(spotTimer.current);
  },[spotRun,mode]);

  // ── FUTURES CYCLE ────────────────────────────────────────────────────────
  const futCycle = async () => {
    if (futBusy.current) return;
    futBusy.current = true;
    const {apiKey:ak, apiSecret:as_} = keyRef.current;
    try {
      const live = await getLivePrices();
      setPrices(live);
      const result = futuresEngine(live, futPosRef.current, futCashRef.current, leverage);
      // Apply trailing stop updates to positions
      if (result.updatedPositions) {
        futPosRef.current = result.updatedPositions;
        setFutPos(result.updatedPositions);
      }
      setFutNote(result.commentary);
      let pos=[...futPosRef.current], c=futCashRef.current, pD=0, tD=0;
      const logs=[];

      for (const action of result.actions) {
        const adef = ASSETS.find(a=>a.symbol===action.symbol);
        if (!adef) continue;
        const cur = live[action.symbol]||adef.base;

        if (action.type==="OPEN") {
          if (pos.length>=4||pos.find(p=>p.symbol===action.symbol)) continue;
          const alloc=c*0.05; if(alloc<10) continue;
          const qty=(alloc*leverage)/cur;
          if (mode==="live") {
            try { await placeFuturesOrder(ak,as_,action.symbol, action.side==="LONG"?"BUY":"SELL", qty, leverage); }
            catch(e){ logs.push({t:ts(),msg:`❌ Fut OPEN failed: ${e.message}`,type:"err"}); continue; }
          }
          c -= alloc;
          const isLong = action.side==="LONG";
          pos.push({
            symbol:action.symbol, display:adef.display, side:action.side,
            qty, notional:qty*cur, entry:cur, margin:alloc, leverage,
            sl: isLong ? +(cur*(1-0.02/leverage)).toFixed(2) : +(cur*(1+0.02/leverage)).toFixed(2),
            tp: isLong ? +(cur*(1+0.04/leverage)).toFixed(2) : +(cur*(1-0.04/leverage)).toFixed(2),
          });
          const sideIcon = action.side==="LONG"?"🟢 LONG":"🔴 SHORT";
          logs.push({t:ts(),msg:`${mode==="live"?"💹 REAL":"📄"} ${sideIcon} ${adef.display} x${leverage} @ $${dp(cur,adef.base)} — ${action.reason}`,type:action.side==="LONG"?"long":"short"});
          tD++;
        } else if (action.type==="CLOSE") {
          const idx=pos.findIndex(p=>p.symbol===action.symbol&&p.side===action.side);
          if(idx===-1) continue;
          const p=pos[idx]; const cur2=live[p.symbol]||p.entry;
          const rawPct = p.side==="LONG" ? (cur2-p.entry)/p.entry : (p.entry-cur2)/p.entry;
          const gain = p.margin * rawPct * leverage;
          if (mode==="live") {
            try { await closeFuturesPosition(ak,as_,action.symbol,action.side,p.qty); }
            catch(e){ logs.push({t:ts(),msg:`❌ Close failed: ${e.message}`,type:"err"}); continue; }
          }
          pD+=gain; c+=p.margin+gain; pos.splice(idx,1);
          logs.push({t:ts(),msg:`${mode==="live"?"💹":"📄"} CLOSE ${p.side} ${p.display} @ $${dp(cur2,adef.base)} | ${gain>=0?"+":""}$${Math.abs(gain).toFixed(2)} — ${action.reason}`,type:gain>=0?"win":"loss"});
          tD++;
        }
      }

      // Auto SL/TP sweep for futures
      [...pos].forEach(p=>{
        const cur=live[p.symbol]||p.entry;
        const rawPct = p.side==="LONG"?(cur-p.entry)/p.entry:(p.entry-cur)/p.entry;
        const hitSL = p.side==="LONG"?cur<=p.sl:cur>=p.sl;
        const hitTP = p.side==="LONG"?cur>=p.tp:cur<=p.tp;
        if(hitSL||hitTP){
          const gain = p.margin * rawPct * p.leverage;
          pD+=gain; c+=p.margin+gain; pos=pos.filter(x=>!(x.symbol===p.symbol&&x.side===p.side));
          logs.push({t:ts(),msg:`${hitSL?"SL🛑":"TP✅"} ${p.side} ${p.display} @ $${dp(cur,ASSETS.find(a=>a.symbol===p.symbol)?.base||1)} | ${gain>=0?"+":""}$${Math.abs(gain).toFixed(2)}`,type:gain>=0?"win":"loss"});
          tD++;
        }
      });

      futPosRef.current=pos; futCashRef.current=c;
      futPnlRef.current+=pD; futTcRef.current+=tD;
      setFutPos(pos); setFutCash(c); setFutPnl(futPnlRef.current); setFutTrades(futTcRef.current);
      if(logs.length) setFutLog(l=>[...logs,...l].slice(0,60));
      if(mode==="live"){ const b=await getFuturesBalance(ak,as_); setFutBal(b); }
    } catch(e){ setFutNote(`⚠ ${e.message}`); }
    futBusy.current=false;
  };

  useEffect(()=>{
    if(futRun){futCycle(); futTimer.current=setInterval(futCycle,8000);}
    else clearInterval(futTimer.current);
    return()=>clearInterval(futTimer.current);
  },[futRun,mode]);

  const C = "#f0b90b";
  const LC = {buy:"#38d98a",long:"#38d98a",short:"#f97070",win:"#38d98a",loss:"#f97070",err:"#fb923c"};

  // ── SETUP SCREEN ──────────────────────────────────────────────────────────
  if (screen==="setup") return (
    <div style={{fontFamily:"'IBM Plex Mono','Fira Code',monospace",background:"#040b16",color:"#c0d0e0",minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:440}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{fontSize:36,marginBottom:8}}>🦍</div>
          <div style={{fontSize:22,fontWeight:900,letterSpacing:3,background:"linear-gradient(90deg,#f0b90b,#e0803c)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>BOMBA LIVE</div>
          <div style={{fontSize:10,color:"#3a5060",letterSpacing:3,marginTop:4}}>SPOT + FUTURES TRADING BOT</div>
        </div>
        <div style={{background:"#0a1828",border:"1px solid #1a3040",borderRadius:12,padding:24,marginBottom:16}}>
          <div style={{fontSize:11,color:"#3a5868",marginBottom:16,lineHeight:1.7}}>🔐 Keys go directly to Binance only. Never stored or shared.</div>
          {[["BINANCE API KEY","text",apiKey,setApiKey,"Paste API key"],["BINANCE SECRET KEY","password",apiSecret,setApiSecret,"Paste Secret key"]].map(([lbl,type,val,set,ph])=>(
            <div key={lbl} style={{marginBottom:16}}>
              <div style={{fontSize:9,color:"#3a5060",letterSpacing:1.5,marginBottom:6}}>{lbl}</div>
              <input type={type} value={val} onChange={e=>set(e.target.value)} placeholder={ph}
                style={{width:"100%",background:"#06101c",border:"1px solid #1a3040",borderRadius:6,padding:"10px 12px",color:"#c0d0e0",fontFamily:"inherit",fontSize:11,outline:"none"}}/>
            </div>
          ))}
          <button onClick={testConnection} disabled={testing||!apiKey||!apiSecret}
            style={{width:"100%",padding:"12px",borderRadius:8,border:"none",background:(!apiKey||!apiSecret)?"#1a2a3a":"linear-gradient(90deg,#f0b90b,#e0803c)",color:(!apiKey||!apiSecret)?"#3a5060":"#040b16",fontFamily:"inherit",fontSize:13,fontWeight:800,letterSpacing:2,cursor:(!apiKey||!apiSecret)?"not-allowed":"pointer"}}>
            {testing?"Connecting…":"▶ CONNECT TO BINANCE"}
          </button>
          {testResult&&<div style={{marginTop:14,padding:"10px 12px",borderRadius:6,background:testResult.includes("✅")?"#002a14":"#2a0808",border:`1px solid ${testResult.includes("✅")?"#38d98a30":"#f9707030"}`,fontSize:11,color:testResult.includes("✅")?"#38d98a":"#f97070"}}>{testResult}</div>}
        </div>
        <div style={{fontSize:9,color:"#1c2e3e",textAlign:"center",lineHeight:1.8}}>
          Spot trading uses your USDT balance<br/>Futures trading uses your Futures wallet<br/>Start in PAPER mode — safe to test
        </div>
      </div>
    </div>
  );

  // ── LIVE SCREEN ───────────────────────────────────────────────────────────
  const isSpot = tab==="spot";
  const pos       = isSpot ? spotPos    : futPos;
  const cash      = isSpot ? spotCash   : futCash;
  const pnl       = isSpot ? spotPnl    : futPnl;
  const bal       = isSpot ? spotBal    : futBal;
  const log       = isSpot ? spotLog    : futLog;
  const note      = isSpot ? spotNote   : futNote;
  const running   = isSpot ? spotRun    : futRun;
  const setRun    = isSpot ? setSpotRun : setFutRun;
  const trades    = isSpot ? spotTrades : futTrades;
  const equity    = cash + pos.reduce((s,p)=>{
    const cur=prices[p.symbol]||p.entry;
    if(isSpot) return s + p.qty*cur;
    const rawPct = p.side==="LONG"?(cur-p.entry)/p.entry:(p.entry-cur)/p.entry;
    return s + p.margin + p.margin*rawPct*p.leverage;
  },0);
  const ret       = bal>0?(((equity-bal)/bal)*100).toFixed(2):"0.00";
  const up        = parseFloat(ret)>=0;

  return (
    <div style={{fontFamily:"'IBM Plex Mono','Fira Code',monospace",background:"#040b16",color:"#c0d0e0",height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;700;800&display=swap');@keyframes pulse{0%,100%{opacity:1}50%{opacity:.15}}*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#1a2e42;border-radius:2px}button:hover{filter:brightness(1.15)}`}</style>

      {/* ── Top Bar ── */}
      <div style={{background:"linear-gradient(90deg,#050f1e,#081424)",borderBottom:"1px solid #121f2e",padding:"8px 16px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <div style={{fontSize:18}}>🦍</div>
        <div>
          <div style={{fontSize:14,fontWeight:900,letterSpacing:2,background:"linear-gradient(90deg,#f0b90b,#e0803c)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>BOMBA LIVE</div>
          <div style={{fontSize:7,color:"#243040",letterSpacing:2}}>BINANCE BOT</div>
        </div>

        {/* Tab switcher */}
        <div style={{display:"flex",marginLeft:8,borderRadius:6,overflow:"hidden",border:"1px solid #1a3040"}}>
          {[["spot","📦 SPOT"],["futures","📈 FUTURES"]].map(([t,lbl])=>(
            <button key={t} onClick={()=>setTab(t)} style={{padding:"5px 12px",background:tab===t?"#0c1e30":"transparent",color:tab===t?C:"#2a4050",border:"none",fontFamily:"inherit",fontSize:10,fontWeight:tab===t?700:400,cursor:"pointer",letterSpacing:1}}>{lbl}</button>
          ))}
        </div>

        <div style={{flex:1}}/>

        {/* Stats */}
        {[
          ["WALLET",  `$${bal.toFixed(2)}`,           "#7ab3ff"],
          ["EQUITY",  fmt(equity),                     up?"#38d98a":"#f97070"],
          ["P&L",     `${pnl>=0?"+":""}${fmt(pnl)}`,  pnl>=0?"#38d98a":"#f97070"],
          ["TRADES",  trades,                          C],
        ].map(([l,v,c])=>(
          <div key={l} style={{textAlign:"right",marginLeft:10}}>
            <div style={{fontSize:7,color:"#243040",letterSpacing:1}}>{l}</div>
            <div style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
          </div>
        ))}

        {/* Leverage (futures only) */}
        {!isSpot && (
          <div style={{marginLeft:10,textAlign:"center"}}>
            <div style={{fontSize:7,color:"#243040",letterSpacing:1}}>LEVERAGE</div>
            <select value={leverage} onChange={e=>setLeverage(+e.target.value)}
              style={{background:"#0c1e30",border:"1px solid #f0b90b44",color:C,fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:4,padding:"2px 6px",cursor:"pointer"}}>
              {[1,2,3,5,10,20].map(l=><option key={l} value={l}>{l}x</option>)}
            </select>
          </div>
        )}

        {/* Mode toggle */}
        <div style={{marginLeft:10,display:"flex",borderRadius:6,overflow:"hidden",border:"1px solid #1a3040"}}>
          {["paper","live"].map(m=>(
            <button key={m} onClick={()=>{
              if(m==="live"&&!window.confirm("⚠️ LIVE MODE: Real money will be traded on Binance. Continue?")) return;
              setMode(m);
            }} style={{padding:"4px 9px",background:mode===m?(m==="live"?"#3a0808":"#0c1e30"):"transparent",color:mode===m?(m==="live"?"#f97070":"#7ab3ff"):"#2a4050",border:"none",fontFamily:"inherit",fontSize:9,fontWeight:700,cursor:"pointer",letterSpacing:1}}>
              {m==="live"?"🔴 LIVE":"📄 PAPER"}
            </button>
          ))}
        </div>

        <button onClick={()=>setRun(r=>!r)} style={{marginLeft:8,padding:"6px 14px",borderRadius:6,border:`1px solid ${running?"#f9707044":C+"44"}`,background:running?"#1c0808":`${C}14`,color:running?"#f97070":C,fontFamily:"inherit",fontSize:11,fontWeight:700,letterSpacing:1.5,cursor:"pointer"}}>
          {running?"■ STOP":"▶ RUN"}
        </button>
      </div>

      {/* Live mode warning */}
      {mode==="live"&&<div style={{background:"#2a0808",borderBottom:"1px solid #f9707030",padding:"5px 16px",fontSize:10,color:"#f97070",textAlign:"center"}}>🔴 LIVE MODE ACTIVE — Real orders being placed on your Binance account</div>}

      {/* Futures info bar */}
      {!isSpot&&<div style={{background:"#060e1e",borderBottom:"1px solid #0d1a28",padding:"5px 14px",fontSize:10,color:"#4a7090",display:"flex",gap:16}}>
        <span>Leverage: <b style={{color:C}}>{leverage}x</b></span>
        <span>Longs: <b style={{color:"#38d98a"}}>{futPos.filter(p=>p.side==="LONG").length}</b></span>
        <span>Shorts: <b style={{color:"#f97070"}}>{futPos.filter(p=>p.side==="SHORT").length}</b></span>
        <span style={{color:"#2a4050",fontSize:9,marginLeft:"auto"}}>SL: −2% / TP: +4% (on margin)</span>
      </div>}

      {/* Bot commentary */}
      <div style={{padding:"5px 14px",background:"#050e1a",borderBottom:"1px solid #0d1a28",fontSize:11,color:"#3a5868",display:"flex",alignItems:"center",gap:8,flexShrink:0,minHeight:26}}>
        <span style={{color:C,fontSize:9}}>BOT▸</span>
        <span style={{flex:1}}>{note}</span>
        {running&&<span style={{fontSize:9,color:"#1c3040",display:"flex",alignItems:"center",gap:4}}>
          <span style={{width:5,height:5,borderRadius:"50%",background:"#38d98a",display:"inline-block",animation:"pulse 1.2s infinite"}}/>LIVE
        </span>}
      </div>

      {/* Body */}
      <div style={{flex:1,display:"flex",minHeight:0,overflow:"hidden"}}>
        <div style={{flex:1,overflowY:"auto"}}>

          {/* Positions table */}
          <div style={{padding:"7px 12px 3px",fontSize:8,color:"#243040",letterSpacing:2}}>
            {isSpot?"SPOT POSITIONS":"FUTURES POSITIONS"} ({pos.length}/4)
          </div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead><tr style={{background:"#08131e"}}>
              {(isSpot
                ? ["ASSET","ENTRY","NOW","P/L","%","SL","TP"]
                : ["ASSET","SIDE","ENTRY","NOW","P/L","%","LVG","SL","TP"]
              ).map(h=>(
                <th key={h} style={{padding:"4px 7px",textAlign:h==="ASSET"||h==="SIDE"?"left":"right",color:"#1c2e3e",fontSize:8,fontWeight:400,letterSpacing:1,borderBottom:"1px solid #0d1a28"}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {pos.length===0
                ? <tr><td colSpan={9} style={{padding:"16px 12px",color:"#121e28",fontSize:10,textAlign:"center"}}>No open positions — bot is scanning…</td></tr>
                : pos.map((p,i)=>{
                    const adef=ASSETS.find(a=>a.symbol===p.symbol);
                    const cur=prices[p.symbol]||p.entry;
                    let gain, pct;
                    if(isSpot){
                      gain=p.qty*(cur-p.entry);
                      pct=(((cur-p.entry)/p.entry)*100).toFixed(2);
                    } else {
                      const rawPct=p.side==="LONG"?(cur-p.entry)/p.entry:(p.entry-cur)/p.entry;
                      gain=p.margin*rawPct*p.leverage;
                      pct=(rawPct*p.leverage*100).toFixed(2);
                    }
                    const f=flash[p.symbol];
                    return (
                      <tr key={i} style={{borderBottom:"1px solid #0a1520",background:f==="up"?"#001e10":f==="dn"?"#1e0008":"transparent",transition:"background .3s"}}>
                        <td style={{padding:"5px 7px",color:C,fontWeight:700}}>{p.display}</td>
                        {!isSpot&&<td style={{padding:"5px 7px"}}>
                          <span style={{color:p.side==="LONG"?"#38d98a":"#f97070",fontSize:10,fontWeight:700,background:p.side==="LONG"?"#38d98a18":"#f9707018",padding:"1px 6px",borderRadius:3}}>{p.side==="LONG"?"▲ LONG":"▼ SHORT"}</span>
                        </td>}
                        <td style={{padding:"5px 7px",textAlign:"right",color:"#304858"}}>${dp(p.entry,adef?.base||1)}</td>
                        <td style={{padding:"5px 7px",textAlign:"right",fontWeight:600,color:f==="up"?"#38d98a":f==="dn"?"#f97070":"#a0c0d0"}}>${dp(cur,adef?.base||1)}</td>
                        <td style={{padding:"5px 7px",textAlign:"right",color:gain>=0?"#38d98a":"#f97070"}}>{gain>=0?"+":""}${Math.abs(gain).toFixed(2)}</td>
                        <td style={{padding:"5px 7px",textAlign:"right",color:parseFloat(pct)>=0?"#38d98a":"#f97070"}}>{parseFloat(pct)>=0?"+":""}{pct}%</td>
                        {!isSpot&&<td style={{padding:"5px 7px",textAlign:"right",color:C,fontSize:10}}>{p.leverage}x</td>}
                        <td style={{padding:"5px 7px",textAlign:"right",color:"#f9707050",fontSize:10}}>${dp(p.sl,adef?.base||1)}</td>
                        <td style={{padding:"5px 7px",textAlign:"right",color:"#38d98a50",fontSize:10}}>${dp(p.tp,adef?.base||1)}</td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>

          {/* Scanner */}
          <div style={{padding:"7px 12px 3px",fontSize:8,color:"#243040",letterSpacing:2,marginTop:4}}>LIVE MARKET SCANNER</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead><tr style={{background:"#08131e"}}>
              {["SYM","NAME","PRICE","CHG%","SIGNAL",""].map(h=>(
                <th key={h} style={{padding:"4px 7px",textAlign:h==="SYM"||h==="NAME"?"left":"right",color:"#1c2e3e",fontSize:8,fontWeight:400,letterSpacing:1,borderBottom:"1px solid #0d1a28"}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {ASSETS.map(a=>{
                const cur=prices[a.symbol]||a.base;
                const chg=(((cur-a.base)/a.base)*100).toFixed(2);
                const held=!!pos.find(p=>p.symbol===a.symbol);
                const f=flash[a.symbol];
                const signal=parseFloat(chg)>0.3?"LONG 🟢":parseFloat(chg)<-0.3?"SHORT 🔴":"WAIT ⏸";
                const sigColor=parseFloat(chg)>0.3?"#38d98a":parseFloat(chg)<-0.3?"#f97070":"#3a5060";
                return (
                  <tr key={a.symbol} style={{borderBottom:"1px solid #080f18",background:f==="up"?"#001408":f==="dn"?"#140004":"transparent",transition:"background .4s"}}>
                    <td style={{padding:"4px 7px",color:held?C:"#6090a8",fontWeight:held?700:400}}>{a.display}</td>
                    <td style={{padding:"4px 7px",color:"#243848",fontSize:10}}>{a.name}</td>
                    <td style={{padding:"4px 7px",textAlign:"right",color:f==="up"?"#38d98a":f==="dn"?"#f97070":"#90b0c0",fontWeight:600}}>${dp(cur,a.base)}</td>
                    <td style={{padding:"4px 7px",textAlign:"right",color:parseFloat(chg)>=0?"#38d98a60":"#f9707060",fontSize:10}}>{parseFloat(chg)>=0?"+":""}{chg}%</td>
                    <td style={{padding:"4px 7px",textAlign:"right",color:sigColor,fontSize:9,fontWeight:700}}>
                      {isSpot
                        ? (parseFloat(chg)>0.3?"BUY 🟢":"WATCH")
                        : (() => {
                            const sc = parseFloat(chg);
                            if (sc > 0.3) return "LONG 🟢 HIGH";
                            if (sc > 0.1) return "LONG 🟢 MED";
                            if (sc < -0.3) return "SHORT 🔴 HIGH";
                            if (sc < -0.1) return "SHORT 🔴 MED";
                            return "WAIT ⏸";
                          })()
                      }
                    </td>
                    <td style={{padding:"4px 7px",textAlign:"right"}}>{held&&<span style={{color:C,fontSize:8,background:`${C}18`,padding:"1px 5px",borderRadius:3,fontWeight:700}}>HELD</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Log + Stats */}
        <div style={{width:195,display:"flex",flexDirection:"column",borderLeft:"1px solid #0d1a28",flexShrink:0}}>
          <div style={{padding:"7px 10px 3px",fontSize:8,color:"#243040",letterSpacing:2}}>TRADE LOG</div>
          <div style={{flex:1,overflowY:"auto"}}>
            {log.length===0
              ? <div style={{color:"#121e28",fontSize:10,padding:"14px 10px",textAlign:"center"}}>No trades yet…</div>
              : log.map((e,i)=>(
                  <div key={i} style={{padding:"4px 10px",borderBottom:"1px solid #08121c",opacity:Math.max(0.1,1-i*0.025)}}>
                    <div style={{fontSize:8,color:"#1c2e3e"}}>{e.t}</div>
                    <div style={{fontSize:10,color:LC[e.type]||"#405868",lineHeight:1.4,marginTop:1,wordBreak:"break-word"}}>{e.msg}</div>
                  </div>
                ))
            }
          </div>
          <div style={{padding:"10px",borderTop:"1px solid #0d1a28",background:"#050e1a",flexShrink:0}}>
            <div style={{fontSize:8,color:"#243040",letterSpacing:1,marginBottom:3}}>RETURN</div>
            <div style={{fontSize:14,fontWeight:800,color:up?"#38d98a":"#f97070",marginBottom:5}}>{up?"+":""}{ret}%</div>
            <div style={{height:3,background:"#0d1a28",borderRadius:2,marginBottom:8}}>
              <div style={{height:"100%",borderRadius:2,transition:"width .6s",width:`${Math.min(100,Math.max(2,50+parseFloat(ret)*6))}%`,background:up?"#38d98a":"#f97070"}}/>
            </div>
            <div style={{fontSize:8,color:"#182838",lineHeight:1.9}}>
              Wallet: ${bal.toFixed(2)}<br/>
              {isSpot?"SL: −2.5% / TP: +4.5%":`SL: −2% / TP: +4% on margin`}<br/>
              {!isSpot&&`Leverage: ${leverage}x\n`}
              Max 4 positions<br/>
              Cycle: {isSpot?"15":"8"}s
            </div>
            <button onClick={()=>{setSpotRun(false);setFutRun(false);setScreen("setup");}} style={{marginTop:10,width:"100%",padding:"5px",borderRadius:4,border:"1px solid #1a2e42",background:"transparent",color:"#2a4050",fontFamily:"inherit",fontSize:9,cursor:"pointer"}}>⬅ Change Keys</button>
          </div>
        </div>
      </div>
    </div>
  );
}
