"use strict";
/* ModdedTransfer v24 — shared scope root: guard, state, constants, remote
 * logging, native bridge stub, status/log helpers, withBusy, dialog.
 * Classic scripts (no modules, so file:// and the Web MIDI Browser webview work),
 * sharing one scope: top-level const/let/function here are visible to the later
 * files. Load order is set in index.html and must be kept. */
if (window.__MODDED_TRANSFER) {
  throw new Error("ModdedTransfer is already loaded — js/core.js is included twice. Include each js/ file only once.");
}
window.__MODDED_TRANSFER = true;

const $ = s => document.querySelector(s);
const state = { access:null, input:null, output:null, files:[], busy:false, connecting:false, seq:0, wait:null, rxSeen:0, verify:true, normalize:false, report:[] };
function rep(line){ state.report.push(stamp()+line); }
async function copyReport(){
  const lines=[`ModdedTransfer session report · ${new Date().toISOString()}`,...state.report];
  if(!state.report.length) lines.push("(nothing recorded yet)");
  const text=lines.join("\n");
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){
      await navigator.clipboard.writeText(text);
    }else{
      const ta=document.createElement("textarea");
      ta.value=text; ta.setAttribute("readonly","");
      ta.style.position="absolute"; ta.style.left="-9999px";
      document.body.appendChild(ta); ta.select();
      const ok=document.execCommand("copy"); ta.remove();
      if(!ok) throw new Error("copy command failed");
    }
    log(`Report copied (${lines.length} lines) — paste it anywhere.`,"ok");
  }catch(e){
    log("Copy failed: "+e.message,"bad");
  }
}
function stamp(){ return new Date().toISOString().slice(11,23)+" "; }

const HEADER = [0xf0,0x00,0x20,0x3c,0x10,0x00];
const BLOCK = 0x2000;
// Elektron sample filesystem opcodes (from dagargo/elektroid, src/elektron.c).
// Elektron response sequence is msg[2..3]; response type = request type | 0x80; status byte is msg[5] (1 = success).
const SAMPLE_READ_DIR = 0x10, SAMPLE_CREATE_DIR = 0x11, SAMPLE_DELETE_DIR = 0x12, SAMPLE_DELETE_FILE = 0x20;
const SAMPLE_OPEN = 0x40, SAMPLE_CLOSE = 0x41, SAMPLE_WRITE = 0x42;

// Byte order of the sample header 32-bit fields and of the 16-bit PCM samples on the wire.
// false = big-endian (Elektroid sends g_htonl()/g_htons() values — network order, like
// every other multi-byte field of this protocol: seq, id, size, offset — all verified BE).
// Flip to true only if the device refuses to load an uploaded sample with "Not 48kHz mono".
const WIRE_LE = false;

// ---- remote logging (/?log=…) — REMOVED in v22 -------------------------------
// The whole server-logging path (batched fetch to /?log=, the opt-in checkbox,
// the mt.remote key) is gone: the hoster saw too many requests. The original
// code is kept below as a comment for reference; rlog()/rlogNow() are no-op
// shells so the many call sites across the js/ files keep working without
// sending anything anywhere.
//   const LOG_ENDPOINT="/?log=";
//   const remote={on:false,q:[],n:0};
//   function rsend(text){
//     if(!remote.on) return;
//     remote.n++;
//     try{
//       fetch(LOG_ENDPOINT+encodeURIComponent(text)+"&n="+remote.n,{keepalive:true,cache:"no-store"}).catch(()=>{});
//     }catch(_){}
//   }
//   let flushT=null;
//   function rflush(){
//     if(!remote.q.length) return;
//     const batch=remote.q.splice(0,20).join("\n");
//     rsend(batch);
//     if(remote.q.length) rthrottle();
//   }
//   function rthrottle(){
//     if(flushT) return;
//     flushT=setTimeout(()=>{flushT=null;rflush();},350);
//   }
//   function rlog(text){
//     if(!remote.on) return;
//     remote.q.push(stamp()+text);
//     if(remote.q.length>200) remote.q.shift();
//     rthrottle();
//   }
//   function rlogNow(text){
//     if(!remote.on) return;
//     remote.q.push(stamp()+text);
//     rflush();
//   }
function rlog(text){}
function rlogNow(text){}

// ---- localStorage namespace migration --------------------------------------
// v20 renamed the project (and its keys) from tg.* to mt.*. Copy any surviving
// v19 values over once, then drop the old keys — returning users keep their
// probe progress, send format, transport flag and option states.
function migrateLs(){
  try{
    const pairs=[["tg.theme","mt.theme"],["tg.warmup","mt.warmup"],
      ["tg.probe.i","mt.probe.i"],["tg.probe.pending","mt.probe.pending"],
      ["tg.sendfmt","mt.sendfmt"],["tg.transport","mt.transport"],
      ["tg.deadfmt.arr","mt.deadfmt.arr"],["tg.deadfmt.u8","mt.deadfmt.u8"]];
    for(const [o,n] of pairs){
      if(localStorage.getItem(n)===null){
        const v=localStorage.getItem(o);
        if(v!==null) localStorage.setItem(n,v);
      }
      localStorage.removeItem(o);
    }
    for(let k=localStorage.length-1;k>=0;k--){
      const key=localStorage.key(k);
      if(key&&key.indexOf("tg.probe.ok.")===0){
        const nk="mt."+key.slice(3);
        if(localStorage.getItem(nk)===null) localStorage.setItem(nk,localStorage.getItem(key));
        localStorage.removeItem(key);
      }
    }
  }catch(_){}
}

