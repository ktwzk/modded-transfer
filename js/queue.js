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
  $("#pickfile").disabled=state.busy;
  try{
    // STEREO stays disabled for mono sources even when idle — uploading those
    // as stereo would burn 2× slot memory on dual mono.
    const rows=document.querySelectorAll("#queue .file");
    for(let k=0;k<rows.length&&k<state.files.length;k++){
      const f=state.files[k], ts=rows[k].querySelectorAll(".tog");
      for(let j=0;j<ts.length;j++) ts[j].disabled=state.busy||(ts[j].classList.contains("st")&&f._srcCh===1);
    }
  }catch(_){}
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
// Audio files and videos share one queue: both end up as a 48 kHz 16-bit
// sample, mono or stereo per the sample's own flag.
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
    // Per-sample flags (File expandos, like _target): normalize inherits the
    // global default at queue time, stereo defaults to ON — the async channel
    // probe below turns it back off (and locks the toggle) for mono sources.
    if(!dup){ f._target=cleanName(f.name); f._norm=state.normalize; f._stereo=true; f._srcCh=0; state.files.push(f); probeFileChannels(f); }
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
// Channel probe for a queued file: audio decodes natively, video only demuxes
// (see probeChannels). Resolves after render — the toggle and the source note
// are painted in place so a rename input being edited never loses focus.
async function probeFileChannels(f){
  const ch=await probeChannels(f);
  const i=state.files.indexOf(f);
  if(i<0) return; // removed from the queue while probing
  f._srcCh=ch;
  if(ch===1) f._stereo=false; // mono source: stereo would be dual mono for 2× slot memory
  paintStereoState(i);
}
function paintStereoState(i){
  const f=state.files[i]; if(!f) return;
  const rows=$("#queue").querySelectorAll(".file");
  const row=rows[i]; if(!row) return;
  const tM=row.querySelector(".tog.mono"), tS=row.querySelector(".tog.st");
  if(tS){
    const mono=f._srcCh===1;
    tS.classList.toggle("on",!!f._stereo);
    tM.classList.toggle("on",!f._stereo);
    tS.disabled=state.busy||mono;
    tM.disabled=state.busy;
    tS.title=mono?"Source file is mono — stereo upload disabled":"Upload as stereo — the device splits L/R itself";
  }
  // Name the source on the meta line — touch screens have no hover for the
  // title above. Skipped while busy, when the line shows transfer progress.
  if(!state.busy&&f._srcCh>0){
    const meta=$("#file-meta-"+i);
    if(meta&&meta.textContent.indexOf(" source")<0)
      meta.textContent+=f._srcCh===1?" · mono source":" · stereo source";
  }
}
function renderQueue(){
  const q=$("#queue");q.innerHTML="";
  const dupes=queueDupes();
  state.files.forEach((f,i)=>{
    const video=isVideoFile(f);
    const d=document.createElement("div");d.className="file";
    d.innerHTML=`<div><input class="rename${dupes[i]?" dup":""}" id="file-name-${i}" type="text" maxlength="31" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Sample name on the device"><div class="meta" id="file-meta-${i}">${formatBytes(f.size)} · ${video?"audio track will be extracted":"waiting"}</div><div class="rename-hint">from ${escapeHtml(f.name)}${dupes[i]?" · <b>duplicate name</b>":""}</div><div class="ptrack"><div class="pfill" id="file-bar-${i}"></div></div></div>
      <div class="ftoggles"><button type="button" class="tog norm${f._norm?" on":""}" title="Peak-normalize this sample to 0 dB">NORMALIZE to 0dB</button><div class="seg"><button type="button" class="tog mono${f._stereo?"":" on"}">MONO</button><button type="button" class="tog st${f._stereo?" on":""}"${f._srcCh===1?" disabled":""} title="${f._srcCh===1?"Source file is mono — stereo upload disabled":"Upload as stereo — the device splits L/R itself"}">STEREO</button></div><button class="queue-x" title="Remove from queue" aria-label="Remove from queue">×</button></div>`;
    const inp=d.querySelector("input");
    inp.value=targetNameFor(f);
    inp.addEventListener("input",()=>{ f._target=inp.value; refreshDupeMarks(); });
    inp.addEventListener("change",()=>{ f._target=sanitizeTarget(inp.value)||cleanName(f.name); inp.value=targetNameFor(f); refreshDupeMarks(); });
    // Toggles flip the per-sample flag in place — no re-render, focus is untouched.
    const tN=d.querySelector(".tog.norm"), tM=d.querySelector(".tog.mono"), tS=d.querySelector(".tog.st");
    tN.onclick=()=>{ f._norm=!f._norm; tN.classList.toggle("on",!!f._norm); };
    tM.onclick=()=>{ f._stereo=false; tM.classList.add("on"); tS.classList.remove("on"); };
    tS.onclick=()=>{ f._stereo=true; tS.classList.add("on"); tM.classList.remove("on"); };
    d.querySelector(".queue-x").onclick=()=>{ state.files.splice(i,1); renderQueue(); };
    q.appendChild(d);
  });
  setControls();
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function formatBytes(n){return n<1048576?(n/1024).toFixed(1)+" KiB":(n/1048576).toFixed(2)+" MiB"}
