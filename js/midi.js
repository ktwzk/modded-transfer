"use strict";
/* ModdedTransfer — MIDI ports, staged connect with warm-up, send-path probe. */

// ---- Port enumeration that survives any engine -------------------------------
let enumHow="";
function mapToList(map){
  const out=[];
  if(!map) return out;
  try{
    if(typeof map.forEach==="function"){
      map.forEach(v=>out.push(v));
      enumHow="forEach";
      return out;
    }
  }catch(_){}
  try{
    if(typeof map.values==="function"){
      const it=map.values();
      if(it && typeof it.next==="function"){
        let r, guard=0;
        while(!(r=it.next()).done){
          if(r.value!==undefined) out.push(r.value);
          if(++guard>4096) break;
        }
        enumHow="values().next()";
        return out;
      }
    }
  }catch(_){}
  try{
    const a=Array.from(map.values());
    enumHow="Array.from";
    return a;
  }catch(_){}
  try{
    const vals=Object.keys(map).map(k=>map[k]).filter(v=>v&&typeof v==="object"&&v.id!==undefined);
    if(vals.length){ enumHow="Object.keys"; return vals; }
  }catch(_){}
  enumHow="none";
  return out;
}
function portsOf(access,kind){
  if(!access) return [];
  return mapToList(kind==="outputs"?access.outputs:access.inputs);
}
function outputPorts(){ return portsOf(state.access,"outputs"); }
function inputPorts(){ return portsOf(state.access,"inputs"); }
function portById(list,id){
  if(id===undefined||id===null||id==="") return null;
  for(const p of list){ if(String(p.id)===String(id)) return p; }
  return null;
}
function pickPort(list,preferredName){
  if(!list.length) return null;
  if(preferredName){
    for(const p of list) if((p.name||"")===preferredName) return p;
  }
  for(const p of list) if(/Elektron|Model|Cycles|Samples|TG/i.test(p.name||"")) return p;
  return list[0];
}

let attachedInput=null;
function safeAttachInput(){
  const want=state.input;
  if(attachedInput && attachedInput!==want){
    try{ attachedInput.onmidimessage=null; }catch(_){}
    attachedInput=null;
  }
  if(want && want!==attachedInput){
    try{ want.onmidimessage=onMidi; attachedInput=want; }
    catch(e){
      attachedInput=null;
      log("Could not attach the MIDI input handler: "+e.message,"bad");
    }
  }
}

async function refresh(){
  if(!state.access){ log("Tap Connect first."); return; }
  const prevOut=$("#port").value, prevIn=$("#input").value;
  const ports=outputPorts(), ins=inputPorts();
  $("#port").innerHTML="";
  $("#input").innerHTML="";
  for(const p of ports){
    const o=document.createElement("option"); o.value=String(p.id); o.textContent=p.name||p.id; $("#port").append(o);
  }
  for(const p of ins){
    const o=document.createElement("option"); o.value=String(p.id); o.textContent=p.name||p.id; $("#input").append(o);
  }
  if(prevOut && portById(ports,prevOut)) $("#port").value=String(prevOut);
  if(prevIn && portById(ins,prevIn)) $("#input").value=String(prevIn);
  if(!ports.length && !ins.length){
    log("MIDI is open, but this page sees no ports.\nMake sure this browser/app is allowed to use your MIDI interface, then tap Refresh.","bad");
  }
}

function onStateChange(){
  Promise.resolve().then(async()=>{
    const keepOut=$("#port").value, keepIn=$("#input").value;
    await refresh();
    const outs=outputPorts(), ins=inputPorts();
    const o=portById(outs,keepOut)||pickPort(outs);
    if(o) $("#port").value=String(o.id);
    const i=portById(ins,keepIn)||pickPort(ins,o&&o.name);
    if(i) $("#input").value=String(i.id);
    selectPort(true);
    log("MIDI ports changed — list updated.");
  }).catch(e=>log("Port change handling failed: "+e.message,"bad"));
}

