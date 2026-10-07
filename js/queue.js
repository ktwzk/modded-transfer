"use strict";
/* ModdedTransfer — upload queue: per-file state, controls, media-type
 * detection, rename-before-upload, duplicate detection, queue rendering. */

function setFileState(i,text,cls=""){
  const e=$(`#file-meta-${i}`);
  if(e){e.textContent=text;e.className="meta "+cls;}
}
function setControls(){
  const dupes=(()=>{ try{ return queueDupes(); }catch(_){ return {}; } })();
  const hasDupes=Object.keys(dupes).length>0;
  const ready=!!(state.output&&state.files.length&&!state.busy&&!hasDupes);
  $("#send").classList.toggle("dim",!ready);
  $("#send").textContent=state.files.length?`Upload ${state.files.length}`:"Upload";
  $("#ping").disabled=state.busy;
  $("#probe").disabled=state.busy;
  $("#resetprobe").disabled=state.busy;
  $("#mkdir").disabled=!(state.output&&!state.busy);
  $("#up").disabled=!(state.output&&!state.busy);
  $("#go").disabled=!(state.output&&!state.busy);
  $("#ls").disabled=!(state.output&&!state.busy);
  $("#pick").disabled=state.busy;
  $("#pickv").disabled=state.busy;
  $("#pickfile").disabled=state.busy;
  if(state.busy) stopAudition();
  const auds=document.querySelectorAll(".audition");
  for(let k=0;k<auds.length;k++) auds[k].disabled=state.busy;
  // Flasher-style step markers: a step's trig key lights up once it is done.
  try{
    const m=document.querySelector("#step-midi"); if(m) m.classList.toggle("done",!!state.output);
    const f=document.querySelector("#step-files"); if(f) f.classList.toggle("done",state.files.length>0);
  }catch(_){}
  probeInfo();
}

// What the file is: audio the browser can decode on its own, or a video whose
// audio track has to be pulled out of the container first.
const AUDIO_RE=/\.(wav|wave|mp3|m4a|mp4a|aac|flac|aif|aiff|aifc|caf|ogg|oga|opus)$/i;
const VIDEO_RE=/\.(mp4|m4v|mov|qt|3gp|3g2|mp4v|mpe?g4)$/i;
function isVideoFile(f){
  const t=((f&&f.type)||"").toLowerCase();
  if(t.startsWith("video/")) return true;
  if(t.startsWith("audio/")) return false;
  return VIDEO_RE.test((f&&f.name)||"");
}
function isAudioFile(f){
  const t=((f&&f.type)||"").toLowerCase();
  if(t.startsWith("audio/")) return true;
  if(t.startsWith("video/")) return false;
  return AUDIO_RE.test((f&&f.name)||"");
}
function isMediaFile(f){ return isVideoFile(f)||isAudioFile(f); }

