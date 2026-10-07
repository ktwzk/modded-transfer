"use strict";
/* ModdedTransfer — ping, sample upload (OPEN/WRITE/CLOSE), upload-all. */

const ping=withBusy(async function(){
  if(!ensureOutput()){ log("No MIDI output selected — pick a port in the dropdown.","bad"); return; }
  try{
    const r=await sendMsg(makeMsg(0x01),3000);
    log(`PING OK\nresponse type ${hex(r[4])}\nstatus ${hex(r[5]||0)}\n${[...r].map(hex).join(" ")}`,"ok");
  }catch(e){
    console.error(e);
    log("PING FAILED: "+e.message+"\n\nCheck that INPUT and OUTPUT are the same Elektron MIDI device and that Web MIDI SysEx is enabled.","bad");
  }
  renderQueue();
});

async function upload(file,index,totalFiles){
  setFileState(index,"checking…");
  const base=normalizePath($("#path").value);
  const name=sanitizeTarget(targetNameFor(file));
  if(!name) throw new Error(`Empty sample name for ${file.name} — type a name first.`);
  const path=joinPath(base,name);
  log(`Checking ${file.name} → “${name}”…`);

  const existing=await listDir(base);
  if(existing.some(x=>x.type==="file" && x.name===name)){
    throw new Error(`File already exists: ${path}. Choose another name or folder.`);
  }

  setFileState(index,"converting…");
  const t0=Date.now();
  // Audition (queue ▶) converts ahead of time and caches on the File expando —
  // reuse it here instead of decoding twice.
  const a=file._conv||await decodeToMono48k(file,p=>{
    const bar=$("#file-bar-"+index); if(bar) bar.style.width=Math.round(p*100)+"%";
    if(state.files.length===1) setFileState(index,`reading audio track ${Math.round(p*100)}%`);
  });
  file._conv=null;
  const header=buildHeader(a.pcm.length);
  const total=header.length+a.pcm.length;
  const full=new Uint8Array(total);full.set(header);full.set(a.pcm,64);
  log(`Decoded ${file.name}\n${a.video?`audio track via ${a.route}\n`:"decoder: "+a.route+"\n"}source: ${a.srcRate} Hz, ${a.srcChannels} ch → 48000 Hz, 1 ch, ${a.frames} frames\n${a.normGain&&a.normGain!==1?`normalized ×${a.normGain.toFixed(2)}\n`:""}PCM: ${a.pcm.length} bytes (16-bit ${WIRE_LE?"LE":"BE"}), file total with header: ${total} bytes\nheader: ${[...header.slice(0,24)].map(hex).join(" ")}`);

  const open=makeMsg(SAMPLE_OPEN,[...u32be(total),...encodePath(path),0]);
  setFileState(index,"opening…");
  const or=await sendMsg(open,5000);
  if(or[5]!==1) throw new Error(`OPEN rejected: ${rejectText(or,"device rejected the file")}`);
  const id=readU32(or,6);

  let sent=0,block=0,lastUi=0,lastPct=-1;
  // The LCD is a real DOM write per call — at 8 KiB blocks a big sample would
  // repaint it hundreds of times. Throttle to whole-percent changes (max 4 Hz).
  const showProgress=force=>{
    const pct=Math.round(sent/full.length*100);
    const now=Date.now();
    if(!force && (pct===lastPct || now-lastUi<250)) return;
    lastUi=now; lastPct=pct;
    setFileState(index,`${pct}%`);
    const rowBar=$("#file-bar-"+index); if(rowBar) rowBar.style.width=pct+"%";
    log(`Uploading ${file.name}\n${pct}%  ${formatBytes(sent)} / ${formatBytes(full.length)}`);
  };
  while(sent<full.length){
    const chunk=full.slice(sent,Math.min(sent+BLOCK,full.length));
    const body=[...u32be(id),...u32be(chunk.length),...u32be(BLOCK*block),...chunk];
    showProgress(false);
    const wr=await sendMsg(makeMsg(SAMPLE_WRITE,body),10000);
    if(wr[5]!==1) throw new Error(`WRITE rejected at block ${block}`);
    sent+=chunk.length;block++;
    const pct=((index+(sent/full.length))/totalFiles)*100;
    $("#bar").style.width=pct+"%";
    await sleep(20);
  }
  showProgress(true);

  setFileState(index,"finishing…");
  const cl=await sendMsg(makeMsg(SAMPLE_CLOSE,[...u32be(id),...u32be(total)]),5000);
  if(cl[5]!==1) throw new Error(`CLOSE rejected: ${rejectText(cl,"")}`);

  if(state.verify){
    const after=await listDir(base);
    const entry=after.find(x=>x.type==="file" && x.name===name);
    if(!entry){
      throw new Error(`Upload finished but device did not report ${path} in the directory.`);
    }
    if(entry.size!==total){
      throw new Error(`Size mismatch on device: expected ${total} bytes, device reports ${entry.size}.`);
    }
    setFileState(index,"✓ uploaded","ok");
    log(`Uploaded ${file.name} as “${name}”\ndevice reports ${formatBytes(entry.size)} at ${path} — matches sent size.`,"ok");
    rep(`UPLOADED ✓ ${path} · ${total} bytes, device size matches · ${Date.now()-t0} ms`);
  }else{
    setFileState(index,"✓ sent","ok");
    log(`Uploaded ${file.name} as “${name}”\nverification skipped (option off) — not confirmed on the device.`,"ok");
    rep(`UPLOADED ? ${path} · ${total} bytes, verification SKIPPED · ${Date.now()-t0} ms`);
  }
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function uploadAll(){
  if(!ensureOutput()){ log("No MIDI output selected — pick a port in the dropdown.","bad"); return; }
  if(!state.files.length){ log("No files selected — choose audio first ("+SUPPORTED_LABEL+").","bad"); return; }
  const dupes=queueDupes();
  const di=Object.keys(dupes);
  if(di.length){ log(`Two files are named “${targetNameFor(state.files[di[0]])}” — rename one first.`,"bad"); return; }
  await withBusy(async()=>{
    stopAudition();
    $("#bar").style.width="0%";
    state.files.forEach((_,i)=>{ setFileState(i,"waiting…"); const b=$("#file-bar-"+i); if(b) b.style.width="0%"; });
    let done=0;
    rep(`upload-all start · ${state.files.length} file(s) · verify ${state.verify?"on":"off"} · normalize ${state.normalize?"on":"off"}`);
    try{
      for(let i=0;i<state.files.length;i++){
        try{
          await upload(state.files[i],i,state.files.length);
          done++;
        }catch(e){
          setFileState(i,"✕ "+e.message,"bad");
          rep(`FAILED ✕ ${state.files[i].name}: ${e.message}`);
          throw e;
        }
      }
      $("#bar").style.width="100%";
      log(`Done. ${done} sample(s) uploaded${state.verify?" and verified on the device":" (unverified)"}.`,"ok");
      rep(`upload-all done · ${done}/${state.files.length} ok`);
      await listDir($("#path").value);
    }catch(e){
      console.error(e);
      log(`Upload stopped after ${done} file(s): ${e.message}`,"bad");
      rep(`upload-all stopped after ${done} file(s): ${e.message}`);
    }
  })();
}
