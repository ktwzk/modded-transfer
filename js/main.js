"use strict";
/* ModdedTransfer — wiring: buttons, file picker, error reporting, init.
 * Loads last; every other js/ file must come before it (see index.html). */
if(!window.__MODDED_TRANSFER) throw new Error("js/core.js must load before js/main.js");

 $("#connect").onclick=connect;
 $("#refresh").onclick=async()=>{await refresh(); if(state.output) await listDir($("#path").value);};
 $("#ping").onclick=ping;
 $("#probe").onclick=probe;
 $("#resetprobe").onclick=resetProbe;
 $("#up").onclick=async()=>{ if(state.busy||!ensureOutput())return; $("#path").value=parentPath($("#path").value); await listDir(); };
 $("#go").onclick=()=>listDir();
 $("#ls").onclick=()=>listDir();
 $("#mkdir").onclick=makeDir;
 $("#port").addEventListener("change",()=>selectPort());
 $("#input").addEventListener("change",()=>selectPort());
// Option checkboxes persist their state.
// (Server logging was removed in v22 — nothing in this app phones home.)
 $("#opt-warmup").addEventListener("change",()=>{
  lsSet("mt.warmup", $("#opt-warmup").checked?"1":"0");
});
 $("#opt-verify").addEventListener("change",()=>{
  state.verify=$("#opt-verify").checked;
  lsSet("mt.verify", state.verify?"1":"0");
});
 $("#opt-normalize").addEventListener("change",()=>{
  state.normalize=$("#opt-normalize").checked;
  lsSet("mt.normalize", state.normalize?"1":"0");
});
 $("#copyrep").onclick=copyReport;
// One picker button everywhere — no drop zones (drag & drop lives in the
// official transfer app). iOS shows its own Photo Library / Take Video /
// Choose Files sheet for the file input.
$("#pickfile").onclick=()=>$("#files").click();
 $("#files").onchange=e=>{setFiles(e.target.files);e.target.value="";};
 $("#send").onclick=uploadAll;
 $("#theme").onclick=()=>{
  const now=document.documentElement.getAttribute("data-theme")
    ||(window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
  const next=now==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme",next);
  lsSet("mt.theme",next);
 };

// No drop zones — but a stray drop (e.g. a file dragged onto the page by
// accident) must not navigate away and kill the session.
window.addEventListener("dragover",e=>e.preventDefault());
window.addEventListener("drop",e=>e.preventDefault());

// Deduplicated error reporting (only sent when logging is enabled).
const errSeen=new Map();
window.addEventListener("error",e=>{
  const m=(e.message||"?")+" @line "+(e.lineno||0);
  const n=(errSeen.get(m)||0)+1; errSeen.set(m,n);
  if(n===1||n%200===0) rlogNow(`JS ERROR x${n}: ${m}`);
});
window.addEventListener("unhandledrejection",e=>{
  rlogNow("REJECT: "+((e.reason&&e.reason.message)||e.reason||"?"));
});

if(navigator.requestMIDIAccess) $("#device").textContent="Web MIDI detected. Tap Connect.";
else $("#device").textContent="This browser does not expose Web MIDI.";

// Restore persisted option states (defaults: warmup ON, verify ON, normalize OFF).
// v19 stored these under tg.* — migrate once, then read the mt.* keys.
migrateLs();
if(lsGet("mt.warmup")==="0"){ $("#opt-warmup").checked=false; }
if(lsGet("mt.verify")==="0"){ state.verify=false; $("#opt-verify").checked=false; }
if(lsGet("mt.normalize")==="1"){ state.normalize=true; $("#opt-normalize").checked=true; }
setControls();

rep("session start · ModdedTransfer v23 · "+(navigator.userAgent||"n/a"));
rlogNow("PAGE MT23 LOADED · "+location.pathname);
