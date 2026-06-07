import { useState, useEffect, useCallback, useRef } from "react";
import { dataGet, dataSet } from "./firebase.js";

const DEBT_TOTAL = 6_000_000;

// ── UTILS ───────────────────────────────────────────────────────
const fmtRp = (n) => { n = Math.round(n || 0); if (n >= 1_000_000) return "Rp " + (n/1_000_000).toFixed(n%1_000_000===0?0:1) + " Jt"; if (n >= 1_000) return "Rp " + n.toLocaleString("id-ID"); return "Rp " + n; };
const fmtRpFull = (n) => "Rp " + Math.round(n || 0).toLocaleString("id-ID");
const fmtDate = (iso) => { if (!iso) return "-"; const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : "")); return d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }); };
const dateOnly = (s) => (s || "").substring(0, 10);
const monthKey = (s) => (s || "").substring(0, 7);
const monthLabel = (k) => { if (!k) return ""; const [y, m] = k.split("-"); return ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][+m - 1] + " " + y; };
const parseNum = (v) => parseFloat((v || "0").toString().replace(/\./g, "").replace(/,/g, ".")) || 0;

// ── PARSE SHOPEE PAYOUT PASTE ───────────────────────────────────
function parsePayoutPaste(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fullText = lines.join(" ");
  const results = [];
  const statusList = ["Menunggu Dibayar", "Dibayarkan", "Ditahan", "Gagal"];

  // FORMAT DETAIL: ada "Total Komisi yang Dibayarkan"
  const totalM = fullText.match(/Total Komisi yang Dibayarkan[:\s]+Rp([\d.,]+)/i);
  if (totalM) {
    const komisi = parseFloat(totalM[1].replace(/\./g, "")) || 0;
    const pajakM = fullText.match(/Total Potongan Pajak[:\s]+-?Rp([\d.,]+)/i);
    const sebelumM = fullText.match(/Total Komisi Sebelum Pajak[:\s]+Rp([\d.,]+)/i);
    const lapIdM = fullText.match(/ID Laporan Pembayaran[:\s]+(\d{10,})/i);
    const waktuBayarM = fullText.match(/Waktu Pembayaran[:\s]+(\d{2}-\d{2}-\d{4})/i);
    const terbitM = fullText.match(/Diterbitkan\s+(\d{2}-\d{2})/i) || fullText.match(/Waktu Terbit[^:]*:\s*(\d{2}-\d{2}-\d{4})/i);
    const pajak = pajakM ? parseFloat(pajakM[1].replace(/\./g, "")) : 0;
    const sebelum = sebelumM ? parseFloat(sebelumM[1].replace(/\./g, "")) : 0;
    const breakdown = [];
    const bkRe = /Pesanan Selesai pada (\d{2}-\d{2}-\d{4})\s+Rp([\d.,]+)/g;
    let bkM;
    while ((bkM = bkRe.exec(fullText)) !== null) {
      const [dd,mm,yyyy] = bkM[1].split("-");
      breakdown.push({ date: `${yyyy}-${mm}-${dd}`, amount: parseFloat(bkM[2].replace(/\./g, "")) || 0 });
    }
    let terbitIso = "";
    if (terbitM) { const p = terbitM[1].split("-"); terbitIso = p.length===2 ? `2026-${p[1]}-${p[0]}` : `${p[2]}-${p[1]}-${p[0]}`; }
    let payIso = "";
    if (waktuBayarM) { const [dd,mm,yyyy] = waktuBayarM[1].split("-"); payIso = `${yyyy}-${mm}-${dd}`; }
    if (komisi > 0) results.push({ id: lapIdM?lapIdM[1]:("det-"+Date.now()), terbitDate: terbitIso, payDate: payIso, lapId: lapIdM?lapIdM[1]:"", komisiDibayar: komisi, komisiSebelumPajak: sebelum, potonganPajak: pajak, status: "Dibayarkan", breakdown, cicilan: komisi*0.3, modal: komisi*0.5, hidup: komisi*0.2, source: "paste-detail" });
    return results;
  }

  // FORMAT LIST: tiap baris = satu laporan
  for (const line of lines) {
    const dateM = line.match(/(\d{2}-\d{2}-\d{4})/);
    if (!dateM) continue;
    const rpM = line.match(/Rp([\d.]+)/);
    if (!rpM) continue;
    const [dd,mm,yyyy] = dateM[1].split("-");
    const isoDate = `${yyyy}-${mm}-${dd}`;
    const rpVal = parseFloat(rpM[1].replace(/\./g, "")) || 0;
    const idM = line.match(/\b(\d{15,})\b/);
    const status = statusList.find(s => line.includes(s)) || "Tidak diketahui";
    const allDates = [...line.matchAll(/(\d{2}-\d{2}-\d{4})/g)];
    let payDate = "";
    if (allDates.length >= 2) { const [dd2,mm2,yyyy2] = allDates[1][1].split("-"); payDate = `${yyyy2}-${mm2}-${dd2}`; }
    if (isoDate && rpVal > 0) results.push({ id: idM?idM[1]:(isoDate+"-"+rpVal), terbitDate: isoDate, payDate, lapId: idM?idM[1]:"", komisiDibayar: rpVal, potonganPajak: 0, status, cicilan: rpVal*0.3, modal: rpVal*0.5, hidup: rpVal*0.2, source: "paste-list" });
  }
  return results;
}

// ── CSV PARSER ──────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const vals = []; let cur = "", inQ = false;
    for (const ch of line) { if (ch==='"') inQ=!inQ; else if (ch===','&&!inQ) { vals.push(cur.trim()); cur=""; } else cur+=ch; }
    vals.push(cur.trim());
    const obj = {}; headers.forEach((h,i) => obj[h]=(vals[i]||"").replace(/^"|"$/g,"").trim()); return obj;
  }).filter(r => Object.values(r).some(v=>v));
}