// ---- native bridge stub ------------------------------------------------------
// The app delivers incoming MIDI by evaluating _callback_receiveMIDIMessage(...)
// in the page. Before requestMIDIAccess resolves, that function does not exist —
// every MIDI clock tick (0xF8, ~48/s) raised a ReferenceError. The stub counts
// calls, logs the bridge's exact argument format once, and dispatches the bytes
// into our parser. If the shim later defines its own, it simply replaces this one.
let nativeCbCount=0, nativeCbLogged=false;
function parseBridgeBytes(v){
  if(v==null) return null;
  if(typeof v==="string"){
    const s=v.trim();
    if(s.startsWith("[")){ try{ const j=JSON.parse(s); if(Array.isArray(j)) return Uint8Array.from(j); }catch(_){} }
    const parts=s.split(/[,\s]+/).filter(x=>x!=="");
    if(parts.length && parts.every(x=>/^\d+$/.test(x))) return Uint8Array.from(parts.map(Number));
    return null;
  }
  if(typeof v==="number") return null;
  if(v.length!==undefined){ try{ return Uint8Array.from(v); }catch(_){ return null; } }
  return null;
}
try{
  if(typeof window._callback_receiveMIDIMessage==="undefined"){
    window._callback_receiveMIDIMessage=function(){
      nativeCbCount++;
      if(!nativeCbLogged){
        nativeCbLogged=true;
        try{
          const parts=[];
          for(let k=0;k<arguments.length;k++){
            const a=arguments[k];
            if(typeof a==="string") parts.push("str("+a.length+"):"+a.slice(0,48));
            else if(a&&typeof a==="object"&&a.length!==undefined) parts.push("list("+a.length+"):["+Array.prototype.slice.call(a,0,10).join(",")+"]");
            else parts.push(typeof a+":"+String(a).slice(0,32));
          }
          rlogNow("NATIVE CB FORMAT: "+parts.join(" | "));
        }catch(_){}
      }
      try{
        const bytes=parseBridgeBytes(arguments[1])||parseBridgeBytes(arguments[0]);
        if(bytes&&bytes.length) onMidi({data:bytes});
      }catch(_){}
    };
  }
}catch(_){}

function setStatus(s,cls){
  const e=$("#status");
  e.innerHTML='<span class="'+(cls||"")+'">'+escapeHtml(s)+'</span>';
}
function log(s, cls=""){ setStatus(s,cls); console.log("[MT]",s); rlog(s); }
function vlog(s, cls=""){ setStatus(s,cls); console.log("[MT]",s); }
// Serialize device operations: only one MIDI request chain runs at a time.
// Usage: const doThing = withBusy(async function(args){ ... });
function withBusy(fn){
  return async function(){
    if(state.busy){ log("Another operation is running — try again in a moment.","bad"); return; }
    state.busy=true; setControls();
    try{ return await fn.apply(this,arguments); }
    finally{ state.busy=false; setControls(); }
  };
}
function stage(s){ setStatus(s); console.log("[MT]",s); rlogNow(s); }
const paint=()=>new Promise(r=>requestAnimationFrame(()=>setTimeout(r,40)));

function hex(n){return "0x"+n.toString(16).padStart(2,"0")}
function u32be(n){return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]}
function readU32(a,p){return (((a[p]<<24)>>>0)|(a[p+1]<<16)|(a[p+2]<<8)|a[p+3])>>>0}
function rejectText(m,fallback){
  try{
    const t=new TextDecoder().decode(m.slice(6)).replace(/\0/g," ").trim();
    return t||fallback;
  }catch(_){ return fallback; }
}

// ---- in-page dialog (confirm/prompt are dead in this app) -------------------
// uiDialog({title, message, confirmLabel, cancelLabel, danger, input})
//   without input  → resolves true (confirm) / false (cancel)
//   with input     → resolves the entered string / null (cancel)
function uiDialog(opts){
  return new Promise(resolve=>{
    const hasInput=opts.input!==undefined && opts.input!==null;
    const ov=document.createElement("div");
    ov.className="modal-ov";
    const box=document.createElement("div");
    box.className="modal-box";
    box.setAttribute("role","dialog");
    box.innerHTML=`<div class="modal-title">${escapeHtml(opts.title||"")}</div>`+
      (opts.message?`<div class="modal-msg">${escapeHtml(opts.message)}</div>`:"")+
      (hasInput?`<input class="modal-input" type="text" placeholder="${escapeHtml(opts.input)}" autocapitalize="off" autocorrect="off" spellcheck="false">`:"")+
      `<div class="modal-actions">
         <button class="secondary" data-act="cancel">${escapeHtml(opts.cancelLabel||"Cancel")}</button>
         <button class="${opts.danger?"danger":"primary"}" data-act="ok">${escapeHtml(opts.confirmLabel||"OK")}</button>
       </div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const inp=box.querySelector(".modal-input");
    const done=v=>{ ov.remove(); resolve(v); };
    box.querySelector('[data-act="cancel"]').onclick=()=>done(hasInput?null:false);
    box.querySelector('[data-act="ok"]').onclick=()=>{
      if(inp){
        const v=inp.value.trim();
        if(!v){ try{inp.focus()}catch(_){} return; }
        done(v);
      }else done(true);
    };
    ov.onclick=e=>{ if(e.target===ov) done(hasInput?null:false); };
    if(inp){
      inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); box.querySelector('[data-act="ok"]').click(); } });
      setTimeout(()=>{ try{inp.focus()}catch(_){} },50);
    }
  });
}
