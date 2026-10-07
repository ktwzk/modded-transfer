"use strict";
/* ModdedTransfer — Elektron SysEx wire protocol: 7-bit codec, framing,
 * send format selection, sendMsg with sequence matching, MIDI input parser. */

function encode7(src){
  // Matches Elektroid's elektron_encode_payload exactly: the final group is
  // truncated (no zero padding to a full 8-byte block).
  const out=[];
  for(let i=0;i<src.length;i+=7){
    let hi=0;
    const n=Math.min(7,src.length-i);
    const block=[];
    for(let k=0;k<n;k++){
      const b=src[i+k];
      if(b&0x80) hi|=(1<<(6-k));
      block.push(b&0x7f);
    }
    out.push(hi,...block);
  }
  return out;
}
function decode7(src){
  const out=[];
  for(let i=0;i<src.length;i+=8){
    const hi=src[i]||0;
    for(let k=0;k<7 && i+k+1<src.length;k++)
      out.push((src[i+k+1]&0x7f)|((hi&(1<<(6-k)))?0x80:0));
  }
  return new Uint8Array(out);
}
function frame(msg){
  const enc=encode7(msg);
  return new Uint8Array([...HEADER,...enc,0xf7]);
}
function unframe(raw){
  if(raw.length<8) return null;
  for(let i=0;i<6;i++) if(raw[i]!==HEADER[i]) return null;
  if(raw[raw.length-1]!==0xf7) return null;
  return decode7(raw.slice(6,-1));
}

function makeMsg(type, body=[]){
  return new Uint8Array([0,0,0,0,type,...body]);
}
function seqMsg(msg, seq){
  const x=new Uint8Array(msg);
  x[0]=(seq>>>8)&255; x[1]=seq&255; x[2]=0; x[3]=0;
  return x;
}

// ---- localStorage (probe progress + option state survive app crashes) --------
function lsGet(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(_){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(_){} }

// ---- send format -------------------------------------------------------------
// "arr"  = pass plain Array to output.send()   (old bridge era norm)
// "u8"   = pass Uint8Array (spec form)
// "none" = both formats crashed the app — sending is impossible
function sendFmt(){
  const dead={arr:lsGet("mt.deadfmt.arr")==="1", u8:lsGet("mt.deadfmt.u8")==="1"};
  if(dead.arr&&dead.u8) return "none";
  if(dead.u8) return "arr";
  if(dead.arr) return "u8";
  return lsGet("mt.sendfmt")||"arr";
}
function wireSend(bytes){
  return sendFmt()==="arr" ? Array.from(bytes) : bytes;
}
function strictTransport(){ return lsGet("mt.transport")!=="1"; }

function sendMsg(msg, timeout=2500){
  return new Promise((resolve,reject)=>{
    if(!state.output) return reject(new Error("No MIDI output"));
    if(state.wait) return reject(new Error("Another MIDI request is still waiting"));
    if(sendFmt()==="none") return reject(new Error("Sending is disabled: both message formats crashed this app (run Probe)"));
    const seq=state.seq++ & 0xffff;
    const x=seqMsg(msg,seq);
    const timer=setTimeout(()=>{
      if(state.wait && state.wait.seq===seq) state.wait=null;
      reject(new Error(`MIDI response timeout (seq ${seq}, request ${hex(x[4])})`));
    },timeout);
    state.wait={seq,type:(x[4]|0x80),timer,resolve,reject};
    const preview=[...x.slice(0,32)].map(hex).join(" ")+(x.length>32?" …":"");
    const strict=strictTransport();
    if(strict){
      vlog(`TX seq=${seq} type=${hex(x[4])} len=${x.length}\n${preview}`);
      rlogNow(`TX seq=${seq} type=${hex(x[4])} len=${x.length} fmt=${sendFmt()} — calling send()…`);
    }else{
      log(`TX seq=${seq} type=${hex(x[4])} len=${x.length}\n${preview}`);
    }
    try{
      state.output.send(wireSend(frame(x)));
      if(strict) rlogNow(`TX seq=${seq} — send() returned`);
    }catch(e){clearTimeout(timer);state.wait=null;reject(e)}
  });
}

// ---- MIDI input ------------------------------------------------------------
function msgBytes(ev){
  const d=ev && ev.data;
  if(!d) return new Uint8Array(0);
  if(d instanceof Uint8Array) return d;
  if(d instanceof DataView) return new Uint8Array(d.buffer,d.byteOffset,d.byteLength);
  if(d instanceof ArrayBuffer) return new Uint8Array(d);
  if(ArrayBuffer.isView(d)) return new Uint8Array(d.buffer,d.byteOffset,d.byteLength);
  return new Uint8Array(d);
}
let rxBuf=null;
function onMidi(ev){
  // Never let an exception inside the handler reach the native bridge.
  try{
    // MIDI Real-Time messages (F8-FE, FF) may arrive standalone or interleaved between
    // SysEx bytes. They are discarded in every position. 0xF7 is NOT real-time.
    const d=msgBytes(ev);
    for(let i=0;i<d.length;i++){
      const b=d[i];
      if(b===0xF0){ rxBuf=[0xF0]; continue; }
      if(b===0xF7){
        if(rxBuf){ rxBuf.push(0xF7); const raw=new Uint8Array(rxBuf); rxBuf=null; handleSysex(raw); }
        continue;
      }
      if(b>=0xF8) continue;
      if(rxBuf) rxBuf.push(b);
    }
  }catch(e){ /* a bad event must not kill the page */ }
}
function handleSysex(raw){
  state.rxSeen++;
  const m = unframe(raw);
  if(!m){
    vlog(`RX non-Elektron SysEx (${raw.length} bytes) — input path works`);
    rlogNow(`RX non-Elektron SysEx (${raw.length} bytes)`);
    return;
  }
  const seq=((m[2]<<8)|m[3])>>>0;
  const type=m[4];
  const preview=[...m.slice(0,24)].map(hex).join(" ")+(m.length>24?" …":"");
  vlog(`RX seq=${seq} type=${hex(type)} len=${m.length}\n${preview}`);
  rlogNow(`RX seq=${seq} type=${hex(type)} len=${m.length}`);
  if(state.wait && seq===state.wait.seq){
    const w=state.wait; state.wait=null; clearTimeout(w.timer);
    if(type !== w.type) w.reject(new Error(`Unexpected response type ${hex(type)}, expected ${hex(w.type)}`));
    else w.resolve(m);
  }
}