// ── STYLES ──────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#f5f6fa;--surface:#fff;--surface2:#f0f2f8;--border:#e2e6f0;--border2:#cdd3e0;
  --accent:#f97316;--accent-l:#fff4ed;--green:#16a34a;--green-l:#f0fdf4;
  --blue:#2563eb;--blue-l:#eff6ff;--red:#dc2626;--red-l:#fef2f2;
  --yellow:#ca8a04;--yellow-l:#fefce8;--purple:#7c3aed;--purple-l:#f5f3ff;
  --text:#0f172a;--text2:#475569;--text3:#94a3b8;--r:12px;--r-sm:8px;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 4px 12px rgba(0,0,0,.08),0 2px 4px rgba(0,0,0,.04);
}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;}
.app{min-height:100vh;display:flex;flex-direction:column;}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px;position:sticky;top:0;z-index:100;box-shadow:var(--shadow);}
.hdr{display:flex;align-items:center;justify-content:space-between;height:56px;}
.logo{display:flex;align-items:center;gap:10px;}
.logo-mark{width:32px;height:32px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.logo h1{font-size:1rem;font-weight:800;color:var(--text);letter-spacing:-.3px;}
.logo span{font-size:.68rem;color:var(--text3);display:block;font-weight:500;}
.hdr-debt{text-align:right;}
.hdr-debt .lbl{font-size:.68rem;color:var(--text3);font-weight:500;}
.hdr-debt .val{font-size:.95rem;font-weight:800;color:var(--accent);letter-spacing:-.3px;}
nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;display:flex;overflow-x:auto;scrollbar-width:none;}
nav::-webkit-scrollbar{display:none;}
.nb{flex-shrink:0;padding:14px 14px 12px;font-family:inherit;font-size:.78rem;font-weight:600;border:none;background:transparent;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;}
.nb:hover{color:var(--text);}
.nb.active{color:var(--accent);border-bottom-color:var(--accent);}
main{flex:1;padding:20px 16px;max-width:800px;margin:0 auto;width:100%;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:12px;box-shadow:var(--shadow);}
.ct{font-size:.68rem;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text3);margin-bottom:14px;}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
.st{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px;box-shadow:var(--shadow);}
.st .l{font-size:.68rem;color:var(--text3);font-weight:600;margin-bottom:6px;}
.st .v{font-size:1.1rem;font-weight:800;letter-spacing:-.3px;line-height:1;}
.st .s{font-size:.68rem;color:var(--text3);margin-top:5px;font-weight:500;}
.v.green{color:var(--green);}.v.orange{color:var(--accent);}.v.blue{color:var(--blue);}.v.red{color:var(--red);}.v.yellow{color:var(--yellow);}.v.purple{color:var(--purple);}
.pw{margin-bottom:4px;}
.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.pl{font-size:.78rem;color:var(--text2);font-weight:600;}
.pp{font-size:.85rem;font-weight:800;color:var(--accent);}
.pt{height:8px;background:var(--surface2);border-radius:99px;overflow:hidden;}
.pf{height:100%;background:linear-gradient(90deg,var(--accent),#fbbf24);border-radius:99px;transition:width .7s cubic-bezier(.4,0,.2,1);}
.pn{display:flex;justify-content:space-between;margin-top:8px;font-size:.7rem;color:var(--text3);font-weight:500;}
.pn strong{color:var(--text2);}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:.65rem;font-weight:700;letter-spacing:.3px;}
.bg-green{background:var(--green-l);color:var(--green);}
.bg-yellow{background:var(--yellow-l);color:var(--yellow);}
.bg-red{background:var(--red-l);color:var(--red);}
.bg-blue{background:var(--blue-l);color:var(--blue);}
.bg-orange{background:var(--accent-l);color:var(--accent);}
.bg-gray{background:var(--surface2);color:var(--text3);}
.bg-purple{background:var(--purple-l);color:var(--purple);}
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:.68rem;font-weight:600;}
.pill-fb{background:#eff6ff;color:#2563eb;}.pill-ig{background:#fdf4ff;color:#9333ea;}.pill-oth{background:var(--surface2);color:var(--text3);}
.fg{margin-bottom:12px;}
.fg label{display:block;font-size:.75rem;font-weight:600;color:var(--text2);margin-bottom:5px;}
.fg input,.fg select,.fg textarea{width:100%;padding:10px 12px;background:var(--surface);border:1px solid var(--border2);border-radius:var(--r-sm);color:var(--text);font-family:inherit;font-size:.875rem;outline:none;transition:border-color .15s,box-shadow .15s;}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(249,115,22,.12);}
.fg textarea{resize:vertical;min-height:70px;}
.r2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.btn{width:100%;padding:11px;border-radius:var(--r-sm);border:none;font-family:inherit;font-size:.875rem;font-weight:700;cursor:pointer;transition:all .15s;}
.btn-p{background:var(--accent);color:#fff;}
.btn-p:hover{background:#ea6c10;transform:translateY(-1px);box-shadow:0 4px 12px rgba(249,115,22,.3);}
.btn-d{background:transparent;color:var(--red);border:1px solid #fca5a5;padding:5px 10px;width:auto;font-size:.72rem;border-radius:6px;}
.btn-d:hover{background:var(--red-l);}
.uz{border:2px dashed var(--border2);border-radius:var(--r);padding:24px 16px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:10px;}
.uz:hover,.uz.drag{border-color:var(--accent);background:var(--accent-l);}
.uz .ui{font-size:2rem;margin-bottom:8px;}
.uz .ut{font-size:.9rem;font-weight:700;color:var(--text);margin-bottom:3px;}
.uz .us{font-size:.73rem;color:var(--text3);font-weight:500;}
.ustat{background:var(--surface2);border-radius:var(--r-sm);padding:12px 14px;border:1px solid var(--border);font-size:.78rem;margin-top:8px;}
.ur{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:.75rem;}
.ur:last-child{border-bottom:none;}
.table-wrap{overflow-x:auto;}
table.dt{width:100%;border-collapse:collapse;font-size:.76rem;}
table.dt th{text-align:left;padding:8px 10px;color:var(--text3);font-weight:700;border-bottom:1px solid var(--border);font-size:.65rem;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;background:var(--surface2);}
table.dt td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle;}
table.dt tr:last-child td{border-bottom:none;}
table.dt tr:hover td{background:var(--surface2);}
table.dt .num{text-align:right;font-family:'DM Mono',monospace;font-weight:600;font-size:.73rem;}
.tx-item{background:var(--surface2);border-radius:var(--r-sm);padding:13px;border-left:3px solid var(--accent);margin-bottom:8px;}
.tx-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;}
.tx-date{font-size:.9rem;font-weight:800;color:var(--text);}
.tx-type{font-size:.68rem;color:var(--accent);font-weight:600;margin-top:2px;}
.tx-amt{font-size:1rem;font-weight:800;color:var(--green);font-family:'DM Mono',monospace;}
.tx-allocs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;}
.tx-alloc{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 8px;text-align:center;}
.al{font-size:.6rem;color:var(--text3);font-weight:600;margin-bottom:2px;}
.av{font-size:.76rem;font-weight:700;font-family:'DM Mono',monospace;}
.day-hdr{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
.day-lbl{font-size:.78rem;font-weight:800;color:var(--text);}
.day-line{flex:1;height:1px;background:var(--border);}
.day-cnt{font-size:.68rem;color:var(--text3);font-weight:500;}
.month-sel{display:flex;gap:6px;flex-wrap:wrap;}
.mb{padding:6px 12px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:var(--text3);font-family:inherit;font-size:.76rem;font-weight:600;cursor:pointer;transition:all .15s;}
.mb.active{background:var(--accent);color:#fff;border-color:var(--accent);}
.mb:hover:not(.active){border-color:var(--accent);color:var(--accent);}
.dp-item{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--border);}
.dp-item:last-child{border-bottom:none;}
.dp-date{font-size:.7rem;color:var(--text3);font-weight:500;}
.dp-src{font-size:.8rem;color:var(--text2);font-weight:600;margin-top:1px;}
.dp-amt{font-size:.88rem;font-weight:800;color:var(--green);font-family:'DM Mono',monospace;}
.empty{text-align:center;padding:36px 20px;color:var(--text3);}
.empty .icon{font-size:2rem;margin-bottom:8px;}
.empty p{font-size:.82rem;font-weight:500;line-height:1.6;}
.bar-chart{display:flex;flex-direction:column;gap:8px;}
.bar-row{display:flex;align-items:center;gap:10px;}
.bar-lbl{font-size:.72rem;font-weight:600;color:var(--text2);width:80px;flex-shrink:0;text-align:right;}
.bar-track{flex:1;height:24px;background:var(--surface2);border-radius:6px;overflow:hidden;}
.bar-fill{height:100%;border-radius:6px;transition:width .6s cubic-bezier(.4,0,.2,1);display:flex;align-items:center;padding:0 8px;}
.bar-val{font-size:.68rem;font-weight:700;color:#fff;white-space:nowrap;font-family:'DM Mono',monospace;}
.filter-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-bar select{padding:7px 10px;background:var(--surface);border:1px solid var(--border2);border-radius:var(--r-sm);color:var(--text);font-family:inherit;font-size:.76rem;font-weight:600;outline:none;}
.filter-bar select:focus{border-color:var(--accent);}
.roas-hi{background:linear-gradient(135deg,var(--accent-l),#fff);border:1px solid #fed7aa;border-radius:var(--r);padding:14px;text-align:center;margin-bottom:12px;}
.roas-v{font-size:2rem;font-weight:800;color:var(--accent);letter-spacing:-1px;font-family:'DM Mono',monospace;}
.roas-l{font-size:.72rem;color:var(--text3);font-weight:600;margin-top:4px;}
.sum-table{width:100%;border-collapse:collapse;}
.sum-table th{text-align:left;padding:7px 0;color:var(--text3);font-weight:600;border-bottom:1px solid var(--border);font-size:.68rem;text-transform:uppercase;letter-spacing:.5px;}
.sum-table td{padding:9px 0;border-bottom:1px solid var(--border);font-size:.82rem;}
.sum-table tr:last-child td{border-bottom:none;}
.sum-table .num{font-family:'DM Mono',monospace;font-weight:700;text-align:right;}
.toast-wrap{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;}
.toast{background:var(--text);color:#fff;padding:10px 20px;border-radius:99px;font-size:.8rem;font-weight:700;box-shadow:var(--shadow-md);transition:all .3s;opacity:0;transform:translateY(10px);}
.toast.show{opacity:1;transform:translateY(0);}
.toast.success{background:var(--green);}.toast.warn{background:var(--yellow);color:var(--text);}.toast.err{background:var(--red);}
.fb-banner{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px 14px;margin-bottom:12px;font-size:.78rem;color:var(--text2);}
.fb-banner.connected{background:var(--green-l);border-color:#86efac;color:var(--green);}
.fb-banner.error{background:var(--red-l);border-color:#fca5a5;color:var(--red);}
code{background:var(--surface2);padding:1px 6px;border-radius:4px;font-family:'DM Mono',monospace;font-size:.78rem;color:var(--accent);}
@media(max-width:480px){.r2{grid-template-columns:1fr;}.sg{grid-template-columns:1fr 1fr;}}
`;

// ── COMPONENTS ──────────────────────────────────────────────────
const SBadge = ({ s }) => {
  const m = { Selesai:"green", Tertunda:"yellow", Dibatalkan:"red", "Belum Dibayar":"blue", Dibayarkan:"green", "Menunggu Dibayar":"yellow" };
  return <span className={`badge bg-${m[s]||"gray"}`}>{s}</span>;
};
const Pill = ({ p }) => {
  const m = { Facebook:"fb", Instagram:"ig" };
  return <span className={`pill pill-${m[p]||"oth"}`}>{p}</span>;
};
const BarChart = ({ rows, color="#f97316" }) => {
  const max = Math.max(...rows.map(r=>r.val), 1);
  return <div className="bar-chart">{rows.map((r,i)=><div className="bar-row" key={i}><div className="bar-lbl">{r.label}</div><div className="bar-track"><div className="bar-fill" style={{width:`${(r.val/max)*100}%`,background:color}}><span className="bar-val">{r.display}</span></div></div></div>)}</div>;
};
const UploadZone = ({ icon, title, sub, onFile, status }) => {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return <div>
    <div className={`uz ${drag?"drag":""}`} onClick={()=>ref.current.click()} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)onFile(f);}}>
      <input type="file" accept=".csv" ref={ref} style={{display:"none"}} onChange={e=>{if(e.target.files[0])onFile(e.target.files[0]);e.target.value="";}}/>
      <div className="ui">{icon}</div><div className="ut">{title}</div><div className="us">{sub}</div>
    </div>
    {status && <div className="ustat" dangerouslySetInnerHTML={{__html:status}}/>}
  </div>;
};
const AllocBox = ({ label, amount, color }) => (
  <div className="tx-alloc"><div className="al">{label}</div><div className="av" style={{color}}>{fmtRp(amount)}</div></div>
);

// ── APP ─────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState([]);

  const [metaData, setMetaData] = useState([]);
  const [pesananData, setPesananData] = useState([]);
  const [clicksData, setClicksData] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [extraDebt, setExtraDebt] = useState([]);

  const [usMeta, setUsMeta] = useState("");
  const [usPesanan, setUsPesanan] = useState("");
  const [usClicks, setUsClicks] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteResult, setPasteResult] = useState(null);
  const [extraAmt, setExtraAmt] = useState("");
  const [extraNote, setExtraNote] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fPlatform, setFPlatform] = useState("");
  const [fTag, setFTag] = useState("");
  const [fDay, setFDay] = useState("");

  const showToast = useCallback((msg, type="success") => {
    const id = Date.now();
    setToasts(t=>[...t,{id,msg,type}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)), 3000);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [m, p, c, po, ed] = await Promise.all([
        dataGet("meta"), dataGet("pesanan"), dataGet("clicks"),
        dataGet("payouts"), dataGet("extraDebt")
      ]);
      setMetaData(m); setPesananData(p); setClicksData(c);
      setPayouts(po); setExtraDebt(ed);
      setLoading(false);
    })();
  }, []);

  // ── COMPUTED ─────────────────────────────────────────────────
  const payoutsPaid = payouts.filter(p => p.status === "Dibayarkan");
  const totalDibayarkan = payoutsPaid.reduce((s,p)=>s+p.komisiDibayar, 0);
  const debtPaid = payoutsPaid.reduce((s,p)=>s+p.cicilan, 0) + extraDebt.reduce((s,e)=>s+e.amount, 0);
  const debtLeft = Math.max(0, DEBT_TOTAL - debtPaid);
  const debtPct = Math.min(100, (debtPaid/DEBT_TOTAL)*100).toFixed(1);
  const totalSpend = metaData.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]), 0);
  const komisiKotor = pesananData.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]), 0);
  const komisiSelesai = pesananData.filter(r=>r["Status Pesanan"]==="Selesai").reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]), 0);
  const roas = totalSpend > 0 ? (komisiKotor/totalSpend).toFixed(2) : null;

  const allDays = [...new Set([
    ...metaData.map(r=>dateOnly(r["Awal pelaporan"])),
    ...pesananData.map(r=>dateOnly(r["Waktu Pemesanan"])),
    ...clicksData.map(r=>dateOnly(r["Waktu Klik"])),
  ].filter(Boolean))].sort().reverse();
  const allMonths = [...new Set([...allDays.map(d=>d.substring(0,7)), ...payouts.map(p=>monthKey(p.terbitDate))].filter(Boolean))].sort().reverse();
  const allTags = [...new Set(pesananData.map(r=>r["Tag_link1"]).filter(Boolean))];

  const metaByDay = {}; metaData.forEach(r=>{ const d=dateOnly(r["Awal pelaporan"]);if(!d)return;if(!metaByDay[d])metaByDay[d]={spend:0,clicks:0};metaByDay[d].spend+=parseNum(r["Jumlah yang dibelanjakan (IDR)"]);metaByDay[d].clicks+=parseNum(r["Klik tautan"]);});
  const clicksByDay = {}; clicksData.forEach(r=>{ const d=dateOnly(r["Waktu Klik"]);if(!d)return;clicksByDay[d]=(clicksByDay[d]||0)+1;});
  const pesananByDay = {}; pesananData.forEach(r=>{ const d=dateOnly(r["Waktu Pemesanan"]);if(!d)return;if(!pesananByDay[d])pesananByDay[d]={komisi:0,count:0};pesananByDay[d].komisi+=parseNum(r["Komisi Bersih Affiliate (Rp)"]);pesananByDay[d].count++;});
  const byPlatform = {}; pesananData.forEach(r=>{ const p=r["Platform"]||"Others";if(!byPlatform[p])byPlatform[p]={count:0,komisi:0};byPlatform[p].count++;byPlatform[p].komisi+=parseNum(r["Komisi Bersih Affiliate (Rp)"]);});

  const activeMonth = selectedMonth || allMonths[0] || "";
  const metaMonth = metaData.filter(r=>monthKey(r["Awal pelaporan"])===activeMonth);
  const pesananMonth = pesananData.filter(r=>monthKey(dateOnly(r["Waktu Pemesanan"]))===activeMonth);
  const clicksMonth = clicksData.filter(r=>monthKey(dateOnly(r["Waktu Klik"]))===activeMonth);
  const payoutsMonth = payouts.filter(p=>monthKey(p.terbitDate)===activeMonth);
  const mSpend = metaMonth.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
  const mKotor = pesananMonth.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
  const mSelesai = pesananMonth.filter(r=>r["Status Pesanan"]==="Selesai").reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
  const mRoas = mSpend > 0 ? (mKotor/mSpend).toFixed(2) : null;

  const filteredPesanan = pesananData.filter(r=>{
    if(fStatus&&r["Status Pesanan"]!==fStatus)return false;
    if(fPlatform&&r["Platform"]!==fPlatform)return false;
    if(fTag&&r["Tag_link1"]!==fTag)return false;
    if(fDay&&dateOnly(r["Waktu Pemesanan"])!==fDay)return false;
    return true;
  });

  // ── CSV HANDLERS ─────────────────────────────────────────────
  const handleMeta = async (file) => {
    setUsMeta(`<div style="font-weight:700">⏳ Membaca ${file.name}...</div>`);
    const rows = parseCSV(await file.text());
    const existing = new Set(metaData.map(r=>r["Awal pelaporan"]+"|"+r["Nama kampanye"]));
    let added = 0;
    const news = rows.filter(r=>{ const k=r["Awal pelaporan"]+"|"+r["Nama kampanye"];if(!existing.has(k)){added++;return true;}return false;});
    const next = [...metaData,...news];
    setMetaData(next); await dataSet("meta", next);
    const spend = next.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
    const days = [...new Set(next.map(r=>dateOnly(r["Awal pelaporan"])).filter(Boolean))];
    setUsMeta(`<div style="font-weight:700;color:var(--green)">✅ ${file.name}</div><div class="ur"><span>Baris baru</span><span><strong>${added}</strong></span></div><div class="ur"><span>Total data</span><span><strong>${next.length} baris</strong></span></div><div class="ur"><span>Periode</span><span><strong>${days.length} hari</strong></span></div><div class="ur"><span>Total Spend</span><span><strong>${fmtRpFull(spend)}</strong></span></div>`);
    showToast("✅ Data Meta Ads diupload!");
  };
  const handlePesanan = async (file) => {
    setUsPesanan(`<div style="font-weight:700">⏳ Membaca ${file.name}...</div>`);
    const rows = parseCSV(await file.text());
    const existing = new Set(pesananData.map(r=>r["ID Pemesanan"]+"|"+r["ID Barang"]));
    let added = 0;
    const news = rows.filter(r=>{ const k=r["ID Pemesanan"]+"|"+r["ID Barang"];if(!existing.has(k)){added++;return true;}return false;});
    const next = [...pesananData,...news];
    setPesananData(next); await dataSet("pesanan", next);
    const komisi = next.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
    const days = [...new Set(next.map(r=>dateOnly(r["Waktu Pemesanan"])).filter(Boolean))];
    setUsPesanan(`<div style="font-weight:700;color:var(--green)">✅ ${file.name}</div><div class="ur"><span>Pesanan baru</span><span><strong>${added}</strong></span></div><div class="ur"><span>Total tersimpan</span><span><strong>${next.length}</strong></span></div><div class="ur"><span>Periode</span><span><strong>${days.length} hari</strong></span></div><div class="ur"><span>Komisi Kotor</span><span><strong>${fmtRpFull(komisi)}</strong></span></div>`);
    showToast("✅ Laporan Pesanan diupload!");
  };
  const handleClicks = async (file) => {
    setUsClicks(`<div style="font-weight:700">⏳ Membaca ${file.name}...</div>`);
    const rows = parseCSV(await file.text());
    const existing = new Set(clicksData.map(r=>r["Klik ID"]));
    let added = 0;
    const news = rows.filter(r=>{ if(!existing.has(r["Klik ID"])){added++;return true;}return false;});
    const next = [...clicksData,...news];
    setClicksData(next); await dataSet("clicks", next);
    const byP = next.reduce((acc,r)=>{ const p=r["Perujuk"]||"Others";acc[p]=(acc[p]||0)+1;return acc;},{});
    const platRows = Object.entries(byP).map(([p,c])=>`<div class="ur"><span>${p}</span><span><strong>${c.toLocaleString("id-ID")}</strong></span></div>`).join("");
    setUsClicks(`<div style="font-weight:700;color:var(--green)">✅ ${file.name}</div><div class="ur"><span>Klik baru</span><span><strong>${added}</strong></span></div><div class="ur"><span>Total tersimpan</span><span><strong>${next.length.toLocaleString("id-ID")}</strong></span></div>${platRows}`);
    showToast("✅ Shopee Clicks diupload!");
  };

  // ── PAYOUT PASTE ─────────────────────────────────────────────
  const handlePaste = () => {
    if (!pasteText.trim()) { showToast("Tempelkan data dulu!", "warn"); return; }
    const parsed = parsePayoutPaste(pasteText);
    if (!parsed.length) { showToast("Data tidak terbaca. Coba copy ulang.", "err"); return; }
    setPasteResult(parsed);
    showToast(`✅ Terbaca ${parsed.length} laporan pembayaran!`);
  };
  const confirmPaste = async () => {
    if (!pasteResult?.length) return;
    const existing = new Set(payouts.map(p=>p.id));
    const news = pasteResult.filter(p=>!existing.has(p.id));
    if (!news.length) { showToast("Semua sudah tersimpan.", "warn"); return; }
    const next = [...news,...payouts].sort((a,b)=>b.terbitDate.localeCompare(a.terbitDate));
    setPayouts(next); await dataSet("payouts", next);
    setPasteText(""); setPasteResult(null);
    showToast(`✅ ${news.length} laporan disimpan!`);
  };
  const deletePayout = async (id) => {
    const next = payouts.filter(p=>p.id!==id);
    setPayouts(next); await dataSet("payouts", next);
    showToast("Dihapus", "warn");
  };
  const addExtraDebtFn = async () => {
    const amt = parseFloat(extraAmt);
    if (!amt||amt<=0) { showToast("Masukkan jumlah!", "warn"); return; }
    const next = [...extraDebt,{id:Date.now().toString(),date:new Date().toISOString().substring(0,10),amount:amt,note:extraNote}];
    setExtraDebt(next); await dataSet("extraDebt", next);
    setExtraAmt(""); setExtraNote("");
    showToast("✅ Cicilan tambahan dicatat!");
  };

  // ── PAYOUT CARD ──────────────────────────────────────────────
  const PayoutCard = ({ p, onDelete }) => (
    <div style={{background:"var(--surface2)",borderRadius:10,padding:13,marginBottom:8,borderLeft:`3px solid ${p.status==="Dibayarkan"?"var(--green)":"var(--yellow)"}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
        <div>
          <div style={{fontWeight:800,fontSize:".9rem"}}>{fmtDate(p.terbitDate)||"–"}</div>
          <div style={{fontSize:".68rem",color:"var(--text3)",marginTop:2}}>{p.lapId?`ID: ${p.lapId}`:""}{p.payDate?` · Dibayar: ${fmtDate(p.payDate)}`:""}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontWeight:800,fontFamily:"'DM Mono',monospace",color:"var(--green)"}}>{fmtRpFull(p.komisiDibayar)}</div>
          <SBadge s={p.status}/>
        </div>
      </div>
      {p.potonganPajak>0 && <div style={{fontSize:".72rem",color:"var(--text3)",marginBottom:8}}>Sebelum pajak: {fmtRpFull(p.komisiSebelumPajak||0)} · Pajak: <span style={{color:"var(--red)",fontWeight:700}}>-{fmtRpFull(p.potonganPajak)}</span></div>}
      {p.breakdown?.length>0 && <div style={{background:"var(--surface)",borderRadius:7,padding:"8px 10px",marginBottom:8}}>{p.breakdown.map((b,j)=><div key={j} style={{display:"flex",justifyContent:"space-between",fontSize:".72rem",padding:"3px 0",borderBottom:j<p.breakdown.length-1?"1px solid var(--border)":"none"}}><span style={{color:"var(--text3)"}}>Selesai {fmtDate(b.date)}</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:700}}>{fmtRpFull(b.amount)}</span></div>)}</div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
        <AllocBox label="💳 Cicilan (30%)" amount={p.cicilan} color="var(--red)"/>
        <AllocBox label="📣 Modal (50%)" amount={p.modal} color="var(--blue)"/>
        <AllocBox label="🏠 Hidup (20%)" amount={p.hidup} color="var(--green)"/>
      </div>
      {onDelete && <div style={{display:"flex",justifyContent:"flex-end",marginTop:8}}><button className="btn btn-d" onClick={()=>onDelete(p.id)}>🗑 Hapus</button></div>}
    </div>
  );

  // ── TABS ─────────────────────────────────────────────────────
  const TABS = [
    {id:"dashboard",label:"📊 Dashboard"},
    {id:"pembayaran",label:"💰 Lap. Pembayaran"},
    {id:"upload",label:"📂 Upload CSV"},
    {id:"perhari",label:"📆 Per Hari"},
    {id:"pesanan",label:"🧾 Pesanan"},
    {id:"kampanye",label:"📣 Kampanye"},
    {id:"monthly",label:"📅 Bulanan"},
    {id:"debt",label:"💳 Hutang"},
  ];



  if (loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",flexDirection:"column",gap:12,color:"#94a3b8",fontFamily:"'Plus Jakarta Sans',sans-serif"}}><div style={{fontSize:"2rem"}}>🛍️</div><div style={{fontWeight:700}}>Memuat data...</div></div>;

  return (
    <div className="app">
      <style>{css}</style>
      <header>
        <div className="hdr">
          <div className="logo">
            <div className="logo-mark">🛍️</div>
            <div><h1>Afisaku</h1><span>Shopee Affiliate Tracker</span></div>
          </div>
          <div className="hdr-debt">
            <div className="lbl">Sisa Hutang</div>
            <div className="val">{fmtRpFull(debtLeft)}</div>
          </div>
        </div>
      </header>
      <nav>{TABS.map(t=><button key={t.id} className={`nb ${tab===t.id?"active":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>)}</nav>
      <main>
  
        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && <>
          <div className="card">
            <div className="ct">Progress Pelunasan Hutang</div>
            <div className="pw">
              <div className="ph"><span className="pl">Rp 6.000.000 → Lunas</span><span className="pp">{debtPct}%</span></div>
              <div className="pt"><div className="pf" style={{width:debtPct+"%"}}/></div>
              <div className="pn"><span>Terbayar: <strong>{fmtRpFull(debtPaid)}</strong></span><span>Sisa: <strong>{fmtRpFull(debtLeft)}</strong></span></div>
            </div>
          </div>

          <div className="sg">
            <div className="st"><div className="l">Total Dibayarkan Shopee</div><div className="v green">{fmtRp(totalDibayarkan)}</div><div className="s">{payoutsPaid.length} laporan pembayaran</div></div>
            <div className="st"><div className="l">Komisi Kotor (CSV)</div><div className="v purple">{fmtRp(komisiKotor)}</div><div className="s">{pesananData.length} total pesanan</div></div>
            <div className="st"><div className="l">Biaya Meta Ads</div><div className="v red">{fmtRp(totalSpend)}</div><div className="s">{[...new Set(metaData.map(r=>r["Nama kampanye"]))].filter(Boolean).length} kampanye</div></div>
            <div className="st"><div className="l">Total Klik Shopee</div><div className="v blue">{clicksData.length.toLocaleString("id-ID")}</div><div className="s">{clicksData.filter(r=>r["Perujuk"]==="Facebook").length.toLocaleString("id-ID")} dari Facebook</div></div>
          </div>

          <div className="roas-hi">
            <div className="roas-v">{roas?roas+"x":"–"}</div>
            <div className="roas-l">ROAS · Komisi Kotor ÷ Spend Meta Ads · Target &gt; 1x</div>
          </div>

          {Object.keys(byPlatform).length>0 && <div className="card">
            <div className="ct">Komisi Kotor per Platform</div>
            <BarChart rows={Object.entries(byPlatform).sort((a,b)=>b[1].komisi-a[1].komisi).map(([p,d])=>({label:p,val:d.komisi,display:fmtRp(d.komisi)}))} color="#16a34a"/>
          </div>}

          {payouts.length>0 && <div className="card">
            <div className="ct">Laporan Pembayaran Terakhir</div>
            {payouts.slice(0,3).map(p=><PayoutCard key={p.id} p={p}/>)}
          </div>}

          {payouts.length===0&&pesananData.length===0 && <div className="empty"><div className="icon">💸</div><p>Belum ada data.<br/>Upload CSV atau paste Laporan Pembayaran untuk mulai.</p></div>}
        </>}

        {/* ══ LAPORAN PEMBAYARAN ══ */}
        {tab==="pembayaran" && <>
          {payouts.length>0 && (() => {
            const totalPajak = payoutsPaid.reduce((s,p)=>s+(p.potonganPajak||0),0);
            const menunggu = payouts.filter(p=>p.status==="Menunggu Dibayar");
            return <div className="sg">
              <div className="st"><div className="l">Total Dibayarkan</div><div className="v green">{fmtRp(totalDibayarkan)}</div><div className="s">{payoutsPaid.length} laporan</div></div>
              <div className="st"><div className="l">Potongan Pajak</div><div className="v red">{fmtRp(totalPajak)}</div><div className="s">dipotong Shopee</div></div>
              <div className="st"><div className="l">Cicilan Hutang (30%)</div><div className="v orange">{fmtRp(payoutsPaid.reduce((s,p)=>s+p.cicilan,0))}</div></div>
              <div className="st"><div className="l">Menunggu Dibayar</div><div className="v yellow">{fmtRp(menunggu.reduce((s,p)=>s+p.komisiDibayar,0))}</div><div className="s">{menunggu.length} laporan</div></div>
            </div>;
          })()}

          <div className="card">
            <div className="ct">📋 Paste dari Shopee</div>
            <div style={{background:"var(--blue-l)",border:"1px solid #bfdbfe",borderRadius:10,padding:"12px 14px",marginBottom:14,fontSize:".78rem",color:"#1e40af",lineHeight:1.7}}>
              <strong>Cara copy data dari Shopee:</strong><br/>
              1. Buka <strong>Laporan Pembayaran</strong> di affiliate.shopee.co.id/payment/payout_record<br/>
              2. Select semua teks di halaman (Ctrl+A) → Copy (Ctrl+C)<br/>
              3. Paste di bawah ini → klik <strong>Baca Data</strong><br/>
              💡 <em>Bisa paste dari halaman list maupun halaman detail payout (lebih lengkap, ada pajak & breakdown)</em>
            </div>
            <div className="fg">
              <label>Tempelkan teks dari Shopee</label>
              <textarea placeholder={"Contoh dari halaman list:\n07-06-2026   11346911751260607   Rp793.564   Menunggu Dibayar   --\n03-06-2026   11346911751260603   Rp1.041.691   Dibayarkan   05-06-2026 16:06\n\nAtau paste dari halaman detail untuk data lengkap (pajak + breakdown per tanggal)."} value={pasteText} onChange={e=>{setPasteText(e.target.value);setPasteResult(null);}} style={{minHeight:130,fontFamily:"'DM Mono',monospace",fontSize:".75rem"}}/>
            </div>
            <button className="btn btn-p" onClick={handlePaste} style={{marginBottom:10}}>🔍 Baca Data</button>

            {pasteResult?.length>0 && <>
              <div style={{fontWeight:700,fontSize:".82rem",color:"var(--green)",marginBottom:10}}>✅ Terbaca {pasteResult.length} laporan — periksa lalu simpan:</div>
              {pasteResult.map((p,i)=><PayoutCard key={i} p={p}/>)}
              <button className="btn btn-p" onClick={confirmPaste}>💾 Simpan {pasteResult.length} Laporan Ini</button>
            </>}
          </div>

          {payouts.length>0 && <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div className="ct" style={{marginBottom:0}}>Riwayat Laporan Pembayaran</div>
              <span className="badge bg-orange">{payouts.length} laporan</span>
            </div>
            {payouts.map(p=><PayoutCard key={p.id} p={p} onDelete={deletePayout}/>)}
          </div>}

          {payouts.length===0&&!pasteResult && <div className="empty"><div className="icon">💰</div><p>Belum ada laporan pembayaran.<br/>Paste data dari Shopee di atas untuk mulai.</p></div>}
        </>}

        {/* ══ UPLOAD CSV ══ */}
        {tab==="upload" && <>
          <div className="card"><div className="ct">📈 Data Meta Ads</div><UploadZone icon="📈" title="Upload Data Meta Ads (CSV)" sub="Export dari Facebook Ads Manager • Breakdown by Day" onFile={handleMeta} status={usMeta}/></div>
          <div className="card"><div className="ct">🧾 Laporan Pesanan Affiliate</div><UploadZone icon="🧾" title="Upload Laporan Pesanan (CSV)" sub="AffiliateCommissionReport dari Shopee Affiliate" onFile={handlePesanan} status={usPesanan}/></div>
          <div className="card"><div className="ct">🖱️ Shopee Clicks</div><UploadZone icon="🖱️" title="Upload Shopee Clicks (CSV)" sub="WebsiteClickReport dari Shopee Affiliate" onFile={handleClicks} status={usClicks}/></div>
          <div className="card" style={{borderColor:"#fed7aa"}}>
            <div className="ct">ℹ️ Catatan</div>
            <p style={{fontSize:".8rem",color:"var(--text2)",lineHeight:1.7}}>
              • Upload berulang aman — duplikat otomatis dilewati<br/>
              • Kolom kunci: <code>Komisi Bersih Affiliate (Rp)</code>, <code>Awal pelaporan</code>, <code>Klik ID</code><br/>
              • ✅ Data langsung tersimpan ke Firebase — siapapun yang buka link ini bisa lihat
            </p>
          </div>
        </>}

        {/* ══ PER HARI ══ */}
        {tab==="perhari" && <>
          <div className="card">
            <div className="ct">Ringkasan Harian — Semua Sumber</div>
            {allDays.length===0 ? <div className="empty"><div className="icon">📆</div><p>Upload CSV untuk melihat data per hari.</p></div> :
            <div className="table-wrap">
              <table className="dt">
                <thead><tr><th>Tanggal</th><th>Spend</th><th>Klik Meta</th><th>Klik Shopee</th><th>Pesanan</th><th>Komisi Kotor</th><th>ROAS</th></tr></thead>
                <tbody>{allDays.map(d=>{
                  const m=metaByDay[d]||{spend:0,clicks:0};
                  const c=clicksByDay[d]||0;
                  const p=pesananByDay[d]||{komisi:0,count:0};
                  const dr=m.spend>0?(p.komisi/m.spend).toFixed(2):null;
                  return <tr key={d}>
                    <td style={{fontWeight:700,whiteSpace:"nowrap"}}>{fmtDate(d)}</td>
                    <td className="num" style={{color:"var(--red)"}}>{m.spend>0?fmtRp(m.spend):"-"}</td>
                    <td className="num">{m.clicks>0?m.clicks.toLocaleString("id-ID"):"-"}</td>
                    <td className="num" style={{color:"var(--blue)"}}>{c>0?c.toLocaleString("id-ID"):"-"}</td>
                    <td className="num">{p.count>0?p.count:"-"}</td>
                    <td className="num" style={{color:"var(--green)"}}>{p.komisi>0?fmtRp(p.komisi):"-"}</td>
                    <td className="num">{dr?<span className={`badge ${parseFloat(dr)>=1?"bg-green":"bg-red"}`}>{dr}x</span>:"-"}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
          </div>

          {payouts.length>0 && <div className="card">
            <div className="ct">Laporan Pembayaran per Tanggal Terbit</div>
            {payouts.map(p=><div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid var(--border)"}}>
              <div><div style={{fontWeight:700,fontSize:".82rem"}}>{fmtDate(p.terbitDate)}</div><div style={{fontSize:".68rem",color:"var(--text3)"}}>{p.lapId||""}</div></div>
              <div style={{textAlign:"right"}}><div style={{fontWeight:800,fontFamily:"'DM Mono',monospace",color:"var(--green)"}}>{fmtRpFull(p.komisiDibayar)}</div><SBadge s={p.status}/></div>
            </div>)}
          </div>}
        </>}

        {/* ══ PESANAN ══ */}
        {tab==="pesanan" && <>
          <div className="card">
            <div className="ct">Filter</div>
            <div className="filter-bar">
              <select value={fStatus} onChange={e=>setFStatus(e.target.value)}><option value="">Semua Status</option>{["Selesai","Tertunda","Dibatalkan","Belum Dibayar"].map(s=><option key={s}>{s}</option>)}</select>
              <select value={fPlatform} onChange={e=>setFPlatform(e.target.value)}><option value="">Semua Platform</option>{["Facebook","Instagram","Others","Websites"].map(p=><option key={p}>{p}</option>)}</select>
              <select value={fTag} onChange={e=>setFTag(e.target.value)}><option value="">Semua Tag</option>{allTags.map(t=><option key={t}>{t}</option>)}</select>
              <select value={fDay} onChange={e=>setFDay(e.target.value)}><option value="">Semua Tanggal</option>{allDays.map(d=><option key={d} value={d}>{fmtDate(d)}</option>)}</select>
            </div>
          </div>
          <div className="sg">
            <div className="st"><div className="l">Komisi Kotor (filter)</div><div className="v green">{fmtRp(filteredPesanan.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0))}</div><div className="s">{filteredPesanan.length} pesanan</div></div>
            <div className="st"><div className="l">Total Nilai Beli</div><div className="v blue">{fmtRp(filteredPesanan.reduce((s,r)=>s+parseNum(r["Nilai Pembelian(Rp)"]),0))}</div></div>
          </div>
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div className="ct" style={{marginBottom:0}}>Daftar Pesanan</div>
              <span className="badge bg-orange">{filteredPesanan.length}</span>
            </div>
            {pesananData.length===0 ? <div className="empty"><div className="icon">🧾</div><p>Upload Laporan Pesanan CSV.</p></div> :
            <div className="table-wrap">
              <table className="dt">
                <thead><tr><th>Tanggal</th><th>Produk</th><th>Status</th><th>Platform</th><th>Tag</th><th>Nilai Beli</th><th>Komisi</th></tr></thead>
                <tbody>
                  {filteredPesanan.slice(0,100).map((r,i)=><tr key={i}>
                    <td style={{whiteSpace:"nowrap",fontSize:".7rem"}}>{dateOnly(r["Waktu Pemesanan"])}</td>
                    <td style={{maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:".74rem"}} title={r["Nama Barange"]}>{(r["Nama Barange"]||"").substring(0,30)}{(r["Nama Barange"]||"").length>30?"…":""}</td>
                    <td><SBadge s={r["Status Pesanan"]}/></td>
                    <td><Pill p={r["Platform"]||"Others"}/></td>
                    <td style={{fontSize:".7rem",color:"var(--text3)"}}>{r["Tag_link1"]||"-"}</td>
                    <td className="num">{fmtRp(parseNum(r["Nilai Pembelian(Rp)"]))}</td>
                    <td className="num" style={{color:"var(--green)"}}>{fmtRpFull(parseNum(r["Komisi Bersih Affiliate (Rp)"]))}</td>
                  </tr>)}
                  {filteredPesanan.length>100 && <tr><td colSpan={7} style={{textAlign:"center",padding:12,color:"var(--text3)",fontSize:".75rem"}}>…dan {filteredPesanan.length-100} lainnya. Gunakan filter.</td></tr>}
                </tbody>
              </table>
            </div>}
          </div>
        </>}

        {/* ══ KAMPANYE ══ */}
        {tab==="kampanye" && <>
          <div className="sg">
            <div className="st"><div className="l">Total Spend</div><div className="v red">{fmtRp(totalSpend)}</div></div>
            <div className="st"><div className="l">Total Klik Shopee</div><div className="v blue">{clicksData.length.toLocaleString("id-ID")}</div></div>
            <div className="st"><div className="l">Komisi Kotor</div><div className="v green">{fmtRp(komisiKotor)}</div></div>
            <div className="st"><div className="l">ROAS</div><div className="v yellow">{roas?roas+"x":"–"}</div></div>
          </div>
          <div className="card">
            <div className="ct">Performa per Kampanye</div>
            {metaData.length===0 ? <div className="empty"><div className="icon">📣</div><p>Upload Data Meta Ads.</p></div> : (() => {
              const bc = {};
              metaData.forEach(r=>{ const k=r["Nama kampanye"]||"-";if(!bc[k])bc[k]={spend:0,clicks:0,impresi:0,days:new Set()};bc[k].spend+=parseNum(r["Jumlah yang dibelanjakan (IDR)"]);bc[k].clicks+=parseNum(r["Klik tautan"]);bc[k].impresi+=parseNum(r["Impresi"]);if(r["Awal pelaporan"])bc[k].days.add(r["Awal pelaporan"]);});
              return Object.entries(bc).sort((a,b)=>b[1].spend-a[1].spend).map(([k,d])=><div key={k} style={{background:"var(--surface2)",borderRadius:10,padding:13,marginBottom:8}}>
                <div style={{fontWeight:800,fontSize:".88rem",marginBottom:10}}>{k}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[["Spend",fmtRp(d.spend),"var(--red)"],["Klik",d.clicks.toLocaleString("id-ID"),"var(--blue)"],["Impresi",d.impresi.toLocaleString("id-ID"),"var(--text3)"]].map(([l,v,c])=><div key={l} style={{textAlign:"center"}}><div style={{fontWeight:800,fontSize:".85rem",color:c,fontFamily:"'DM Mono',monospace"}}>{v}</div><div style={{fontSize:".62rem",color:"var(--text3)",fontWeight:600,marginTop:2}}>{l}</div></div>)}
                </div>
                <div style={{fontSize:".68rem",color:"var(--text3)",marginTop:8}}>{d.days.size} hari aktif</div>
              </div>);
            })()}
          </div>
          <div className="card">
            <div className="ct">Klik per Platform</div>
            {clicksData.length===0 ? <div className="empty"><div className="icon">🖱️</div><p>Upload Shopee Clicks.</p></div> : (() => {
              const byP = clicksData.reduce((acc,r)=>{ const p=r["Perujuk"]||"Others";acc[p]=(acc[p]||0)+1;return acc;},{});
              const total = clicksData.length;
              return <BarChart rows={Object.entries(byP).sort((a,b)=>b[1]-a[1]).map(([p,c])=>({label:p,val:c,display:`${c.toLocaleString("id-ID")} (${(c/total*100).toFixed(1)}%)`}))} color="#2563eb"/>;
            })()}
          </div>
        </>}

        {/* ══ BULANAN ══ */}
        {tab==="monthly" && <>
          <div className="card">
            <div className="ct">Pilih Bulan</div>
            {allMonths.length===0 ? <p style={{fontSize:".8rem",color:"var(--text3)"}}>Belum ada data.</p> :
            <div className="month-sel">{allMonths.map(m=><button key={m} className={`mb ${m===activeMonth?"active":""}`} onClick={()=>setSelectedMonth(m)}>{monthLabel(m)}</button>)}</div>}
          </div>
          {activeMonth && <>
            <div className="sg">
              <div className="st"><div className="l">Spend Meta Ads</div><div className="v red">{fmtRp(mSpend)}</div><div className="s">{metaMonth.length} baris</div></div>
              <div className="st"><div className="l">Komisi Kotor</div><div className="v green">{fmtRp(mKotor)}</div><div className="s">{pesananMonth.length} pesanan</div></div>
              <div className="st"><div className="l">Komisi Selesai</div><div className="v purple">{fmtRp(mSelesai)}</div><div className="s">{pesananMonth.filter(r=>r["Status Pesanan"]==="Selesai").length} confirmed</div></div>
              <div className="st"><div className="l">ROAS</div><div className="v yellow">{mRoas?mRoas+"x":"–"}</div><div className="s">kotor ÷ spend</div></div>
            </div>
            <div className="sg">
              <div className="st"><div className="l">Total Klik</div><div className="v blue">{clicksMonth.length.toLocaleString("id-ID")}</div></div>
              <div className="st"><div className="l">Profit Est.</div><div className={`v ${mKotor-mSpend>=0?"green":"red"}`}>{fmtRp(mKotor-mSpend)}</div><div className="s">kotor - spend</div></div>
            </div>
            {payoutsMonth.length>0 && <div className="card">
              <div className="ct">Laporan Pembayaran {monthLabel(activeMonth)}</div>
              {payoutsMonth.map(p=><PayoutCard key={p.id} p={p}/>)}
            </div>}
            <div className="card">
              <div className="ct">Status Pesanan {monthLabel(activeMonth)}</div>
              {["Selesai","Tertunda","Dibatalkan","Belum Dibayar"].map(s=>{ const items=pesananMonth.filter(r=>r["Status Pesanan"]===s);if(!items.length)return null;const k=items.reduce((sum,r)=>sum+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);return <div key={s} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid var(--border)"}}><div><SBadge s={s}/><span style={{fontSize:".76rem",color:"var(--text3)",marginLeft:8}}>{items.length} pesanan</span></div><div style={{fontWeight:800,fontFamily:"'DM Mono',monospace"}}>{fmtRpFull(k)}</div></div>;})}
            </div>
          </>}
        </>}

        {/* ══ HUTANG ══ */}
        {tab==="debt" && <>
          <div className="card">
            <div className="ct">Status Hutang</div>
            <div className="pw">
              <div className="ph"><span className="pl">Total Awal: Rp 6.000.000</span><span className="pp">{debtPct}%</span></div>
              <div className="pt" style={{height:12}}><div className="pf" style={{width:debtPct+"%"}}/></div>
              <div className="pn"><span>Terbayar: <strong style={{color:"var(--green)"}}>{fmtRpFull(debtPaid)}</strong></span><span>Sisa: <strong style={{color:"var(--accent)"}}>{fmtRpFull(debtLeft)}</strong></span></div>
            </div>
          </div>
          <div className="card">
            <div className="ct">Riwayat Cicilan</div>
            {[...payoutsPaid.map(p=>({date:p.terbitDate,amount:p.cicilan,source:"💰 Lap. Pembayaran — "+fmtDate(p.terbitDate)})),
              ...extraDebt.map(e=>({date:e.date,amount:e.amount,source:"⚡ "+(e.note||"Tambahan")}))
            ].sort((a,b)=>b.date.localeCompare(a.date)).length===0
              ? <div className="empty"><div className="icon">💳</div><p>Cicilan otomatis tercatat dari Laporan Pembayaran Shopee.</p></div>
              : [...payoutsPaid.map(p=>({date:p.terbitDate,amount:p.cicilan,source:"💰 "+fmtDate(p.terbitDate)})),
                  ...extraDebt.map(e=>({date:e.date,amount:e.amount,source:"⚡ "+(e.note||"Tambahan")}))
                ].sort((a,b)=>b.date.localeCompare(a.date)).map((item,i)=>
                  <div key={i} className="dp-item">
                    <div><div className="dp-date">{fmtDate(item.date)}</div><div className="dp-src">{item.source}</div></div>
                    <div className="dp-amt">{fmtRpFull(item.amount)}</div>
                  </div>
                )
            }
          </div>
          <div className="card" style={{borderColor:"#fde68a"}}>
            <div className="ct">⚡ Cicilan Tambahan</div>
            <div className="r2">
              <div className="fg"><label>Jumlah (Rp)</label><input type="number" placeholder="200000" value={extraAmt} onChange={e=>setExtraAmt(e.target.value)}/></div>
              <div className="fg"><label>Catatan</label><input type="text" placeholder="Dari tabungan..." value={extraNote} onChange={e=>setExtraNote(e.target.value)}/></div>
            </div>
            <button className="btn btn-p" onClick={addExtraDebtFn}>💰 Catat Cicilan Tambahan</button>
          </div>
        </>}

      </main>
      <div className="toast-wrap">{toasts.map(t=><div key={t.id} className={`toast show ${t.type}`}>{t.msg}</div>)}</div>
    </div>
  );
}