function cleanName(name){
  let n=String(name||"").replace(/\.[^.]+$/,"").replace(/[\/\\:*?"<>|]/g,"_").trim();
  if(!n)n="sample";
  return n.slice(0,31);
}
// Per-file device name, editable in the queue before upload. The File object
// itself is untouched — the target lives on the expando `_target`.
function sanitizeTarget(s){
  return cleanName(s);
}
function targetNameFor(f){
  const t=f&&f._target!==undefined&&f._target!==null?String(f._target):"";
  const c=sanitizeTarget(t||(f&&f.name)||"");
  return c||"sample";
}
// Audio files and videos share one queue: both end up as a 48 kHz mono sample.
// MP4/MOV picked through the *file* input take the exact same video path as
// the Apple Photos button (isVideoFile → decodeVideoTrack): demux + WebCodecs,
// decodeAudioData over the whole file, real-time capture as a last resort.
const SUPPORTED_LABEL="WAV · MP3 · M4A · AAC · OGG · AIFF · FLAC · MP4 · MOV";
function setFiles(list){
  const arr=Array.from(list||[]);
  const good=[],bad=[];
  for(const f of arr){ (isMediaFile(f)?good:bad).push(f); }
  for(const f of good){
    const dup=state.files.some(x=>x.name===f.name&&x.size===f.size);
    if(!dup){ f._target=cleanName(f.name); state.files.push(f); }
  }
  renderQueue();
  if(good.length) log(`${good.length} file(s) queued for upload — rename below if needed${bad.length?` — ignored ${bad.length} unsupported (${bad.map(f=>f.name).join(", ")})`:""}.`);
  else if(bad.length) log(`Nothing usable in that selection — ${bad.map(f=>f.name).join(", ")}. Supported: ${SUPPORTED_LABEL}.`,"bad");
}
function queueDupes(){
  const seen={}, dupes={};
  state.files.forEach((f,i)=>{ const n=targetNameFor(f).toLowerCase(); if(seen[n]!==undefined){ dupes[seen[n]]=1; dupes[i]=1; } else seen[n]=i; });
  return dupes;
}
// Update duplicate marks in place — re-rendering the whole queue here would
// drop the focus from the input being edited.
function refreshDupeMarks(){
  const dd=queueDupes();
  const rows=$("#queue").querySelectorAll(".file");
  for(let k=0;k<rows.length && k<state.files.length;k++){
    const inp=rows[k].querySelector("input.rename");
    const hint=rows[k].querySelector(".rename-hint");
    if(inp) inp.classList.toggle("dup",!!dd[k]);
    if(hint) hint.innerHTML=`from ${escapeHtml(state.files[k].name)}${dd[k]?" · <b>duplicate name</b>":""}`;
  }
  setControls();
}
function renderQueue(){
  const q=$("#queue");q.innerHTML="";
  const dupes=queueDupes();
  state.files.forEach((f,i)=>{
    const video=isVideoFile(f);
    const d=document.createElement("div");d.className="file";
    d.innerHTML=`<div><input class="rename${dupes[i]?" dup":""}" id="file-name-${i}" type="text" maxlength="31" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Sample name on the device"><div class="meta" id="file-meta-${i}">${formatBytes(f.size)} · ${video?"audio track will be extracted":"waiting"}</div><div class="rename-hint">from ${escapeHtml(f.name)}${dupes[i]?" · <b>duplicate name</b>":""}</div><div class="ptrack"><div class="pfill" id="file-bar-${i}"></div></div></div>
      <button class="audition" id="file-aud-${i}" title="Play the converted 48 kHz mono sample" aria-label="Play converted sample">▶</button>
      <button class="queue-x" title="Remove from queue" aria-label="Remove from queue">×</button>`;
    const inp=d.querySelector("input");
    inp.value=targetNameFor(f);
    inp.addEventListener("input",()=>{ f._target=inp.value; refreshDupeMarks(); });
    inp.addEventListener("change",()=>{ f._target=sanitizeTarget(inp.value)||cleanName(f.name); inp.value=targetNameFor(f); refreshDupeMarks(); });
    d.querySelector(".audition").onclick=()=>toggleAudition(i);
    d.querySelector(".queue-x").onclick=()=>{ stopAudition(); state.files.splice(i,1); renderQueue(); };
    q.appendChild(d);
  });
  setControls();
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function formatBytes(n){return n<1048576?(n/1024).toFixed(1)+" KiB":(n/1048576).toFixed(2)+" MiB"}

// ---- Audition: play the converted 48 kHz mono before upload -----------------
// First tap converts (with the normalize setting) and caches the result on the
// File expando `_conv` — upload() reuses the cache instead of decoding twice.
// The tap is a user gesture, so iOS allows playback; if a long conversion
// outlives the gesture, the context starts suspended and a second tap (now
// instant, from cache) plays it.
let auditionCtx=null, auditionSrc=null, auditionIdx=-1;
function auditionBtn(i){ return $(`#file-aud-${i}`); }
function stopAudition(){
  const i=auditionIdx; auditionIdx=-1;
  try{ if(auditionSrc) auditionSrc.onended=null; }catch(_){}
  try{ if(auditionSrc) auditionSrc.stop(); }catch(_){}
  auditionSrc=null;
  try{ if(auditionCtx) auditionCtx.close(); }catch(_){}
  auditionCtx=null;
  if(i>=0){ const b=auditionBtn(i); if(b) b.textContent="▶"; }
}
async function toggleAudition(i){
  if(state.busy){ log("Busy — wait for the current operation to finish.","bad"); return; }
  if(auditionIdx===i){ stopAudition(); return; }
  const f=state.files[i]; if(!f) return;
  try{
    stopAudition();
    if(!f._conv){
      setFileState(i,"converting…");
      f._conv=await decodeToMono48k(f,p=>{
        const bar=$("#file-bar-"+i); if(bar) bar.style.width=Math.round(p*100)+"%";
      });
      setFileState(i,"ready — tap ▶ to play");
    }
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC){ log("This browser cannot play audio.","bad"); return; }
    const c=f._conv, dv=new DataView(c.pcm.buffer);
    auditionCtx=new AC();
    if(auditionCtx.state==="suspended"){ try{ await auditionCtx.resume(); }catch(_){} }
    if(auditionCtx.state==="suspended"){
      log("Playback still locked — tap ▶ once more to play.","bad");
      try{ await auditionCtx.close(); }catch(_){}
      auditionCtx=null;
      return;
    }
    const ab=auditionCtx.createBuffer(1,c.frames,48000);
    const ch0=ab.getChannelData(0);
    for(let k=0;k<c.frames;k++) ch0[k]=dv.getInt16(k*2,WIRE_LE)/32768;
    auditionSrc=auditionCtx.createBufferSource();
    auditionSrc.buffer=ab; auditionSrc.connect(auditionCtx.destination);
    auditionIdx=i;
    auditionSrc.onended=()=>{ if(auditionIdx===i){ auditionIdx=-1; const b=auditionBtn(i); if(b) b.textContent="▶"; } };
    const b=auditionBtn(i); if(b) b.textContent="■";
    auditionSrc.start();
  }catch(e){
    stopAudition();
    setFileState(i,"✕ "+e.message,"bad");
  }
}