// ---- connect: staged, remote-logged, warm-up capable -----------------------
async function connect(){
  if(state.connecting){ log("Connect is already running — wait for it to finish."); return; }
  if(!navigator.requestMIDIAccess){log("This browser does not expose Web MIDI.","bad");return}
  state.connecting=true;
  try{ $("#connect").disabled=true; }catch(_){}
  try{
  stage("1/6 Web MIDI present.");
  await paint();

  if($("#opt-warmup").checked){
    stage("2/6 warm-up: basic MIDI access, no SysEx…");
    await paint();
    try{
      const basic=await navigator.requestMIDIAccess({sysex:false});
      let bo=[],bi=[];
      try{ bo=portsOf(basic,"outputs"); bi=portsOf(basic,"inputs"); }catch(_){}
      stage(`2/6 warm-up OK: ${bo.length} output(s), ${bi.length} input(s)\n`+
            bo.map(p=>"OUT  "+(p.name||p.id)).join("\n")+"\n"+
            bi.map(p=>"IN   "+(p.name||p.id)).join("\n"));
    }catch(e){
      stage("2/6 warm-up refused: "+e.message);
    }
    await paint();
  }else{
    stage("2/6 warm-up skipped.");
  }

  stage("3/6 requesting SysEx access…");
  await paint();
  let access;
  try{
    access=await navigator.requestMIDIAccess({sysex:true});
  }catch(e){
    log("Could not open Web MIDI with SysEx: "+e.message+"\nEnable SysEx for this app/page and try again.","bad");
    return;
  }
  state.access=access;

  stage("4/6 SysEx access granted. Enumerating ports…");
  let outs=[],ins=[];
  try{
    outs=outputPorts(); ins=inputPorts();
  }catch(e){
    log("Port enumeration failed: "+e.message,"bad");
    return;
  }
  await refresh();
  stage(`5/6 ${outs.length} output(s), ${ins.length} input(s) — enumerated via ${enumHow}.`);

  const o=pickPort(outs);
  if(o) $("#port").value=String(o.id);
  const i=pickPort(ins,o&&o.name);
  if(i) $("#input").value=String(i.id);
  selectPort(true);
  setTimeout(()=>{
    try{ access.onstatechange=onStateChange; }
    catch(e){ log("This browser cannot watch port changes ("+e.message+") — tap Refresh after replugging."); }
  },100);

  if(state.output){
    if(lsGet("mt.transport")==="1"){
      stage("6/6 connected (transport certified) — reading the root folder…");
      listDir($("#path").value).catch(()=>{});
    }else{
      stage("6/6 connected — ports ready.\nTransport not tested: tap PROBE.\nIf the app closes, reopen the page, tap Connect and PROBE again — it continues automatically.");
    }
  }else{
    stage("6/6 no output port — pick one in the dropdown.");
  }
  }finally{
    state.connecting=false;
    try{ $("#connect").disabled=false; }catch(_){}
  }
}
function selectPort(silent){
  if(state.busy){
    // A transfer/delete/probe is using the current ports — swapping mid-flight
    // would orphan its responses. Restore the dropdowns to the active ports.
    try{
      if(state.output) $("#port").value=String(state.output.id);
      if(state.input) $("#input").value=String(state.input.id);
    }catch(_){}
    if(!silent) log("A transfer is running — port change ignored.","bad");
    return;
  }
  const prevOut=state.output, prevIn=state.input;
  state.output=portById(outputPorts(),$("#port").value);
  let inp=portById(inputPorts(),$("#input").value);
  if(!inp && state.output){
    const cand=pickPort(inputPorts(), state.output.name);
    if(cand){ $("#input").value=String(cand.id); inp=cand; }
  }
  state.input=inp||null;
  safeAttachInput();
  $("#device").textContent=state.output
    ? `Output: ${state.output.name}\nInput: ${state.input?.name||"not paired"}`
    : "No output selected.";
  if(!silent && state.output && (state.output!==prevOut||state.input!==prevIn)){
    log(`Port selected: ${state.output.name}`+(state.input?` (input: ${state.input.name})`:""));
  }
  setControls();
}
function ensureOutput(){ selectPort(true); return state.output; }

