import { useState, useEffect, useCallback, useRef } from "react";
import { dataGet, dataSet } from "./firebase.js";

const DEBT_TOTAL = 6_000_000;

const fmtRp = (n) => { n = Math.round(n || 0); if (n >= 1_000_000) return "Rp " + (n/1_000_000).toFixed(n%1_000_000===0?0:1) + " Jt"; if (n >= 1_000) return "Rp " + n.toLocaleString("id-ID"); return "Rp " + n; };
const fmtRpFull = (n) => "Rp " + Math.round(n || 0).toLocaleString("id-ID");
const fmtDate = (iso) => { if (!iso) return "-"; const d = new Date(iso + (iso.length===10?"T00:00:00":"")); return d.toLocaleDateString("id-ID",{day:"numeric",month:"short",year:"numeric"}); };
const dateOnly = (s) => (s||"").substring(0,10);
const monthKey = (s) => (s||"").substring(0,7);
const monthLabel = (k) => { if(!k)return""; const[y,m]=k.split("-"); return["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][+m-1]+" "+y; };
const parseNum = (v) => {
  if(!v&&v!==0)return 0;
  const s=v.toString().trim();
  if(/^\d+(\.\d+)?$/.test(s))return parseFloat(s)||0;
  if(/\d\.\d{3},/.test(s)||/,\d{1,2}$/.test(s))return parseFloat(s.replace(/\./g,"").replace(/,/g,"."))||0;
  if(/^\d{1,3}(\.\d{3})+$/.test(s))return parseFloat(s.replace(/\./g,""))||0;
  return parseFloat(s.replace(/[^\d.-]/g,""))||0;
};
const today = () => new Date().toISOString().substring(0,10);
const daysAgo = (n) => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().substring(0,10); };

function parsePayoutPaste(raw) {
  const lines=raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const fullText=lines.join(" ");
  const results=[];
  const statusList=["Menunggu Dibayar","Dibayarkan","Ditahan","Gagal"];
  const totalM=fullText.match(/Total Komisi yang Dibayarkan[:\s]+Rp([\d.,]+)/i);
  if(totalM){
    const komisi=parseFloat(totalM[1].replace(/\./g,""))||0;
    const pajakM=fullText.match(/Total Potongan Pajak[:\s]+-?Rp([\d.,]+)/i);
    const sebelumM=fullText.match(/Total Komisi Sebelum Pajak[:\s]+Rp([\d.,]+)/i);
    const lapIdM=fullText.match(/ID Laporan Pembayaran[:\s]+(\d{10,})/i);
    const waktuBayarM=fullText.match(/Waktu Pembayaran[:\s]+(\d{2}-\d{2}-\d{4})/i);
    const terbitM=fullText.match(/Diterbitkan\s+(\d{2}-\d{2})/i)||fullText.match(/Waktu Terbit[^:]*:\s*(\d{2}-\d{2}-\d{4})/i);
    const pajak=pajakM?parseFloat(pajakM[1].replace(/\./g,"")):0;
    const sebelum=sebelumM?parseFloat(sebelumM[1].replace(/\./g,"")):0;
    const breakdown=[];
    const bkRe=/Pesanan Selesai pada (\d{2}-\d{2}-\d{4})\s+Rp([\d.,]+)/g;
    let bkM;
    while((bkM=bkRe.exec(fullText))!==null){const[dd,mm,yyyy]=bkM[1].split("-");breakdown.push({date:`${yyyy}-${mm}-${dd}`,amount:parseFloat(bkM[2].replace(/\./g,""))||0});}
    let terbitIso="";
    if(terbitM){const p=terbitM[1].split("-");terbitIso=p.length===2?`2026-${p[1]}-${p[0]}`:`${p[2]}-${p[1]}-${p[0]}`;}
    let payIso="";
    if(waktuBayarM){const[dd,mm,yyyy]=waktuBayarM[1].split("-");payIso=`${yyyy}-${mm}-${dd}`;}
    if(komisi>0)results.push({id:lapIdM?lapIdM[1]:("det-"+Date.now()),terbitDate:terbitIso,payDate:payIso,lapId:lapIdM?lapIdM[1]:"",komisiDibayar:komisi,komisiSebelumPajak:sebelum,potonganPajak:pajak,status:"Dibayarkan",breakdown,cicilan:komisi*0.3,modal:komisi*0.5,hidup:komisi*0.2,source:"paste-detail"});
    return results;
  }
  for(const line of lines){
    const dateM=line.match(/(\d{2}-\d{2}-\d{4})/);if(!dateM)continue;
    const rpM=line.match(/Rp([\d.]+)/);if(!rpM)continue;
    const[dd,mm,yyyy]=dateM[1].split("-");const isoDate=`${yyyy}-${mm}-${dd}`;
    const rpVal=parseFloat(rpM[1].replace(/\./g,""))||0;
    const idM=line.match(/\b(\d{15,})\b/);
    const status=statusList.find(s=>line.includes(s))||"Tidak diketahui";
    const allDates=[...line.matchAll(/(\d{2}-\d{2}-\d{4})/g)];
    let payDate="";
    if(allDates.length>=2){const[dd2,mm2,yyyy2]=allDates[1][1].split("-");payDate=`${yyyy2}-${mm2}-${dd2}`;}
    if(isoDate&&rpVal>0)results.push({id:idM?idM[1]:(isoDate+"-"+rpVal),terbitDate:isoDate,payDate,lapId:idM?idM[1]:"",komisiDibayar:rpVal,potonganPajak:0,status,cicilan:rpVal*0.3,modal:rpVal*0.5,hidup:rpVal*0.2,source:"paste-list"});
  }
  return results;
}

function parseCSV(text){
  const lines=text.trim().split(/\r?\n/);if(lines.length<2)return[];
  const headers=lines[0].split(",").map(h=>h.trim().replace(/^"|"$/g,""));
  return lines.slice(1).map(line=>{
    const vals=[];let cur="",inQ=false;
    for(const ch of line){if(ch==='"')inQ=!inQ;else if(ch===','&&!inQ){vals.push(cur.trim());cur="";}else cur+=ch;}
    vals.push(cur.trim());
    const obj={};headers.forEach((h,i)=>obj[h]=(vals[i]||"").replace(/^"|"$/g,"").trim());return obj;
  }).filter(r=>Object.values(r).some(v=>v));
}

// ── CSS ──────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#f4f6fb;--surface:#fff;--surface2:#f0f3fa;--border:#e4e8f2;
  --accent:#f97316;--accent-l:#fff4ed;
  --green:#16a34a;--green-l:#f0fdf4;--green2:#22c55e;
  --blue:#2563eb;--blue-l:#eff6ff;
  --red:#dc2626;--red-l:#fef2f2;
  --yellow:#ca8a04;--yellow-l:#fefce8;
  --purple:#7c3aed;--purple-l:#f5f3ff;
  --text:#0f172a;--text2:#475569;--text3:#94a3b8;
  --r:14px;--r-sm:9px;
  --shadow:0 1px 4px rgba(0,0,0,.07);
  --shadow-md:0 4px 16px rgba(0,0,0,.09);
}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--text);font-size:14px;}
.app{min-height:100vh;display:flex;flex-direction:column;}

/* HEADER */
header{background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px;position:sticky;top:0;z-index:100;box-shadow:var(--shadow);}
.hdr{display:flex;align-items:center;justify-content:space-between;height:58px;}
.logo{display:flex;align-items:center;gap:10px;}
.logo-mark{width:34px;height:34px;background:var(--accent);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;box-shadow:0 2px 8px rgba(249,115,22,.3);}
.logo h1{font-size:1.05rem;font-weight:800;color:var(--text);letter-spacing:-.4px;}
.logo span{font-size:.66rem;color:var(--text3);display:block;font-weight:500;}
.hdr-right{display:flex;align-items:center;gap:16px;}
.hdr-stat{text-align:right;}
.hdr-stat .hl{font-size:.65rem;color:var(--text3);font-weight:500;}
.hdr-stat .hv{font-size:.9rem;font-weight:800;letter-spacing:-.3px;}

/* NAV */
nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;display:flex;overflow-x:auto;scrollbar-width:none;gap:2px;}
nav::-webkit-scrollbar{display:none;}
.nb{flex-shrink:0;padding:13px 14px 11px;font-family:inherit;font-size:.78rem;font-weight:600;border:none;background:transparent;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;}
.nb:hover{color:var(--text);}
.nb.active{color:var(--accent);border-bottom-color:var(--accent);}

main{flex:1;padding:18px 16px;max-width:860px;margin:0 auto;width:100%;}

/* FILTER BAR SHOMET STYLE */
.dash-filter{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;}
.dash-filter-title{font-size:1rem;font-weight:800;color:var(--text);letter-spacing:-.3px;}
.filter-pills{display:flex;gap:6px;flex-wrap:wrap;}
.fp{padding:6px 14px;border-radius:99px;border:1px solid var(--border);background:var(--surface);color:var(--text3);font-family:inherit;font-size:.75rem;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;}
.fp.active{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 2px 8px rgba(249,115,22,.25);}
.fp:hover:not(.active){border-color:var(--accent);color:var(--accent);}
.plat-select{padding:6px 12px;border-radius:99px;border:1px solid var(--border);background:var(--surface);color:var(--text2);font-family:inherit;font-size:.75rem;font-weight:600;outline:none;cursor:pointer;}
.plat-select:focus{border-color:var(--accent);}

/* METRIC CARDS — SHOMET STYLE */
.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
.metric-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;box-shadow:var(--shadow);position:relative;overflow:hidden;}
.metric-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--r) var(--r) 0 0;}
.metric-card.mc-green::before{background:var(--green2);}
.metric-card.mc-blue::before{background:var(--blue);}
.metric-card.mc-red::before{background:var(--red);}
.metric-card.mc-orange::before{background:var(--accent);}
.metric-card.mc-purple::before{background:var(--purple);}
.metric-card.mc-yellow::before{background:var(--yellow);}
.mc-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:10px;}
.mc-icon.bg-green{background:var(--green-l);}
.mc-icon.bg-blue{background:var(--blue-l);}
.mc-icon.bg-red{background:var(--red-l);}
.mc-icon.bg-orange{background:var(--accent-l);}
.mc-icon.bg-purple{background:var(--purple-l);}
.mc-icon.bg-yellow{background:var(--yellow-l);}
.mc-label{font-size:.68rem;color:var(--text3);font-weight:600;margin-bottom:5px;}
.mc-value{font-size:1.3rem;font-weight:800;letter-spacing:-.5px;line-height:1;}
.mc-value.green{color:var(--green);}
.mc-value.blue{color:var(--blue);}
.mc-value.red{color:var(--red);}
.mc-value.orange{color:var(--accent);}
.mc-value.purple{color:var(--purple);}
.mc-value.yellow{color:var(--yellow);}
.mc-sub{font-size:.68rem;color:var(--text3);margin-top:5px;font-weight:500;}

