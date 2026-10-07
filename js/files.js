"use strict";
/* ModdedTransfer — device filesystem: CP1252 paths, dir listing, explorer,
 * recursive delete, mkdir. */

// ---- Paths -----------------------------------------------------------------
const CP1252_HIGH={0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F};
function encodePath(str){
  const out=[];
  for(const c of str){
    const cp=c.codePointAt(0);
    if(cp<0x80) out.push(cp);
    else if(cp>=0xA0&&cp<=0xFF) out.push(cp);
    else if(CP1252_HIGH[cp]!==undefined) out.push(CP1252_HIGH[cp]);
    else out.push(0x3F); // '?'
  }
  return out;
}
function normalizePath(p){
  p=(p||"/").trim().replace(/\\/g,"/");
  if(!p.startsWith("/")) p="/"+p;
  p=p.replace(/\/+/g,"/");
  if(p.length>1) p=p.replace(/\/+$/,"");
  return p||"/";
}
function joinPath(dir,name){
  return normalizePath((dir==="/"?"":dir)+"/"+name);
}
function parentPath(p){
  p=normalizePath(p);
  if(p==="/") return "/";
  const i=p.lastIndexOf("/");
  return i<=0?"/":p.slice(0,i);
}
function parseDirResponse(m){
  const items=[];
  let p=5;
  while(p<m.length){
    if(p+10>m.length) throw new Error("Malformed directory response");
    const hash=readU32(m,p); p+=4;
    const size=readU32(m,p); p+=4;
    const writeProtected=m[p++];
    const typeByte=m[p++];
    let end=p;
    while(end<m.length && m[end]!==0) end++;
    if(end>=m.length) throw new Error("Malformed directory entry name");
    const bytes=m.slice(p,end);
    let name;
    try { name=new TextDecoder("windows-1252").decode(bytes); }
    catch(_) { name=new TextDecoder().decode(bytes); }
    p=end+1;
    if(name) items.push({name,size,hash,type:typeByte===68?"dir":"file",writeProtected});
  }
  return items;
}
async function readDir(path){
  const r=await sendMsg(makeMsg(SAMPLE_READ_DIR,[...encodePath(path),0]),5000);
  return parseDirResponse(r);
}
async function listDir(path=normalizePath($("#path").value)){
  if(!state.access){ renderExplorer([], "Connect MIDI first."); return; }
  if(!ensureOutput()){ renderExplorer([], "No MIDI output port selected."); return; }
  path=normalizePath(path);
  $("#path").value=path;
  try{
    const items=await readDir(path);
    renderExplorer(items);
    return items;
  }catch(e){
    renderExplorer([], "Cannot read directory: "+e.message);
    throw e;
  }
}
function renderExplorer(items,message=null){
  const fi=$("#fsinfo");
  if(fi) fi.textContent = message ? "" : (items.length ? `${items.length} item${items.length===1?"":"s"}` : "");
  const box=$("#explorer");
  box.innerHTML="";
  if(message){
    box.innerHTML=`<div class="explorer-empty">${escapeHtml(message)}</div>`;
    return;
  }
  if(!items.length){
    box.innerHTML='<div class="explorer-empty">Empty folder.</div>';
    return;
  }
  items.sort((a,b)=>(a.type!==b.type? (a.type==="dir"?-1:1):a.name.localeCompare(b.name)));
  for(const item of items){
    const row=document.createElement("div");
    row.className="explorer-item"+(item.type==="dir"?" clickable":"");
    const icon=item.type==="dir"
      ? '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
      : '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" style="color:var(--accent)"><path d="M1.5 8h2l1.5-4 2 8 2-6 1.5 2h2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    row.innerHTML=`<div class="explorer-icon">${icon}</div>
      <div class="explorer-name">${escapeHtml(item.name)}</div>
      <div class="explorer-size">${item.type==="dir"?"":formatBytes(item.size)}</div>
      <button class="delete-item" title="Delete" aria-label="Delete ${escapeHtml(item.name)}">×</button>`;
    const del=row.querySelector(".delete-item");
    del.onclick=async(ev)=>{ ev.stopPropagation(); rlogNow("UI: delete tapped “"+item.name+"”"); await deleteItem(item); };
    if(item.type==="dir"){
      row.onclick=async()=>{ $("#path").value=joinPath($("#path").value,item.name); await listDir(); };
    }
    box.appendChild(row);
  }
}

// ---- Delete ----------------------------------------------------------------
// Per Elektroid (elektron_delete_common_item): files are removed with
// FS_SAMPLE_DELETE_FILE_REQUEST (0x20), directories with FS_SAMPLE_DELETE_DIR_REQUEST
// (0x12) — and only after the client has recursively removed everything inside.
async function deleteRecursive(path,type){
  if(type==="dir"){
    const items=await readDir(path);
    for(const it of items) await deleteRecursive(joinPath(path,it.name), it.type);
    const r=await sendMsg(makeMsg(SAMPLE_DELETE_DIR,[...encodePath(path),0]),5000);
    if(r[5]!==1) throw new Error(rejectText(r,`DELETE DIR rejected: ${path}`));
  }else{
    const r=await sendMsg(makeMsg(SAMPLE_DELETE_FILE,[...encodePath(path),0]),5000);
    if(r[5]!==1) throw new Error(rejectText(r,`DELETE FILE rejected: ${path}`));
  }
}
const deleteItem=withBusy(async function(item){
  if(!ensureOutput()){ log("No MIDI output selected — connect first.","bad"); return; }
  const parent=normalizePath($("#path").value);
  const path=joinPath(parent,item.name);
  const kind=item.type==="dir"?"folder and everything inside it":"sample";
  const ok=await uiDialog({
    title:"Delete",
    message:`Delete ${kind} “${item.name}” from the device? This cannot be undone.`,
    confirmLabel:"Delete",
    cancelLabel:"Cancel",
    danger:true
  });
  if(ok!==true) return;
  rlogNow("DELETE CONFIRMED: "+path);
  try{
    await deleteRecursive(path,item.type);
    const items=await listDir(parent);
    if(items.some(x=>x.name===item.name)){
      log(`Delete failed: “${item.name}” is still listed by the device.`,"bad");
      rep(`DELETE FAILED ✕ ${path}: still listed`);
    }else{
      log(`Deleted: ${path}`,"ok");
      rep(`DELETED ✓ ${path}`);
    }
  }catch(e){
    log("Delete failed: "+e.message,"bad");
    rep(`DELETE FAILED ✕ ${path}: ${e.message}`);
    try{ await listDir(parent); }catch(_){}
  }
});
const makeDir=withBusy(async function(){
  if(!ensureOutput()){ log("No MIDI output selected — connect first.","bad"); return; }
  const parent=normalizePath($("#path").value);
  const name=await uiDialog({title:"New folder",input:"Folder name",confirmLabel:"Create",cancelLabel:"Cancel"});
  if(name===null || name===undefined) return;
  const clean=name.trim().replace(/[\/\\:*?"<>|]/g,"_");
  if(!clean) return;
  const path=joinPath(parent,clean);
  try{
    const r=await sendMsg(makeMsg(SAMPLE_CREATE_DIR,[...encodePath(path),0]),5000);
    if(r[5]!==1) throw new Error(rejectText(r,"CREATE DIR rejected"));
    log(`Folder created: ${path}`,"ok");
    rep(`MKDIR ✓ ${path}`);
    await listDir(parent);
  }catch(e){
    log("Create folder failed: "+e.message,"bad");
  }
});