// ---- send-path probe (crash-resumable) ---------------------------------------
const PROBE_STEPS=[
  {id:"P0", fmt:null, desc:"output.open()", kind:"open"},
  {id:"P1", fmt:"arr", desc:"send Array [0xFE] (Active Sensing, ignored by devices)", data:[0xFE]},
  {id:"P2", fmt:"u8",  desc:"send Uint8Array [0xFE]", data:[0xFE]},
  {id:"P3", fmt:"arr", desc:"send Array empty SysEx [F0 F7]", data:[0xF0,0xF7], sysex:true},
  {id:"P4", fmt:"u8",  desc:"send Uint8Array empty SysEx [F0 F7]", data:[0xF0,0xF7], sysex:true},
  {id:"P5", fmt:"arr", desc:"send Array universal identity request", data:[0xF0,0x7E,0x7F,0x06,0x01,0xF7], sysex:true, waitReply:true},
  {id:"P6", fmt:"u8",  desc:"send Uint8Array universal identity request", data:[0xF0,0x7E,0x7F,0x06,0x01,0xF7], sysex:true, waitReply:true},
  {id:"P7", fmt:"arr", desc:"send Array Elektron ping 0x01", kind:"ping", sysex:true, waitReply:true},
  {id:"P8", fmt:"u8",  desc:"send Uint8Array Elektron ping 0x01", kind:"ping", sysex:true, waitReply:true},
];
function probeIdx(){ return +(lsGet("mt.probe.i")||0); }
async function rlast(text){ rlogNow(text); await sleep(250); }
const probe=withBusy(async function(){
  if(!ensureOutput()){ log("No MIDI output selected — connect first.","bad"); return; }
  try{
    let i=probeIdx();
    const pend=lsGet("mt.probe.pending");
    if(pend!==null && +pend===i && i<PROBE_STEPS.length){
      const dead=PROBE_STEPS[i];
      lsDel("mt.probe.pending");
      if(dead.fmt) lsSet("mt.deadfmt."+dead.fmt,"1");
      i=i+1; lsSet("mt.probe.i",String(i));
      rlogNow(`PROBE ${dead.id} DID NOT COMPLETE (app was killed) — format ${dead.fmt||"n/a"} marked dead, continuing at ${Math.min(i+1,PROBE_STEPS.length)}/${PROBE_STEPS.length}`);
    }
    if(sendFmt()==="none"){
      log("Both message formats crashed this app during the probe — its MIDI send is broken.\nNothing this page can do about a native crash: try Safari (recent iOS has native Web MIDI) or another Web MIDI app.","bad");
      return;
    }
    while(i<PROBE_STEPS.length){
      const st=PROBE_STEPS[i];
      if(st.fmt && st.fmt!==sendFmt()){
        rlogNow(`PROBE ${st.id} skipped (format ${st.fmt} is not the working one)`);
        i=i+1; lsSet("mt.probe.i",String(i));
        continue;
      }
      lsSet("mt.probe.pending",String(i));
      await rlast(`PROBE ${st.id} (${i+1}/${PROBE_STEPS.length}): ${st.desc} — sending…`);
      const rx0=state.rxSeen;
      let sent=false;
      try{
        if(st.kind==="open"){
          let r="no open() on this port";
          if(typeof state.output.open==="function"){
            const p=state.output.open();
            if(p&&p.then) await p.catch(()=>{});
            r="open() called, state="+(state.output.state||"?");
          }
          rlogNow(`PROBE ${st.id}: ${r}`);
        }else if(st.kind==="ping"){
          const f=frame(makeMsg(0x01));
          state.output.send(st.fmt==="u8"? f : Array.from(f));
          sent=true;
        }else{
          state.output.send(st.fmt==="u8"? new Uint8Array(st.data) : st.data.slice());
          sent=true;
        }
      }catch(e){
        rlogNow(`PROBE ${st.id} JS THROW: ${e.message}`);
      }
      if(sent) await rlast(`PROBE ${st.id}: send() returned (no JS exception)`);
      await sleep(st.waitReply?3000:600);
      const rx=state.rxSeen-rx0;
      rlogNow(`PROBE ${st.id}: STILL ALIVE after wait${st.waitReply?` (replies seen: ${rx})`:""}`);
      lsSet("mt.probe.ok."+st.id,"1");
      lsDel("mt.probe.pending");
      if(st.sysex && !lsGet("mt.sendfmt") && !lsGet("mt.deadfmt."+st.fmt)){
        lsSet("mt.sendfmt",st.fmt);
      }
      i=i+1; lsSet("mt.probe.i",String(i));
      if(st.kind==="ping" && rx>0){
        lsSet("mt.transport","1");
        log(`Probe complete: ping answered — full duplex works, format ${sendFmt()}. Reading the device…`,"ok");
        await listDir($("#path").value).catch(()=>{});
        return;
      }
    }
    if(sendFmt()!=="none"){
      lsSet("mt.transport","1");
      log(`Probe complete — every send survived (format ${sendFmt()}).${state.rxSeen?"":"\nNo MIDI input was seen at all: sending works, receiving does not reach the page — check the NATIVE CB lines in the server log."}`, state.rxSeen?"ok":"");
    }
  }finally{
    probeInfo();
  }
});
function resetProbe(){
  if(state.busy) return;
  ["mt.probe.i","mt.probe.pending","mt.sendfmt","mt.transport","mt.deadfmt.arr","mt.deadfmt.u8"].forEach(lsDel);
  try{
    for(let k=localStorage.length-1;k>=0;k--){
      const key=localStorage.key(k);
      if(key && key.indexOf("mt.probe.")===0) lsDel(key);
    }
  }catch(_){}
  log("Probe state cleared — run Probe again from the first step.");
  probeInfo();
}
function probeInfo(){
  const el=$("#probeinfo"); if(!el) return;
  if(sendFmt()==="none"){ el.innerHTML='<span class="bad">Send broken: both formats crashed this app.</span>'; return; }
  const i=probeIdx();
  if(lsGet("mt.transport")==="1"){
    el.innerHTML=`<span class="okmark">Transport certified</span> · send format: ${escapeHtml(sendFmt())} · probe ${Math.min(i,PROBE_STEPS.length)}/${PROBE_STEPS.length}`;
  }else if(i>0){
    el.innerHTML=`Probe ${Math.min(i,PROBE_STEPS.length)}/${PROBE_STEPS.length} · send format so far: ${escapeHtml(sendFmt())} · not certified`;
  }else{
    el.textContent="Transport untested — run Probe after Connect.";
  }
}