/* PROFIT & ROAS ROW */
.pnl-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px;}
.pnl-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;box-shadow:var(--shadow);text-align:center;}
.pnl-label{font-size:.68rem;color:var(--text3);font-weight:600;margin-bottom:6px;}
.pnl-value{font-size:1.5rem;font-weight:800;letter-spacing:-.8px;font-family:'DM Mono',monospace;}

/* CHART */
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:12px;box-shadow:var(--shadow);}
.chart-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.chart-title{font-size:.82rem;font-weight:700;color:var(--text);}
.chart-legend{display:flex;gap:12px;}
.cl-item{display:flex;align-items:center;gap:5px;font-size:.68rem;color:var(--text3);font-weight:600;}
.cl-dot{width:8px;height:8px;border-radius:2px;}
.bar-chart-wrap{display:flex;align-items:flex-end;gap:6px;height:140px;overflow-x:auto;padding-bottom:4px;}
.bar-group{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:36px;flex:1;}
.bar-group .bars{display:flex;gap:2px;align-items:flex-end;height:110px;}
.bar-item{border-radius:4px 4px 0 0;min-width:12px;flex:1;transition:opacity .2s;}
.bar-item:hover{opacity:.8;}
.bar-group .bg-date{font-size:.6rem;color:var(--text3);font-weight:600;text-align:center;white-space:nowrap;}

/* DEBT PROGRESS */
.debt-card{background:linear-gradient(135deg,#fff7ed,#fff);border:1px solid #fed7aa;border-radius:var(--r);padding:16px;margin-bottom:12px;box-shadow:var(--shadow);}
.debt-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.debt-title{font-size:.82rem;font-weight:700;color:var(--text);}
.debt-pct{font-size:1.1rem;font-weight:800;color:var(--accent);}
.debt-track{height:10px;background:#fed7aa;border-radius:99px;overflow:hidden;margin-bottom:8px;}
.debt-fill{height:100%;background:linear-gradient(90deg,var(--accent),#fbbf24);border-radius:99px;transition:width .7s cubic-bezier(.4,0,.2,1);}
.debt-nums{display:flex;justify-content:space-between;font-size:.72rem;color:var(--text2);font-weight:600;}

/* CARDS */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:12px;box-shadow:var(--shadow);}
.ct{font-size:.68rem;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text3);margin-bottom:12px;}

/* BADGE & PILL */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:.65rem;font-weight:700;}
.bg-green{background:var(--green-l);color:var(--green);}
.bg-yellow{background:var(--yellow-l);color:var(--yellow);}
.bg-red{background:var(--red-l);color:var(--red);}
.bg-blue{background:var(--blue-l);color:var(--blue);}
.bg-orange{background:var(--accent-l);color:var(--accent);}
.bg-gray{background:var(--surface2);color:var(--text3);}
.bg-purple{background:var(--purple-l);color:var(--purple);}
.pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:.68rem;font-weight:600;}
.pill-fb{background:#eff6ff;color:#2563eb;}.pill-ig{background:#fdf4ff;color:#9333ea;}.pill-oth{background:var(--surface2);color:var(--text3);}

/* FORMS */
.fg{margin-bottom:12px;}
.fg label{display:block;font-size:.75rem;font-weight:600;color:var(--text2);margin-bottom:5px;}
.fg input,.fg select,.fg textarea{width:100%;padding:10px 12px;background:var(--surface);border:1px solid #d1d9ee;border-radius:var(--r-sm);color:var(--text);font-family:inherit;font-size:.875rem;outline:none;transition:border-color .15s,box-shadow .15s;}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(249,115,22,.12);}
.fg textarea{resize:vertical;min-height:70px;}
.r2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}

/* BTNS */
.btn{width:100%;padding:11px;border-radius:var(--r-sm);border:none;font-family:inherit;font-size:.875rem;font-weight:700;cursor:pointer;transition:all .15s;}
.btn-p{background:var(--accent);color:#fff;}
.btn-p:hover{background:#ea6c10;transform:translateY(-1px);box-shadow:0 4px 12px rgba(249,115,22,.3);}
.btn-d{background:transparent;color:var(--red);border:1px solid #fca5a5;padding:5px 10px;width:auto;font-size:.72rem;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:700;}
.btn-d:hover{background:var(--red-l);}

/* UPLOAD */
.uz{border:2px dashed #d1d9ee;border-radius:var(--r);padding:22px 16px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:10px;}
.uz:hover,.uz.drag{border-color:var(--accent);background:var(--accent-l);}
.uz .ui{font-size:2rem;margin-bottom:8px;}
.uz .ut{font-size:.88rem;font-weight:700;color:var(--text);margin-bottom:3px;}
.uz .us{font-size:.72rem;color:var(--text3);}
.ustat{background:var(--surface2);border-radius:var(--r-sm);padding:12px 14px;border:1px solid var(--border);font-size:.78rem;margin-top:8px;}
.ur{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:.75rem;}
.ur:last-child{border-bottom:none;}

/* TABLE */
.table-wrap{overflow-x:auto;}
table.dt{width:100%;border-collapse:collapse;font-size:.76rem;}
table.dt th{text-align:left;padding:8px 10px;color:var(--text3);font-weight:700;border-bottom:1px solid var(--border);font-size:.65rem;text-transform:uppercase;white-space:nowrap;background:var(--surface2);}
table.dt td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle;}
table.dt tr:last-child td{border-bottom:none;}
table.dt tr:hover td{background:var(--surface2);}
table.dt .num{text-align:right;font-family:'DM Mono',monospace;font-weight:600;font-size:.73rem;}

/* MONTH SELECTOR */
.month-sel{display:flex;gap:6px;flex-wrap:wrap;}
.mb{padding:6px 12px;border-radius:6px;border:1px solid #d1d9ee;background:var(--surface);color:var(--text3);font-family:inherit;font-size:.76rem;font-weight:600;cursor:pointer;transition:all .15s;}
.mb.active{background:var(--accent);color:#fff;border-color:var(--accent);}
.mb:hover:not(.active){border-color:var(--accent);color:var(--accent);}

/* PAYOUT CARD */
.po-card{background:var(--surface2);border-radius:10px;padding:13px;margin-bottom:8px;}
.po-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.po-allocs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;}
.po-alloc{background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:7px 8px;text-align:center;}
.pa-l{font-size:.6rem;color:var(--text3);font-weight:600;margin-bottom:2px;}
.pa-v{font-size:.75rem;font-weight:700;font-family:'DM Mono',monospace;}

/* DEBT LIST */
.dp-item{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);}
.dp-item:last-child{border-bottom:none;}

/* EMPTY */
.empty{text-align:center;padding:36px 20px;color:var(--text3);}
.empty .icon{font-size:2rem;margin-bottom:8px;}
.empty p{font-size:.82rem;font-weight:500;line-height:1.6;}

/* TOAST */
.toast-wrap{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;}
.toast{background:var(--text);color:#fff;padding:10px 20px;border-radius:99px;font-size:.8rem;font-weight:700;box-shadow:var(--shadow-md);opacity:0;transform:translateY(10px);transition:all .3s;}
.toast.show{opacity:1;transform:translateY(0);}
.toast.success{background:var(--green);}.toast.warn{background:var(--yellow);color:var(--text);}.toast.err{background:var(--red);}

code{background:var(--surface2);padding:1px 6px;border-radius:4px;font-family:'DM Mono',monospace;font-size:.78rem;color:var(--accent);}
.sum-table{width:100%;border-collapse:collapse;}
.sum-table th{text-align:left;padding:7px 0;color:var(--text3);font-weight:600;border-bottom:1px solid var(--border);font-size:.68rem;text-transform:uppercase;}
.sum-table td{padding:9px 0;border-bottom:1px solid var(--border);font-size:.82rem;}
.sum-table tr:last-child td{border-bottom:none;}
.sum-table .num{font-family:'DM Mono',monospace;font-weight:700;text-align:right;}
@media(max-width:500px){.metric-grid{grid-template-columns:1fr 1fr;}.pnl-row{grid-template-columns:1fr 1fr;}.r2{grid-template-columns:1fr;}}
`;

// ── SMALL COMPONENTS ─────────────────────────────────────────────
const SBadge = ({s}) => { const m={Selesai:"green",Tertunda:"yellow",Dibatalkan:"red","Belum Dibayar":"blue",Dibayarkan:"green","Menunggu Dibayar":"yellow"}; return <span className={`badge bg-${m[s]||"gray"}`}>{s}</span>; };
const Pill = ({p}) => { const m={Facebook:"fb",Instagram:"ig"}; return <span className={`pill pill-${m[p]||"oth"}`}>{p}</span>; };

const MetricCard = ({icon,iconBg,label,value,valueColor,sub,accent}) => (
  <div className={`metric-card mc-${accent||"green"}`}>
    <div className={`mc-icon bg-${iconBg||"green"}`}>{icon}</div>
    <div className="mc-label">{label}</div>
    <div className={`mc-value ${valueColor||"green"}`}>{value}</div>
    {sub && <div className="mc-sub">{sub}</div>}
  </div>
);

const UploadZone = ({icon,title,sub,onFile,status}) => {
  const [drag,setDrag]=useState(false); const ref=useRef();
  return <div>
    <div className={`uz ${drag?"drag":""}`} onClick={()=>ref.current.click()} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)onFile(f);}}>
      <input type="file" accept=".csv" ref={ref} style={{display:"none"}} onChange={e=>{if(e.target.files[0])onFile(e.target.files[0]);e.target.value="";}}/>
      <div className="ui">{icon}</div><div className="ut">{title}</div><div className="us">{sub}</div>
    </div>
    {status&&<div className="ustat" dangerouslySetInnerHTML={{__html:status}}/>}
  </div>;
};

const PayoutCard = ({p,onDelete}) => (
  <div className="po-card" style={{borderLeft:`3px solid ${p.status==="Dibayarkan"?"var(--green)":"var(--yellow)"}`}}>
    <div className="po-top">
      <div>
        <div style={{fontWeight:800,fontSize:".88rem"}}>{fmtDate(p.terbitDate)||"–"}</div>
        <div style={{fontSize:".68rem",color:"var(--text3)",marginTop:2}}>{p.lapId?`ID: ${p.lapId}`:""}{p.payDate?` · Dibayar: ${fmtDate(p.payDate)}`:""}</div>
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontWeight:800,fontFamily:"'DM Mono',monospace",color:"var(--green)",fontSize:".95rem"}}>{fmtRpFull(p.komisiDibayar)}</div>
        <SBadge s={p.status}/>
      </div>
    </div>
    {p.potonganPajak>0&&<div style={{fontSize:".72rem",color:"var(--text3)",marginBottom:8}}>Pajak: <span style={{color:"var(--red)",fontWeight:700}}>-{fmtRpFull(p.potonganPajak)}</span> · Sebelum pajak: {fmtRpFull(p.komisiSebelumPajak||0)}</div>}
    {p.breakdown?.length>0&&<div style={{background:"var(--surface)",borderRadius:7,padding:"8px 10px",marginBottom:8}}>{p.breakdown.map((b,j)=><div key={j} style={{display:"flex",justifyContent:"space-between",fontSize:".72rem",padding:"3px 0",borderBottom:j<p.breakdown.length-1?"1px solid var(--border)":"none"}}><span style={{color:"var(--text3)"}}>Selesai {fmtDate(b.date)}</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:700}}>{fmtRpFull(b.amount)}</span></div>)}</div>}
    <div className="po-allocs">
      {[["💳 Cicilan 30%",p.cicilan,"var(--red)"],["📣 Modal 50%",p.modal,"var(--blue)"],["🏠 Hidup 20%",p.hidup,"var(--green)"]].map(([l,v,c])=><div key={l} className="po-alloc"><div className="pa-l">{l}</div><div className="pa-v" style={{color:c}}>{fmtRp(v)}</div></div>)}
    </div>
    {onDelete&&<div style={{display:"flex",justifyContent:"flex-end",marginTop:8}}><button className="btn-d" onClick={()=>onDelete(p.id)}>🗑 Hapus</button></div>}
  </div>
);

// ── DAILY BAR CHART ──────────────────────────────────────────────
const DailyChart = ({days,metaByDay,pesananByDay}) => {
  if(!days.length) return <div className="empty"><div className="icon">📊</div><p>Belum ada data untuk grafik.</p></div>;
  const shown = days.slice(0,14).reverse();
  const maxKomisi = Math.max(...shown.map(d=>(pesananByDay[d]||{komisi:0}).komisi),1);
  const maxSpend = Math.max(...shown.map(d=>(metaByDay[d]||{spend:0}).spend),1);
  const maxAll = Math.max(maxKomisi,maxSpend,1);
  return (
    <div>
      <div className="chart-legend" style={{marginBottom:10}}>
        <div className="cl-item"><div className="cl-dot" style={{background:"var(--green2)"}}></div>Komisi</div>
        <div className="cl-item"><div className="cl-dot" style={{background:"var(--blue)"}}></div>Ad Spend</div>
      </div>
      <div className="bar-chart-wrap">
        {shown.map(d=>{
          const k=(pesananByDay[d]||{komisi:0}).komisi;
          const s=(metaByDay[d]||{spend:0}).spend;
          const kH=Math.max((k/maxAll)*100,1);
          const sH=Math.max((s/maxAll)*100,1);
          const dd=d.substring(5);
          return (
            <div className="bar-group" key={d}>
              <div className="bars">
                <div className="bar-item" title={`Komisi: ${fmtRp(k)}`} style={{height:kH+"%",background:"var(--green2)",opacity:.85}}/>
                {s>0&&<div className="bar-item" title={`Spend: ${fmtRp(s)}`} style={{height:sH+"%",background:"var(--blue)",opacity:.7}}/>}
              </div>
              <div className="bg-date">{dd}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── APP ──────────────────────────────────────────────────────────
export default function App() {
  const [tab,setTab]=useState("dashboard");
  const [loading,setLoading]=useState(true);
  const [toasts,setToasts]=useState([]);
  const [metaData,setMetaData]=useState([]);
  const [pesananData,setPesananData]=useState([]);
  const [clicksData,setClicksData]=useState([]);
  const [payouts,setPayouts]=useState([]);
  const [extraDebt,setExtraDebt]=useState([]);
  const [tagMappings,setTagMappings]=useState({});
  const [selectedTags,setSelectedTags]=useState([]);
  const [usMeta,setUsMeta]=useState("");
  const [usPesanan,setUsPesanan]=useState("");
  const [usClicks,setUsClicks]=useState("");
  const [pasteText,setPasteText]=useState("");
  const [pasteResult,setPasteResult]=useState(null);
  const [extraAmt,setExtraAmt]=useState("");
  const [extraNote,setExtraNote]=useState("");
  const [selectedMonth,setSelectedMonth]=useState("");
  const [fStatus,setFStatus]=useState("");
  const [fPlatform,setFPlatform]=useState("");
  const [fTag,setFTag]=useState("");
  const [fDay,setFDay]=useState("");
  // Dashboard filters
  const [dateFilter,setDateFilter]=useState("all");
  const [dateFrom,setDateFrom]=useState("");
  const [dateTo,setDateTo]=useState("");
  const [platFilter,setPlatFilter]=useState("");

  const showToast=useCallback((msg,type="success")=>{ const id=Date.now(); setToasts(t=>[...t,{id,msg,type}]); setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),3000); },[]);

  useEffect(()=>{
    (async()=>{
      setLoading(true);
      const[m,p,c,po,ed,tm]=await Promise.all([dataGet("meta"),dataGet("pesanan"),dataGet("clicks"),dataGet("payouts"),dataGet("extraDebt"),dataGet("tagMappings")]);
      setMetaData(m);setPesananData(p);setClicksData(c);setPayouts(po);setExtraDebt(ed);
      setTagMappings(tm[0]||{});
      setLoading(false);
    })();
  },[]);

  // ── DATE FILTER HELPER ────────────────────────────────────────
  const inDateRange = (iso) => {
    if(!iso||dateFilter==="all") return true;
    const d=dateOnly(iso);
    if(dateFilter==="today") return d===today();
    if(dateFilter==="yesterday") return d===daysAgo(1);
    if(dateFilter==="7d") return d>=daysAgo(6);
    if(dateFilter==="30d") return d>=daysAgo(29);
    if(dateFilter==="range"){
      if(dateFrom&&dateTo) return d>=dateFrom&&d<=dateTo;
      if(dateFrom) return d>=dateFrom;
      if(dateTo) return d<=dateTo;
      return true;
    }
    return true;
  };

  // ── FILTERED DATA ─────────────────────────────────────────────
  const filtMeta = metaData.filter(r=>inDateRange(r["Awal pelaporan"])&&(!platFilter));
  const filtPesanan = pesananData.filter(r=>inDateRange(r["Waktu Pemesanan"])&&(!platFilter||r["Platform"]===platFilter));
  const filtClicks = clicksData.filter(r=>inDateRange(r["Waktu Klik"])&&(!platFilter||r["Perujuk"]===platFilter));

  // ── COMPUTED ─────────────────────────────────────────────────
  const payoutsPaid = payouts.filter(p=>p.status==="Dibayarkan");
  const totalDibayarkan = payoutsPaid.reduce((s,p)=>s+p.komisiDibayar,0);
  const debtPaid = payoutsPaid.reduce((s,p)=>s+p.cicilan,0)+extraDebt.reduce((s,e)=>s+e.amount,0);
  const debtLeft = Math.max(0,DEBT_TOTAL-debtPaid);
  const debtPct = Math.min(100,(debtPaid/DEBT_TOTAL)*100).toFixed(1);

  const totalSpend = filtMeta.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
  const komisiKotor = filtPesanan.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
  const komisiSelesai = filtPesanan.filter(r=>r["Status Pesanan"]==="Selesai").reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
  const totalKliks = filtClicks.length;
  const profitBersih = komisiKotor - totalSpend;
  const roas = totalSpend>0?(komisiKotor/totalSpend).toFixed(2):null;
  const roi = totalSpend>0?((profitBersih/totalSpend)*100).toFixed(1):null;

  const allDays=[...new Set([...metaData.map(r=>dateOnly(r["Awal pelaporan"])),...pesananData.map(r=>dateOnly(r["Waktu Pemesanan"])),...clicksData.map(r=>dateOnly(r["Waktu Klik"]))].filter(Boolean))].sort().reverse();
  const allMonths=[...new Set([...allDays.map(d=>d.substring(0,7)),...payouts.map(p=>monthKey(p.terbitDate))].filter(Boolean))].sort().reverse();
  const allTags=[...new Set(pesananData.map(r=>r["Tag_link1"]).filter(Boolean))];

  const metaByDay={};metaData.filter(r=>inDateRange(r["Awal pelaporan"])).forEach(r=>{const d=dateOnly(r["Awal pelaporan"]);if(!d)return;if(!metaByDay[d])metaByDay[d]={spend:0,clicks:0};metaByDay[d].spend+=parseNum(r["Jumlah yang dibelanjakan (IDR)"]);
    const klikLangsung=parseNum(r["Klik tautan"]);
    if(klikLangsung>0){metaByDay[d].clicks+=klikLangsung;}
    else{const ctrPct=parseNum(r["CTR (rasio klik tayang tautan)"]);const impresi=parseNum(r["Impresi"]);if(ctrPct>0&&impresi>0)metaByDay[d].clicks+=Math.round(ctrPct/100*impresi);}
  });
  const pesananByDay={};filtPesanan.forEach(r=>{const d=dateOnly(r["Waktu Pemesanan"]);if(!d)return;if(!pesananByDay[d])pesananByDay[d]={komisi:0,count:0};pesananByDay[d].komisi+=parseNum(r["Komisi Bersih Affiliate (Rp)"]);pesananByDay[d].count++;});
  const clicksByDay={};filtClicks.forEach(r=>{const d=dateOnly(r["Waktu Klik"]);if(!d)return;clicksByDay[d]=(clicksByDay[d]||0)+1;});
  const byPlatform={};filtPesanan.forEach(r=>{const p=r["Platform"]||"Others";if(!byPlatform[p])byPlatform[p]={count:0,komisi:0};byPlatform[p].count++;byPlatform[p].komisi+=parseNum(r["Komisi Bersih Affiliate (Rp)"]);});

  const filteredDays=[...new Set([...Object.keys(metaByDay),...Object.keys(pesananByDay),...Object.keys(clicksByDay)])].sort().reverse();

  // Monthly
  const activeMonth=selectedMonth||allMonths[0]||"";
  const metaMonth=metaData.filter(r=>monthKey(r["Awal pelaporan"])===activeMonth);
  const pesananMonth=pesananData.filter(r=>monthKey(dateOnly(r["Waktu Pemesanan"]))===activeMonth);
  const clicksMonth=clicksData.filter(r=>monthKey(dateOnly(r["Waktu Klik"]))===activeMonth);
  const payoutsMonth=payouts.filter(p=>monthKey(p.terbitDate)===activeMonth);
  const mSpend=metaMonth.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
  const mKotor=pesananMonth.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
  const mSelesai=pesananMonth.filter(r=>r["Status Pesanan"]==="Selesai").reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
  const mRoas=mSpend>0?(mKotor/mSpend).toFixed(2):null;

  const filteredPesanan=pesananData.filter(r=>{
    if(fStatus&&r["Status Pesanan"]!==fStatus)return false;
    if(fPlatform&&r["Platform"]!==fPlatform)return false;
    if(fTag&&r["Tag_link1"]!==fTag)return false;
    if(fDay&&dateOnly(r["Waktu Pemesanan"])!==fDay)return false;
    return true;
  });

  // ── CSV HANDLERS ─────────────────────────────────────────────
  const handleMeta=async(file)=>{
    setUsMeta(`<div style="font-weight:700">⏳ Membaca ${file.name}...</div>`);
    const rows=parseCSV(await file.text());
    const existing=new Set(metaData.map(r=>r["Awal pelaporan"]+"|"+r["Nama kampanye"]));
    let added=0;
    const news=rows.filter(r=>{const k=r["Awal pelaporan"]+"|"+r["Nama kampanye"];if(!existing.has(k)){added++;return true;}return false;});
    const next=[...metaData,...news];setMetaData(next);await dataSet("meta",next);
    const spend=next.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
    const days=[...new Set(next.map(r=>dateOnly(r["Awal pelaporan"])).filter(Boolean))];
    setUsMeta(`<div style="font-weight:700;color:var(--green)">✅ ${file.name}</div><div class="ur"><span>Baris baru</span><span><strong>${added}</strong></span></div><div class="ur"><span>Total data</span><span><strong>${next.length} baris</strong></span></div><div class="ur"><span>Periode</span><span><strong>${days.length} hari</strong></span></div><div class="ur"><span>Total Spend</span><span><strong>${fmtRpFull(spend)}</strong></span></div>`);
    showToast("✅ Data Meta Ads diupload!");
  };
  const handlePesanan=async(file)=>{
    setUsPesanan(`<div style="font-weight:700">⏳ Membaca ${file.name}...</div>`);
    const rows=parseCSV(await file.text());
    const existing=new Set(pesananData.map(r=>r["ID Pemesanan"]+"|"+r["ID Barang"]));
    let added=0;
    const news=rows.filter(r=>{const k=r["ID Pemesanan"]+"|"+r["ID Barang"];if(!existing.has(k)){added++;return true;}return false;});
    const next=[...pesananData,...news];setPesananData(next);await dataSet("pesanan",next);
    const komisi=next.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
    const days=[...new Set(next.map(r=>dateOnly(r["Waktu Pemesanan"])).filter(Boolean))];
    setUsPesanan(`<div style="font-weight:700;color:var(--green)">✅ ${file.name}</div><div class="ur"><span>Pesanan baru</span><span><strong>${added}</strong></span></div><div class="ur"><span>Total tersimpan</span><span><strong>${next.length}</strong></span></div><div class="ur"><span>Periode</span><span><strong>${days.length} hari</strong></span></div><div class="ur"><span>Komisi Kotor</span><span><strong>${fmtRpFull(komisi)}</strong></span></div>`);
    showToast("✅ Laporan Pesanan diupload!");
  };
  const handleClicks=async(file)=>{
    setUsClicks(`<div style="font-weight:700">⏳ Membaca ${file.name}...</div>`);
    const rows=parseCSV(await file.text());
    const existing=new Set(clicksData.map(r=>r["Klik ID"]));
    let added=0;
    const news=rows.filter(r=>{if(!existing.has(r["Klik ID"])){added++;return true;}return false;});
    const next=[...clicksData,...news];setClicksData(next);await dataSet("clicks",next);
    const byP=next.reduce((acc,r)=>{const p=r["Perujuk"]||"Others";acc[p]=(acc[p]||0)+1;return acc;},{});
    const platRows=Object.entries(byP).map(([p,c])=>`<div class="ur"><span>${p}</span><span><strong>${c.toLocaleString("id-ID")}</strong></span></div>`).join("");
    setUsClicks(`<div style="font-weight:700;color:var(--green)">✅ ${file.name}</div><div class="ur"><span>Klik baru</span><span><strong>${added}</strong></span></div><div class="ur"><span>Total tersimpan</span><span><strong>${next.length.toLocaleString("id-ID")}</strong></span></div>${platRows}`);
    showToast("✅ Shopee Clicks diupload!");
  };

  const handlePaste=()=>{
    if(!pasteText.trim()){showToast("Tempelkan data dulu!","warn");return;}
    const parsed=parsePayoutPaste(pasteText);
    if(!parsed.length){showToast("Data tidak terbaca. Coba copy ulang.","err");return;}
    setPasteResult(parsed);showToast(`✅ Terbaca ${parsed.length} laporan!`);
  };
  const confirmPaste=async()=>{
    if(!pasteResult?.length)return;
    const existing=new Set(payouts.map(p=>p.id));
    const news=pasteResult.filter(p=>!existing.has(p.id));
    if(!news.length){showToast("Semua sudah tersimpan.","warn");return;}
    const next=[...news,...payouts].sort((a,b)=>b.terbitDate.localeCompare(a.terbitDate));
    setPayouts(next);await dataSet("payouts",next);
    setPasteText("");setPasteResult(null);
    showToast(`✅ ${news.length} laporan disimpan!`);
  };
  const deletePayout=async(id)=>{const next=payouts.filter(p=>p.id!==id);setPayouts(next);await dataSet("payouts",next);showToast("Dihapus","warn");};
  const saveTagMappings=async(newMappings)=>{
    setTagMappings(newMappings);
    await dataSet("tagMappings",[newMappings]);
  };

  const addExtraDebtFn=async()=>{
    const amt=parseFloat(extraAmt);if(!amt||amt<=0){showToast("Masukkan jumlah!","warn");return;}
    const next=[...extraDebt,{id:Date.now().toString(),date:new Date().toISOString().substring(0,10),amount:amt,note:extraNote}];
    setExtraDebt(next);await dataSet("extraDebt",next);setExtraAmt("");setExtraNote("");showToast("✅ Cicilan dicatat!");
  };

  const DATE_FILTERS=[{k:"today",l:"Hari Ini"},{k:"yesterday",l:"Kemarin"},{k:"7d",l:"7 Hari"},{k:"30d",l:"30 Hari"},{k:"range",l:"📅 Pilih Range"},{k:"all",l:"Semua"}];
  const TABS=[{id:"dashboard",label:"📊 Dashboard"},{id:"pembayaran",label:"💰 Lap. Pembayaran"},{id:"upload",label:"📂 Upload CSV"},{id:"perhari",label:"📆 Per Hari"},{id:"tagperforma",label:"🏷️ Tag Performa"},{id:"pesanan",label:"🧾 Pesanan"},{id:"kampanye",label:"📣 Kampanye"},{id:"monthly",label:"📅 Bulanan"},{id:"debt",label:"💳 Hutang"}];

  if(loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",flexDirection:"column",gap:12,color:"#94a3b8",fontFamily:"'Plus Jakarta Sans',sans-serif"}}><div style={{fontSize:"2.5rem"}}>🛍️</div><div style={{fontWeight:700,fontSize:".95rem"}}>Memuat data...</div></div>;

  return (
    <div className="app">
      <style>{css}</style>
      <header>
        <div className="hdr">
          <div className="logo">
            <div className="logo-mark">🛍️</div>
            <div><h1>Afisaku</h1><span>Shopee Affiliate Tracker</span></div>
          </div>
          <div className="hdr-right">
            <div className="hdr-stat"><div className="hl">Komisi Kotor</div><div className="hv" style={{color:"var(--green)"}}>{fmtRp(pesananData.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0))}</div></div>
            <div className="hdr-stat"><div className="hl">Sisa Hutang</div><div className="hv" style={{color:"var(--accent)"}}>{fmtRpFull(debtLeft)}</div></div>
          </div>
        </div>
      </header>
      <nav>{TABS.map(t=><button key={t.id} className={`nb ${tab===t.id?"active":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>)}</nav>
      <main>

        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && <>
          {/* Filter bar */}
          <div className="dash-filter">
            <div className="dash-filter-title">Ringkasan Performa</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              <div className="filter-pills">
                {DATE_FILTERS.map(f=><button key={f.k} className={`fp ${dateFilter===f.k?"active":""}`} onClick={()=>setDateFilter(f.k)}>{f.l}</button>)}
              </div>
              {dateFilter==="range" && (
                <div style={{display:"flex",alignItems:"center",gap:6,background:"var(--surface)",border:"1px solid var(--border)",borderRadius:99,padding:"4px 12px"}}>
                  <input type="date" value={dateFrom} max={dateTo||today()}
                    onChange={e=>setDateFrom(e.target.value)}
                    style={{border:"none",background:"transparent",color:"var(--text)",fontFamily:"inherit",fontSize:".75rem",fontWeight:600,outline:"none",cursor:"pointer",width:120}}
                  />
                  <span style={{color:"var(--text3)",fontWeight:700,fontSize:".75rem"}}>→</span>
                  <input type="date" value={dateTo} min={dateFrom} max={today()}
                    onChange={e=>setDateTo(e.target.value)}
                    style={{border:"none",background:"transparent",color:"var(--text)",fontFamily:"inherit",fontSize:".75rem",fontWeight:600,outline:"none",cursor:"pointer",width:120}}
                  />
                </div>
              )}
              <select className="plat-select" value={platFilter} onChange={e=>setPlatFilter(e.target.value)}>
                <option value="">Semua Platform</option>
                <option value="Facebook">Facebook</option>
                <option value="Instagram">Instagram</option>
                <option value="Others">Others</option>
              </select>
            </div>
          </div>
          {/* Active filter label */}
          {dateFilter!=="all" && (
            <div style={{fontSize:".74rem",color:"var(--text3)",fontWeight:600,marginBottom:10,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              <span>📋 Menampilkan:</span>
              <span style={{background:"var(--accent-l)",color:"var(--accent)",padding:"2px 10px",borderRadius:99,fontWeight:700}}>
                {dateFilter==="today"?"Hari Ini ("+today()+")":
                 dateFilter==="yesterday"?"Kemarin ("+daysAgo(1)+")":
                 dateFilter==="7d"?"7 Hari Terakhir":
                 dateFilter==="30d"?"30 Hari Terakhir":
                 dateFilter==="range"?(dateFrom||dateTo)?(dateFrom||"...")+(" → ")+(dateTo||"..."):"Pilih rentang tanggal":""}
              </span>
              <button onClick={()=>{setDateFilter("all");setDateFrom("");setDateTo("");}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--text3)",fontSize:".72rem",fontWeight:600}}>✕ Reset</button>
            </div>
          )}

          {/* Metric cards */}
          <div className="metric-grid">
            <MetricCard icon="🖱️" iconBg="blue" label="Total Shopee Clicks" value={totalKliks.toLocaleString("id-ID")} valueColor="blue" sub={`${filtClicks.filter(r=>r["Perujuk"]==="Facebook").length.toLocaleString("id-ID")} dari Facebook`} accent="blue"/>
            <MetricCard icon="🛒" iconBg="purple" label="Total Pesanan" value={filtPesanan.length.toLocaleString("id-ID")} valueColor="purple" sub={`${filtPesanan.filter(r=>r["Status Pesanan"]==="Selesai").length} selesai`} accent="purple"/>
            <MetricCard icon="💰" iconBg="green" label="Total Komisi Kotor" value={fmtRp(komisiKotor)} valueColor="green" sub={`Selesai: ${fmtRp(komisiSelesai)}`} accent="green"/>
            <MetricCard icon="📈" iconBg="red" label="Ad Spend Meta" value={fmtRp(totalSpend)} valueColor="red" sub={`${[...new Set(filtMeta.map(r=>r["Nama kampanye"]))].filter(Boolean).length} kampanye`} accent="red"/>
          </div>

          {/* Profit & ROAS row */}
          <div className="pnl-row">
            <div className="pnl-card">
              <div className="pnl-label">💹 Profit Bersih</div>
              <div className={`pnl-value ${profitBersih>=0?"green":"red"}`}>{fmtRp(profitBersih)}</div>
            </div>
            <div className="pnl-card">
              <div className="pnl-label">🎯 ROI</div>
              <div className={`pnl-value ${parseFloat(roi)>=0?"green":"red"}`}>{roi?roi+"%":"–"}</div>
            </div>
            <div className="pnl-card">
              <div className="pnl-label">📊 ROAS</div>
              <div className={`pnl-value ${parseFloat(roas)>=1?"orange":"red"}`}>{roas?roas+"x":"–"}</div>
            </div>
          </div>

          {/* Debt progress */}
          <div className="debt-card">
            <div className="debt-header">
              <div className="debt-title">🏦 Progress Pelunasan Hutang</div>
              <div className="debt-pct">{debtPct}%</div>
            </div>
            <div className="debt-track"><div className="debt-fill" style={{width:debtPct+"%"}}/></div>
            <div className="debt-nums">
              <span>Terbayar: <strong style={{color:"var(--green)"}}>{fmtRpFull(debtPaid)}</strong></span>
              <span>Sisa: <strong style={{color:"var(--accent)"}}>{fmtRpFull(debtLeft)}</strong></span>
            </div>
          </div>

          {/* Daily chart */}
          <div className="chart-card">
            <div className="chart-header">
              <div className="chart-title">📈 Grafik Komisi vs Ad Spend (Harian)</div>
            </div>
            <DailyChart days={filteredDays} metaByDay={metaByDay} pesananByDay={pesananByDay}/>
          </div>

          {/* Platform breakdown */}
          {Object.keys(byPlatform).length>0 && <div className="card">
            <div className="ct">Komisi per Platform</div>
            {Object.entries(byPlatform).sort((a,b)=>b[1].komisi-a[1].komisi).map(([p,d])=>{
              const pct=komisiKotor>0?((d.komisi/komisiKotor)*100).toFixed(1):0;
              return <div key={p} style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}><Pill p={p}/><span style={{fontSize:".76rem",color:"var(--text3)"}}>{d.count} pesanan</span></div>
                  <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:".85rem",color:"var(--green)"}}>{fmtRp(d.komisi)} <span style={{fontSize:".68rem",color:"var(--text3)",fontWeight:500}}>({pct}%)</span></span>
                </div>
                <div style={{height:6,background:"var(--surface2)",borderRadius:99,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"var(--green2)",borderRadius:99}}/></div>
              </div>;
            })}
          </div>}

          {pesananData.length===0&&metaData.length===0 && <div className="empty"><div className="icon">💸</div><p>Belum ada data.<br/>Upload CSV atau paste Laporan Pembayaran untuk mulai.</p></div>}
        </>}

        {/* ══ LAPORAN PEMBAYARAN ══ */}
        {tab==="pembayaran" && <>
          {payouts.length>0 && (()=>{
            const totalPajak=payoutsPaid.reduce((s,p)=>s+(p.potonganPajak||0),0);
            const menunggu=payouts.filter(p=>p.status==="Menunggu Dibayar");
            return <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              {[["💰 Total Dibayarkan",fmtRp(totalDibayarkan),"green",payoutsPaid.length+" laporan"],["🧾 Potongan Pajak",fmtRp(totalPajak),"red","dipotong Shopee"],["💳 Cicilan Hutang (30%)",fmtRp(payoutsPaid.reduce((s,p)=>s+p.cicilan,0)),"orange",""],["⏳ Menunggu Dibayar",fmtRp(menunggu.reduce((s,p)=>s+p.komisiDibayar,0)),"yellow",menunggu.length+" laporan"]].map(([l,v,c,s])=><div key={l} className="card" style={{marginBottom:0}}><div style={{fontSize:".68rem",color:"var(--text3)",fontWeight:600,marginBottom:6}}>{l}</div><div style={{fontSize:"1.1rem",fontWeight:800,color:`var(--${c})`}}>{v}</div>{s&&<div style={{fontSize:".68rem",color:"var(--text3)",marginTop:4}}>{s}</div>}</div>)}
            </div>;
          })()}

          <div className="card">
            <div className="ct">📋 Paste dari Shopee</div>
            <div style={{background:"var(--blue-l)",border:"1px solid #bfdbfe",borderRadius:10,padding:"12px 14px",marginBottom:14,fontSize:".78rem",color:"#1e40af",lineHeight:1.7}}>
              <strong>Cara copy data dari Shopee:</strong><br/>
              1. Buka <strong>Laporan Pembayaran</strong> di affiliate.shopee.co.id/payment/payout_record<br/>
              2. Select semua teks (Ctrl+A) → Copy (Ctrl+C) → Paste di bawah ini<br/>
              💡 <em>Bisa dari halaman list atau halaman detail payout</em>
            </div>
            <div className="fg">
              <label>Tempelkan teks dari Shopee</label>
              <textarea placeholder={"07-06-2026   11346911751260607   Rp793.564   Menunggu Dibayar   --\n03-06-2026   11346911751260603   Rp1.041.691   Dibayarkan   05-06-2026 16:06"} value={pasteText} onChange={e=>{setPasteText(e.target.value);setPasteResult(null);}} style={{minHeight:120,fontFamily:"'DM Mono',monospace",fontSize:".75rem"}}/>
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
          {payouts.length===0&&!pasteResult&&<div className="empty"><div className="icon">💰</div><p>Belum ada laporan pembayaran.<br/>Paste data dari Shopee di atas.</p></div>}
        </>}

        {/* ══ UPLOAD CSV ══ */}
        {tab==="upload" && <>
          {[
            {key:"meta",title:"📈 Data Meta Ads",icon:"📈",sub:"Export dari Facebook Ads Manager • Breakdown by Day",data:metaData,setData:setMetaData,status:usMeta,setStatus:setUsMeta,handler:handleMeta,label:"Meta Ads",dateKey:"Awal pelaporan"},
            {key:"pesanan",title:"🧾 Laporan Pesanan Affiliate",icon:"🧾",sub:"AffiliateCommissionReport dari Shopee Affiliate",data:pesananData,setData:setPesananData,status:usPesanan,setStatus:setUsPesanan,handler:handlePesanan,label:"Pesanan",dateKey:"Waktu Pemesanan"},
            {key:"clicks",title:"🖱️ Shopee Clicks",icon:"🖱️",sub:"WebsiteClickReport dari Shopee Affiliate",data:clicksData,setData:setClicksData,status:usClicks,setStatus:setUsClicks,handler:handleClicks,label:"Clicks",dateKey:"Waktu Klik"},
          ].map(item=>{
            // Get unique dates for this data
            const itemDays=[...new Set(item.data.map(r=>dateOnly(r[item.dateKey])).filter(Boolean))].sort().reverse();
            const countByDay=itemDays.reduce((acc,d)=>{acc[d]=item.data.filter(r=>dateOnly(r[item.dateKey])===d).length;return acc;},{});
            return (
              <div className="card" key={item.key}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div className="ct" style={{marginBottom:0}}>{item.title}</div>
                  {item.data.length>0 && (
                    <button className="btn-d" onClick={async()=>{
                      if(!confirm(`Hapus SEMUA data ${item.label}? (${item.data.length.toLocaleString("id-ID")} baris)`))return;
                      item.setData([]);item.setStatus("");await dataSet(item.key,[]);
                      showToast(`Semua data ${item.label} dihapus`,"warn");
                    }}>🗑 Hapus Semua ({item.data.length.toLocaleString("id-ID")})</button>
                  )}
                </div>

                {/* Per-date breakdown with delete per day */}
                {itemDays.length>0 && (
                  <div style={{background:"var(--surface2)",borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                    <div style={{fontSize:".68rem",fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".5px",marginBottom:8}}>Data tersimpan per tanggal</div>
                    <div style={{maxHeight:160,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
                      {itemDays.map(d=>(
                        <div key={d} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 8px",background:"var(--surface)",borderRadius:7,border:"1px solid var(--border)"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:".76rem",fontWeight:700}}>{fmtDate(d)}</span>
                            <span className="badge bg-blue" style={{fontSize:".62rem"}}>{countByDay[d].toLocaleString("id-ID")} baris</span>
                          </div>
                          <button onClick={async()=>{
                            if(!confirm(`Hapus data ${item.label} tanggal ${fmtDate(d)}? (${countByDay[d]} baris)`))return;
                            const next=item.data.filter(r=>dateOnly(r[item.dateKey])!==d);
                            item.setData(next);await dataSet(item.key,next);
                            showToast(`Data ${fmtDate(d)} dihapus`,"warn");
                          }} style={{background:"none",border:"1px solid #fca5a5",borderRadius:5,padding:"3px 8px",color:"var(--red)",fontSize:".68rem",fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                            🗑
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <UploadZone icon={item.icon} title={`Upload ${item.label} (CSV)`} sub={item.sub} onFile={item.handler} status={item.status}/>
              </div>
            );
          })}
          <div className="card" style={{borderColor:"#fed7aa"}}>
            <div className="ct">ℹ️ Catatan</div>
            <p style={{fontSize:".8rem",color:"var(--text2)",lineHeight:1.7}}>
              • Upload berulang aman — duplikat otomatis dilewati<br/>
              • 🗑 <strong>Hapus per tanggal</strong> — hapus data hari tertentu yang salah tanpa ganggu data hari lain<br/>
              • 🗑 <strong>Hapus Semua</strong> — reset seluruh data jenis tersebut<br/>
              • Data langsung tersimpan ke Firebase — tim bisa lihat real-time
            </p>
          </div>
        </>}

        {/* ══ PER HARI ══ */}
        {tab==="perhari" && (()=>{
          const phMetaByDay={};
          metaData.forEach(r=>{const d=dateOnly(r["Awal pelaporan"]);if(!d)return;if(!phMetaByDay[d])phMetaByDay[d]={spend:0,clicks:0};phMetaByDay[d].spend+=parseNum(r["Jumlah yang dibelanjakan (IDR)"]);
            const kl=parseNum(r["Klik tautan"]);
            if(kl>0)phMetaByDay[d].clicks+=kl;
            else{const ct=parseNum(r["CTR (rasio klik tayang tautan)"]);const im=parseNum(r["Impresi"]);if(ct>0&&im>0)phMetaByDay[d].clicks+=Math.round(ct/100*im);}
          });
          const phPesananByDay={};
          pesananData.forEach(r=>{const d=dateOnly(r["Waktu Pemesanan"]);if(!d)return;if(!phPesananByDay[d])phPesananByDay[d]={komisi:0,count:0};phPesananByDay[d].komisi+=parseNum(r["Komisi Bersih Affiliate (Rp)"]);phPesananByDay[d].count++;});
          const phClicksByDay={};
          clicksData.forEach(r=>{const d=dateOnly(r["Waktu Klik"]);if(!d)return;phClicksByDay[d]=(phClicksByDay[d]||0)+1;});
          const phAllDays=[...new Set([...Object.keys(phMetaByDay),...Object.keys(phPesananByDay),...Object.keys(phClicksByDay)])].sort().reverse();
          return <>
          <div className="card">
            <div className="ct">Ringkasan Harian — Semua Data</div>
            {phAllDays.length===0?<div className="empty"><div className="icon">📆</div><p>Upload CSV untuk melihat data per hari.</p></div>:
            <div className="table-wrap">
              <table className="dt">
                <thead><tr>
                  <th>Tanggal</th><th>Spend</th><th>Klik Meta</th><th>CPC</th>
                  <th>Klik Shopee</th><th>CTR Meta→Shopee</th><th>Pesanan</th>
                  <th>Komisi Kotor</th><th>Komisi Bersih</th><th>ROAS</th>
                </tr></thead>
                <tbody>{phAllDays.map(d=>{
                  const m=phMetaByDay[d]||{spend:0,clicks:0};
                  const c=phClicksByDay[d]||0;
                  const p=phPesananByDay[d]||{komisi:0,count:0};
                  const dr=m.spend>0?(p.komisi/m.spend).toFixed(2):null;
                  const cpc=m.clicks>0?Math.round(m.spend/m.clicks):null;
                  const ctr=m.clicks>0?((c/m.clicks)*100).toFixed(1):null;
                  // Komisi Bersih = Komisi Kotor - Spend Meta
                  const kb=p.komisi - m.spend;
                  return <tr key={d}>
                    <td style={{fontWeight:700,whiteSpace:"nowrap",fontSize:".76rem"}}>{fmtDate(d)}</td>
                    <td className="num" style={{color:"var(--red)"}}>{m.spend>0?fmtRp(m.spend):"-"}</td>
                    <td className="num">{m.clicks>0?m.clicks.toLocaleString("id-ID"):"-"}</td>
                    <td className="num" style={{color:"var(--yellow)"}}>{cpc!==null?fmtRp(cpc):"-"}</td>
                    <td className="num" style={{color:"var(--blue)"}}>{c>0?c.toLocaleString("id-ID"):"-"}</td>
                    <td className="num">{ctr!==null?<span className={`badge ${parseFloat(ctr)>=50?"bg-green":parseFloat(ctr)>=20?"bg-yellow":"bg-red"}`}>{ctr}%</span>:"-"}</td>
                    <td className="num">{p.count>0?p.count:"-"}</td>
                    <td className="num" style={{color:"var(--green)"}}>{p.komisi>0?fmtRp(p.komisi):"-"}</td>
                    <td className="num" style={{color:kb>=0?"var(--green)":"var(--red)",fontWeight:700}}>{p.komisi>0?fmtRp(kb):"-"}</td>
                    <td className="num">{dr?<span className={`badge ${parseFloat(dr)>=1?"bg-green":"bg-red"}`}>{dr}x</span>:"-"}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
          </div>
          <div className="card" style={{borderColor:"#e0e9ff"}}>
            <div className="ct">ℹ️ Keterangan Metrik</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[["CPC","Spend ÷ Klik Meta"],["CTR Meta→Shopee","Klik Shopee ÷ Klik Meta × 100"],["Komisi Kotor","Total komisi dari semua pesanan"],["Komisi Bersih","Komisi Kotor − Spend Meta Ads"],["CTR ≥ 50%","🟢 Konversi klik sangat baik"],["CTR < 20%","🔴 Perlu evaluasi targeting"]].map(([k,v])=><div key={k} style={{padding:"8px 10px",background:"var(--surface2)",borderRadius:8,fontSize:".76rem"}}><div style={{fontWeight:700,fontSize:".7rem",marginBottom:3}}>{k}</div><div style={{color:"var(--text3)",fontSize:".68rem"}}>{v}</div></div>)}
            </div>
          </div>
          </>;
        })()}

        {/* ══ TAG PERFORMA ══ */}
        {tab==="tagperforma" && (()=>{
          const allTagsList=[...new Set(pesananData.map(r=>r["Tag_link1"]).filter(Boolean))].sort();
          const allCampaigns=[...new Set(metaData.map(r=>r["Nama kampanye"]).filter(Boolean))].sort();
          const activeTags=selectedTags.length>0?selectedTags:[];

          const computeTagStats=(tag)=>{
            const tagPesanan=pesananData.filter(r=>r["Tag_link1"]===tag);
            const tagClicks=clicksData.filter(r=>r["Tag_link"]===tag);
            const linkedCampaigns=tagMappings[tag]||[];
            const tagMeta=metaData.filter(r=>linkedCampaigns.includes(r["Nama kampanye"]));
            const spend=tagMeta.reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
            let metaClicks=0;
            tagMeta.forEach(r=>{const kl=parseNum(r["Klik tautan"]);if(kl>0)metaClicks+=kl;else{const ct=parseNum(r["CTR (rasio klik tayang tautan)"]);const im=parseNum(r["Impresi"]);if(ct>0&&im>0)metaClicks+=Math.round(ct/100*im);}});
            const komisi=tagPesanan.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
            const pesananCount=tagPesanan.length;
            const selesaiCount=tagPesanan.filter(r=>r["Status Pesanan"]==="Selesai").length;
            const shopeeClicks=tagClicks.length;
            const roas=spend>0?(komisi/spend).toFixed(2):null;
            const profit=komisi-spend;
            const roi=spend>0?((profit/spend)*100).toFixed(1):null;
            const ctr=metaClicks>0?((shopeeClicks/metaClicks)*100).toFixed(1):null;
            const rateShopee=shopeeClicks>0?((pesananCount/shopeeClicks)*100).toFixed(2):null;
            const rateOrder=pesananCount>0?((selesaiCount/pesananCount)*100).toFixed(1):null;

            // Daily breakdown for ROAS chart
            const allDaysTag=[...new Set([
              ...tagMeta.map(r=>dateOnly(r["Awal pelaporan"])),
              ...tagPesanan.map(r=>dateOnly(r["Waktu Pemesanan"]))
            ].filter(Boolean))].sort();

            const dailyData=allDaysTag.map(d=>{
              const dSpend=tagMeta.filter(r=>dateOnly(r["Awal pelaporan"])===d).reduce((s,r)=>s+parseNum(r["Jumlah yang dibelanjakan (IDR)"]),0);
              const dKomisi=tagPesanan.filter(r=>dateOnly(r["Waktu Pemesanan"])===d).reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
              const dClicks=tagClicks.filter(r=>dateOnly(r["Waktu Klik"])===d).length;
              const dPesanan=tagPesanan.filter(r=>dateOnly(r["Waktu Pemesanan"])===d).length;
              const dRoas=dSpend>0?(dKomisi/dSpend).toFixed(2):null;
              const dProfit=dKomisi-dSpend;
              return {d,dSpend,dKomisi,dClicks,dPesanan,dRoas,dProfit};
            });

            return {tag,pesananCount,selesaiCount,shopeeClicks,metaClicks,spend,komisi,profit,roas,roi,ctr,rateShopee,rateOrder,linkedCampaigns,dailyData};
          };

          return <>
            {/* Tag selector card */}
            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div className="ct" style={{marginBottom:0}}>🏷️ Pilih Tag untuk Dievaluasi</div>
                <span className="badge bg-orange">{allTagsList.length} tag tersedia</span>
              </div>
              <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:12}}>
                {allTagsList.map(tag=>(
                  <button key={tag} onClick={()=>setSelectedTags(prev=>prev.includes(tag)?prev.filter(t=>t!==tag):[...prev,tag])}
                    style={{padding:"6px 14px",borderRadius:99,border:"1px solid var(--border)",fontFamily:"inherit",fontSize:".76rem",fontWeight:700,cursor:"pointer",transition:"all .15s",
                      background:selectedTags.includes(tag)?"var(--accent)":"var(--surface)",
                      color:selectedTags.includes(tag)?"#fff":"var(--text2)",
                      borderColor:selectedTags.includes(tag)?"var(--accent)":"var(--border)"}}>
                    #{tag}
                  </button>
                ))}
              </div>
              {selectedTags.length>0&&<div style={{display:"flex",gap:8,alignItems:"center"}}>
                <span style={{fontSize:".74rem",color:"var(--text3)"}}>Dipilih: <strong style={{color:"var(--accent)"}}>{selectedTags.length} tag</strong></span>
                <button onClick={()=>setSelectedTags([])} style={{background:"none",border:"1px solid var(--border)",borderRadius:6,padding:"3px 10px",fontSize:".72rem",fontWeight:700,cursor:"pointer",color:"var(--text3)",fontFamily:"inherit"}}>✕ Reset</button>
              </div>}
              {selectedTags.length===0&&<p style={{fontSize:".78rem",color:"var(--text3)"}}>Klik tag di atas untuk mulai evaluasi. Bisa pilih lebih dari satu.</p>}
            </div>

            {/* Per-tag detail cards */}
            {activeTags.map(tag=>{
              const ts=computeTagStats(tag);
              const maxRoas=Math.max(...ts.dailyData.filter(d=>d.dRoas).map(d=>parseFloat(d.dRoas)),1);
              const maxKomisi=Math.max(...ts.dailyData.map(d=>d.dKomisi),1);
              const maxSpend=Math.max(...ts.dailyData.map(d=>d.dSpend),1);
              const maxAll=Math.max(maxKomisi,maxSpend,1);
              return (
                <div key={tag} style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:14,padding:16,marginBottom:12,boxShadow:"var(--shadow)"}}>
                  {/* Header */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                    <div>
                      <div style={{fontWeight:800,fontSize:"1.1rem",color:"var(--accent)"}}>#{ts.tag}</div>
                      <div style={{fontSize:".72rem",color:"var(--text3)",marginTop:3}}>{ts.pesananCount} pesanan · {ts.selesaiCount} selesai</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      {ts.roas?<div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:"1.4rem",color:parseFloat(ts.roas)>=1?"var(--green)":"var(--red)"}}>{ts.roas}x</div>:<div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:"1.2rem",color:"var(--text3)"}}>–</div>}
                      <div style={{fontSize:".65rem",color:"var(--text3)"}}>ROAS Total</div>
                    </div>
                  </div>

                  {/* Metrics */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
                    {[["Klik Shopee",ts.shopeeClicks.toLocaleString("id-ID"),"var(--blue)"],["Pesanan",ts.pesananCount,"var(--purple)"],["Komisi Kotor",fmtRp(ts.komisi),"var(--green)"],["Ad Spend",ts.spend>0?fmtRp(ts.spend):"-","var(--red)"],["Profit Bersih",ts.spend>0?fmtRp(ts.profit):"-",ts.profit>=0?"var(--green)":"var(--red)"],["ROI",ts.roi?ts.roi+"%":"-",parseFloat(ts.roi)>=0?"var(--green)":"var(--red)"]].map(([l,v,c])=>(
                      <div key={l} style={{background:"var(--surface2)",borderRadius:9,padding:"9px 10px",textAlign:"center"}}>
                        <div style={{fontSize:".62rem",color:"var(--text3)",fontWeight:600,marginBottom:3}}>{l}</div>
                        <div style={{fontWeight:800,fontSize:".88rem",color:c,fontFamily:"'DM Mono',monospace"}}>{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Rate badges */}
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
                    {ts.ctr&&<span className={`badge ${parseFloat(ts.ctr)>=50?"bg-green":parseFloat(ts.ctr)>=20?"bg-yellow":"bg-red"}`}>CTR Meta→Shopee: {ts.ctr}%</span>}
                    {ts.rateShopee&&<span className="badge bg-blue">Klik→Order: {ts.rateShopee}%</span>}
                    {ts.rateOrder&&<span className={`badge ${parseFloat(ts.rateOrder)>=70?"bg-green":"bg-yellow"}`}>Order Selesai: {ts.rateOrder}%</span>}
                  </div>

                  {/* Daily ROAS chart */}
                  {ts.dailyData.length>0&&<>
                    <div style={{fontSize:".74rem",fontWeight:700,color:"var(--text2)",marginBottom:10}}>📈 Tren Harian — Komisi vs Spend & ROAS</div>

                    {/* Bar chart komisi vs spend */}
                    <div style={{display:"flex",gap:4,alignItems:"flex-end",height:90,marginBottom:4,overflowX:"auto",paddingBottom:4}}>
                      {ts.dailyData.map(({d,dSpend,dKomisi,dRoas})=>{
                        const kH=dKomisi>0?Math.max((dKomisi/maxAll)*80,3):0;
                        const sH=dSpend>0?Math.max((dSpend/maxAll)*80,3):0;
                        const isPos=dRoas&&parseFloat(dRoas)>=1;
                        return (
                          <div key={d} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,minWidth:32,flex:1}} title={`${d}\nKomisi: ${fmtRp(dKomisi)}\nSpend: ${fmtRp(dSpend)}\nROAS: ${dRoas||"-"}x`}>
                            <div style={{display:"flex",gap:2,alignItems:"flex-end",height:80}}>
                              {dKomisi>0&&<div style={{width:12,height:kH,background:"var(--green2)",borderRadius:"3px 3px 0 0",opacity:.85}}/>}
                              {dSpend>0&&<div style={{width:12,height:sH,background:"var(--red)",borderRadius:"3px 3px 0 0",opacity:.7}}/>}
                            </div>
                            <div style={{fontSize:".55rem",color:"var(--text3)",textAlign:"center",whiteSpace:"nowrap"}}>{d.substring(5)}</div>
                          </div>
                        );
                      })}
                    </div>

                    {/* ROAS per day table */}
                    <div style={{overflowX:"auto",marginTop:8}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:".72rem"}}>
                        <thead>
                          <tr style={{borderBottom:"1px solid var(--border)"}}>
                            {["Tanggal","Spend","Komisi","Klik","Pesanan","ROAS Hari","Profit Hari"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:h==="Tanggal"?"left":"right",color:"var(--text3)",fontWeight:700,fontSize:".62rem",textTransform:"uppercase",letterSpacing:".4px",whiteSpace:"nowrap"}}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {ts.dailyData.map(({d,dSpend,dKomisi,dClicks,dPesanan,dRoas,dProfit})=>(
                            <tr key={d} style={{borderBottom:"1px solid rgba(228,232,242,.5)"}}>
                              <td style={{padding:"6px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{fmtDate(d)}</td>
                              <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"'DM Mono',monospace",color:"var(--red)"}}>{dSpend>0?fmtRp(dSpend):"-"}</td>
                              <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"'DM Mono',monospace",color:"var(--green)"}}>{dKomisi>0?fmtRp(dKomisi):"-"}</td>
                              <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"'DM Mono',monospace",color:"var(--blue)"}}>{dClicks>0?dClicks:"-"}</td>
                              <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"'DM Mono',monospace"}}>{dPesanan>0?dPesanan:"-"}</td>
                              <td style={{padding:"6px 8px",textAlign:"right"}}>
                                {dRoas?<span style={{fontFamily:"'DM Mono',monospace",fontWeight:800,color:parseFloat(dRoas)>=1?"var(--green)":"var(--red)",background:parseFloat(dRoas)>=1?"var(--green-l)":"var(--red-l)",padding:"2px 7px",borderRadius:99,fontSize:".7rem"}}>{dRoas}x</span>:"-"}
                              </td>
                              <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontWeight:700,color:dProfit>=0?"var(--green)":"var(--red)"}}>{dSpend>0?fmtRp(dProfit):"-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>}

                  {/* Campaign mapping */}
                  <div style={{borderTop:"1px solid var(--border)",paddingTop:12,marginTop:14}}>
                    <div style={{fontSize:".7rem",fontWeight:700,color:"var(--text3)",marginBottom:8,textTransform:"uppercase",letterSpacing:".5px"}}>🔗 Campaign Meta Ads Terkait</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                      {ts.linkedCampaigns.map(c=>(
                        <span key={c} style={{display:"inline-flex",alignItems:"center",gap:5,background:"#eff6ff",color:"var(--blue)",padding:"3px 10px",borderRadius:99,fontSize:".72rem",fontWeight:700}}>
                          {c}
                          <button onClick={async()=>{const nm={...tagMappings,[ts.tag]:ts.linkedCampaigns.filter(x=>x!==c)};await saveTagMappings(nm);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--red)",fontWeight:800,fontSize:".85rem",padding:0,lineHeight:1}}>×</button>
                        </span>
                      ))}
                      {ts.linkedCampaigns.length===0&&<span style={{fontSize:".72rem",color:"var(--text3)"}}>Belum ada campaign terkait — tambahkan di bawah</span>}
                    </div>
                    <select value="" onChange={async(e)=>{
                      if(!e.target.value)return;
                      const camp=e.target.value;
                      if(ts.linkedCampaigns.includes(camp))return;
                      const nm={...tagMappings,[ts.tag]:[...ts.linkedCampaigns,camp]};
                      await saveTagMappings(nm);
                    }} style={{padding:"6px 10px",background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,color:"var(--text2)",fontFamily:"inherit",fontSize:".75rem",outline:"none",cursor:"pointer"}}>
                      <option value="">+ Kaitkan Campaign Ads...</option>
                      {allCampaigns.filter(c=>!ts.linkedCampaigns.includes(c)).map(c=><option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              );
            })}

            {/* Summary comparison table — always visible */}
            {allTagsList.length>0&&<div className="card">
              <div className="ct">Perbandingan Semua Tag</div>
              <div className="table-wrap">
                <table className="dt">
                  <thead><tr><th>Tag</th><th>Klik Shopee</th><th>Pesanan</th><th>Komisi Kotor</th><th>Spend</th><th>Profit</th><th>ROAS</th><th>CTR</th></tr></thead>
                  <tbody>{allTagsList.map(tag=>{
                    const ts=computeTagStats(tag);
                    return <tr key={tag} style={{cursor:"pointer"}} onClick={()=>{if(!selectedTags.includes(tag))setSelectedTags(p=>[...p,tag]);}}>
                      <td style={{fontWeight:700,color:"var(--accent)"}}>{tag}</td>
                      <td className="num" style={{color:"var(--blue)"}}>{ts.shopeeClicks.toLocaleString("id-ID")}</td>
                      <td className="num">{ts.pesananCount}</td>
                      <td className="num" style={{color:"var(--green)"}}>{fmtRp(ts.komisi)}</td>
                      <td className="num" style={{color:"var(--red)"}}>{ts.spend>0?fmtRp(ts.spend):"-"}</td>
                      <td className="num" style={{color:ts.profit>=0?"var(--green)":"var(--red)"}}>{ts.spend>0?fmtRp(ts.profit):"-"}</td>
                      <td className="num">{ts.roas?<span className={`badge ${parseFloat(ts.roas)>=1?"bg-green":"bg-red"}`}>{ts.roas}x</span>:"-"}</td>
                      <td className="num">{ts.ctr?<span className={`badge ${parseFloat(ts.ctr)>=50?"bg-green":parseFloat(ts.ctr)>=20?"bg-yellow":"bg-red"}`}>{ts.ctr}%</span>:"-"}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <p style={{fontSize:".7rem",color:"var(--text3)",marginTop:8}}>💡 Klik baris tag untuk langsung membuka detail evaluasinya di atas.</p>
            </div>}
          </>;
        })()}

        {/* ══ PESANAN ══ */}
        {tab==="pesanan" && <>
          <div className="card">
            <div className="ct">Filter</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[["fStatus",setFStatus,["Selesai","Tertunda","Dibatalkan","Belum Dibayar"],"Semua Status"],["fPlatform",setFPlatform,["Facebook","Instagram","Others","Websites"],"Semua Platform"]].map(([,setter,opts,placeholder],i)=>(
                <select key={i} style={{padding:"7px 10px",background:"var(--surface)",border:"1px solid #d1d9ee",borderRadius:8,color:"var(--text)",fontFamily:"inherit",fontSize:".76rem",fontWeight:600,outline:"none"}} onChange={e=>setter(e.target.value)}>
                  <option value="">{placeholder}</option>{opts.map(o=><option key={o}>{o}</option>)}
                </select>
              ))}
              <select style={{padding:"7px 10px",background:"var(--surface)",border:"1px solid #d1d9ee",borderRadius:8,color:"var(--text)",fontFamily:"inherit",fontSize:".76rem",fontWeight:600,outline:"none"}} value={fTag} onChange={e=>setFTag(e.target.value)}><option value="">Semua Tag</option>{allTags.map(t=><option key={t}>{t}</option>)}</select>
              <select style={{padding:"7px 10px",background:"var(--surface)",border:"1px solid #d1d9ee",borderRadius:8,color:"var(--text)",fontFamily:"inherit",fontSize:".76rem",fontWeight:600,outline:"none"}} value={fDay} onChange={e=>setFDay(e.target.value)}><option value="">Semua Tanggal</option>{allDays.map(d=><option key={d} value={d}>{fmtDate(d)}</option>)}</select>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div className="card" style={{marginBottom:0}}><div style={{fontSize:".68rem",color:"var(--text3)",fontWeight:600,marginBottom:6}}>Komisi Kotor (filter)</div><div style={{fontSize:"1.1rem",fontWeight:800,color:"var(--green)"}}>{fmtRp(filteredPesanan.reduce((s,r)=>s+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0))}</div><div style={{fontSize:".68rem",color:"var(--text3)",marginTop:4}}>{filteredPesanan.length} pesanan</div></div>
            <div className="card" style={{marginBottom:0}}><div style={{fontSize:".68rem",color:"var(--text3)",fontWeight:600,marginBottom:6}}>Total Nilai Beli</div><div style={{fontSize:"1.1rem",fontWeight:800,color:"var(--blue)"}}>{fmtRp(filteredPesanan.reduce((s,r)=>s+parseNum(r["Nilai Pembelian(Rp)"]),0))}</div></div>
          </div>
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div className="ct" style={{marginBottom:0}}>Daftar Pesanan</div><span className="badge bg-orange">{filteredPesanan.length}</span></div>
            {pesananData.length===0?<div className="empty"><div className="icon">🧾</div><p>Upload Laporan Pesanan CSV.</p></div>:
            <div className="table-wrap"><table className="dt">
              <thead><tr><th>Tanggal</th><th>Produk</th><th>Status</th><th>Platform</th><th>Tag</th><th>Nilai Beli</th><th>Komisi</th></tr></thead>
              <tbody>
                {filteredPesanan.slice(0,100).map((r,i)=><tr key={i}>
                  <td style={{whiteSpace:"nowrap",fontSize:".7rem"}}>{dateOnly(r["Waktu Pemesanan"])}</td>
                  <td style={{maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:".74rem"}} title={r["Nama Barange"]}>{(r["Nama Barange"]||"").substring(0,28)}{(r["Nama Barange"]||"").length>28?"…":""}</td>
                  <td><SBadge s={r["Status Pesanan"]}/></td>
                  <td><Pill p={r["Platform"]||"Others"}/></td>
                  <td style={{fontSize:".7rem",color:"var(--text3)"}}>{r["Tag_link1"]||"-"}</td>
                  <td className="num">{fmtRp(parseNum(r["Nilai Pembelian(Rp)"]))}</td>
                  <td className="num" style={{color:"var(--green)"}}>{fmtRpFull(parseNum(r["Komisi Bersih Affiliate (Rp)"]))}</td>
                </tr>)}
                {filteredPesanan.length>100&&<tr><td colSpan={7} style={{textAlign:"center",padding:12,color:"var(--text3)",fontSize:".75rem"}}>…dan {filteredPesanan.length-100} lainnya. Gunakan filter.</td></tr>}
              </tbody>
            </table></div>}
          </div>
        </>}

        {/* ══ KAMPANYE ══ */}
        {tab==="kampanye" && <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            {[["Total Spend",fmtRp(totalSpend),"red"],["Total Klik",clicksData.length.toLocaleString("id-ID"),"blue"],["Komisi Kotor",fmtRp(komisiKotor),"green"],["ROAS",roas?roas+"x":"–","yellow"]].map(([l,v,c])=><div key={l} className="card" style={{marginBottom:0}}><div style={{fontSize:".68rem",color:"var(--text3)",fontWeight:600,marginBottom:6}}>{l}</div><div style={{fontSize:"1.1rem",fontWeight:800,color:`var(--${c})`}}>{v}</div></div>)}
          </div>
          <div className="card">
            <div className="ct">Performa per Kampanye</div>
            {metaData.length===0?<div className="empty"><div className="icon">📣</div><p>Upload Data Meta Ads.</p></div>:(()=>{
              const bc={};
              metaData.forEach(r=>{const k=r["Nama kampanye"]||"-";if(!bc[k])bc[k]={spend:0,clicks:0,impresi:0,days:new Set()};bc[k].spend+=parseNum(r["Jumlah yang dibelanjakan (IDR)"]);
                const klikL=parseNum(r["Klik tautan"]);
                if(klikL>0){bc[k].clicks+=klikL;}else{const ctr=parseNum(r["CTR (rasio klik tayang tautan)"]);const imp=parseNum(r["Impresi"]);if(ctr>0&&imp>0)bc[k].clicks+=Math.round(ctr/100*imp);}
                bc[k].impresi+=parseNum(r["Impresi"]);if(r["Awal pelaporan"])bc[k].days.add(r["Awal pelaporan"]);});
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
            {clicksData.length===0?<div className="empty"><div className="icon">🖱️</div><p>Upload Shopee Clicks.</p></div>:(()=>{
              const byP=clicksData.reduce((acc,r)=>{const p=r["Perujuk"]||"Others";acc[p]=(acc[p]||0)+1;return acc;},{});
              const total=clicksData.length;
              return Object.entries(byP).sort((a,b)=>b[1]-a[1]).map(([p,c])=><div key={p} style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <Pill p={p}/>
                  <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:".85rem"}}>{c.toLocaleString("id-ID")} <span style={{fontSize:".7rem",color:"var(--text3)",fontWeight:500}}>({(c/total*100).toFixed(1)}%)</span></span>
                </div>
                <div style={{height:7,background:"var(--surface2)",borderRadius:99,overflow:"hidden"}}><div style={{height:"100%",width:(c/total*100).toFixed(1)+"%",background:"var(--blue)",borderRadius:99}}/></div>
              </div>);
            })()}
          </div>
        </>}

        {/* ══ BULANAN ══ */}
        {tab==="monthly" && <>
          <div className="card">
            <div className="ct">Pilih Bulan</div>
            {allMonths.length===0?<p style={{fontSize:".8rem",color:"var(--text3)"}}>Belum ada data.</p>:
            <div className="month-sel">{allMonths.map(m=><button key={m} className={`mb ${m===activeMonth?"active":""}`} onClick={()=>setSelectedMonth(m)}>{monthLabel(m)}</button>)}</div>}
          </div>
          {activeMonth && <>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              {[["Spend Meta",fmtRp(mSpend),"red",metaMonth.length+" baris"],["Komisi Kotor",fmtRp(mKotor),"green",pesananMonth.length+" pesanan"],["Komisi Selesai",fmtRp(mSelesai),"purple",pesananMonth.filter(r=>r["Status Pesanan"]==="Selesai").length+" confirmed"],["ROAS",mRoas?mRoas+"x":"–","yellow","kotor ÷ spend"],["Total Klik",clicksMonth.length.toLocaleString("id-ID"),"blue",""],["Profit Est.",fmtRp(mKotor-mSpend),mKotor-mSpend>=0?"green":"red","komisi - spend"]].map(([l,v,c,s])=><div key={l} className="card" style={{marginBottom:0}}><div style={{fontSize:".68rem",color:"var(--text3)",fontWeight:600,marginBottom:6}}>{l}</div><div style={{fontSize:"1.05rem",fontWeight:800,color:`var(--${c})`}}>{v}</div>{s&&<div style={{fontSize:".68rem",color:"var(--text3)",marginTop:4}}>{s}</div>}</div>)}
            </div>
            {payoutsMonth.length>0&&<div className="card"><div className="ct">Laporan Pembayaran {monthLabel(activeMonth)}</div>{payoutsMonth.map(p=><PayoutCard key={p.id} p={p}/>)}</div>}
            <div className="card">
              <div className="ct">Status Pesanan {monthLabel(activeMonth)}</div>
              {["Selesai","Tertunda","Dibatalkan","Belum Dibayar"].map(s=>{
                const items=pesananMonth.filter(r=>r["Status Pesanan"]===s);if(!items.length)return null;
                const k=items.reduce((sum,r)=>sum+parseNum(r["Komisi Bersih Affiliate (Rp)"]),0);
                return <div key={s} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid var(--border)"}}><div><SBadge s={s}/><span style={{fontSize:".76rem",color:"var(--text3)",marginLeft:8}}>{items.length} pesanan</span></div><div style={{fontWeight:800,fontFamily:"'DM Mono',monospace"}}>{fmtRpFull(k)}</div></div>;
              })}
            </div>
          </>}
        </>}

        {/* ══ HUTANG ══ */}
        {tab==="debt" && <>
          <div className="debt-card">
            <div className="debt-header"><div className="debt-title">🏦 Status Hutang</div><div className="debt-pct">{debtPct}%</div></div>
            <div className="debt-track" style={{height:12}}><div className="debt-fill" style={{width:debtPct+"%"}}/></div>
            <div className="debt-nums">
              <span>Total Awal: <strong>Rp 6.000.000</strong></span>
              <span>Terbayar: <strong style={{color:"var(--green)"}}>{fmtRpFull(debtPaid)}</strong></span>
              <span>Sisa: <strong style={{color:"var(--accent)"}}>{fmtRpFull(debtLeft)}</strong></span>
            </div>
          </div>
          <div className="card">
            <div className="ct">Riwayat Cicilan</div>
            {[...payoutsPaid.map(p=>({date:p.terbitDate,amount:p.cicilan,source:"💰 "+fmtDate(p.terbitDate)})),...extraDebt.map(e=>({date:e.date,amount:e.amount,source:"⚡ "+(e.note||"Tambahan")}))].sort((a,b)=>b.date.localeCompare(a.date)).length===0
              ?<div className="empty"><div className="icon">💳</div><p>Cicilan otomatis tercatat dari Laporan Pembayaran Shopee.</p></div>
              :[...payoutsPaid.map(p=>({date:p.terbitDate,amount:p.cicilan,source:"💰 "+fmtDate(p.terbitDate)})),...extraDebt.map(e=>({date:e.date,amount:e.amount,source:"⚡ "+(e.note||"Tambahan")}))].sort((a,b)=>b.date.localeCompare(a.date)).map((item,i)=><div key={i} className="dp-item"><div><div style={{fontSize:".7rem",color:"var(--text3)",fontWeight:500}}>{fmtDate(item.date)}</div><div style={{fontSize:".8rem",color:"var(--text2)",fontWeight:600,marginTop:1}}>{item.source}</div></div><div style={{fontSize:".88rem",fontWeight:800,color:"var(--green)",fontFamily:"'DM Mono',monospace"}}>{fmtRpFull(item.amount)}</div></div>)
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
