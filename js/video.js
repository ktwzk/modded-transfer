"use strict";
/* ModdedTransfer — MP4/MOV audio extraction: ISO base media demuxer,
 * WebCodecs decode, decodeAudioData fallback, real-time capture fallback. */

// ---- MP4 / MOV demuxer (ISO base media file format) -------------------------
// decodeAudioData() will not open an MP4/MOV container, and WebCodecs wants raw
// compressed frames plus a codec string — so the container is parsed here.
// We find the audio trak, read its sample table (stts/ctts/stsc/stsz/stco/co64)
// and the decoder configuration (esds → AudioSpecificConfig for AAC, the alac
// box for Apple Lossless). Only the moov box and the byte ranges that actually
// hold audio are read from the file — the video track is never touched.
function fourcc(dv,p){ return String.fromCharCode(dv.getUint8(p),dv.getUint8(p+1),dv.getUint8(p+2),dv.getUint8(p+3)); }
function be32(dv,p){ return dv.getUint32(p,false); }
function be64(dv,p){ return be32(dv,p)*4294967296+be32(dv,p+4); }

function eachBox(dv,s,e,fn){
  let p=s;
  while(p+8<=e){
    let size=be32(dv,p), type=fourcc(dv,p+4), hdr=8;
    if(size===1){ if(p+16>e) return; size=be64(dv,p+8); hdr=16; }
    else if(size===0){ size=e-p; }
    if(size<hdr||p+size>e) return;
    fn(type,p+hdr,p+size);
    p+=size;
  }
}
function findBox(dv,s,e,type){
  let found=null;
  eachBox(dv,s,e,(t,a,b)=>{ if(t===type&&!found) found=[a,b]; });
  return found;
}
// MPEG-4 descriptor inside esds: tag, 7-bit length, payload.
function readDesc(dv,p,end){
  if(p>=end) return null;
  const tag=dv.getUint8(p++);
  let size=0,n=0,b=0;
  do{
    if(p>=end) return null;
    b=dv.getUint8(p++);
    size=(size<<7)|(b&0x7f); n++;
    if(n>4) return null;
  } while(b&0x80);
  if(p+size>end) return null;
  return {tag,start:p,end:p+size};
}
// Walk ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo (tag 5) = ASC.
function findASC(dv,s,e){
  let p=s;
  while(p<e){
    const d=readDesc(dv,p,e);
    if(!d) return null;
    if(d.tag===0x05) return new Uint8Array(dv.buffer.slice(dv.byteOffset+d.start,dv.byteOffset+d.end));
    if(d.tag===0x03){
      if(d.end-d.start<3) return null;
      const flags=dv.getUint8(d.start+2);
      let q=d.start+3;
      if(flags&0x80) q+=2;
      if(flags&0x40){ if(q>=d.end) return null; q+=1+dv.getUint8(q); }
      if(flags&0x20) q+=2;
      const a=findASC(dv,q,d.end); if(a) return a;
    }else if(d.tag===0x04){
      const a=findASC(dv,d.start+13,d.end); if(a) return a;
    }
    p=d.end;
  }
  return null;
}
// AudioSpecificConfig → codec string, sample rate, channel count. The rate and
// channel count from the mp4 sample entry are 16.16 / packed values that some
// muxers get wrong (96 kHz overflows to 1), so the ASC is preferred when present.
const AAC_RATES=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
function aacInfo(asc){
  const out={codec:"mp4a.40.2",rate:0,channels:0};
  if(!asc||asc.length<2) return out;
  let bit=0;
  const bits=(n)=>{ let v=0; for(let i=0;i<n;i++,bit++) v=(v<<1)|((asc[bit>>3]>>(7-(bit&7)))&1); return v; };
  let aot=bits(5);
  if(aot===31) aot=32+bits(6);
  if(aot===5||aot===29) out.codec="mp4a.40.29";          // HE-AAC / HE-AAC v2
  else if(aot>=1&&aot<=4) out.codec="mp4a.40."+aot;     // AAC LC/Main/SSR/LTP
  const fi=bits(4);
  if(fi<13) out.rate=AAC_RATES[fi];
  else if(fi===15) out.rate=bits(24);
  out.channels=bits(4);
  return out;
}
function parseAudioTrak(dv,s,e){
  const mdia=findBox(dv,s,e,"mdia"); if(!mdia) return null;
  const mdhd=findBox(dv,mdia[0],mdia[1],"mdhd"); if(!mdhd) return null;
  const timescale=dv.getUint8(mdhd[0])===1 ? be32(dv,mdhd[0]+20) : be32(dv,mdhd[0]+12);
  const hdlr=findBox(dv,mdia[0],mdia[1],"hdlr");
  const handler=hdlr ? fourcc(dv,hdlr[0]+8) : "";
  if(handler && handler!=="soun") return null;
  const minf=findBox(dv,mdia[0],mdia[1],"minf"); if(!minf) return null;
  const stbl=findBox(dv,minf[0],minf[1],"stbl"); if(!stbl) return null;
  const x=stbl[0], y=stbl[1];

  const stsd=findBox(dv,x,y,"stsd"); if(!stsd) return null;
  const es=stsd[0]+8;                       // first sample entry: size(4) type(4), fields follow
  if(es+36>y) return null;
  const fmt=fourcc(dv,es+4);
  let channels=dv.getUint16(es+24,false);   // AudioSampleEntry: 6 reserved, 2 dref, 2 ver, 2 rev, 4 vendor
  let sampleRate=dv.getUint32(es+32,false)>>>16;
  let codec=null, description=null;
  // QuickTime sound sample entries (version 1/2 — what ffmpeg writes into .mov)
  // carry 16/36 extra bytes after samplerate, and the codec config then sits in a
  // nested 'wave' box, so collect the entry's boxes instead of guessing offsets.
  const entryEnd=(()=>{ const n=be32(dv,es); return (n>=36&&es+n<=y)?es+n:y; })();
  const kids=[];
  const walkKids=(s,e,d)=>{
    if(d>3) return;
    eachBox(dv,s,e,(t,a,b)=>{ kids.push([t,a,b]); if(t==="wave"||t==="sinf") walkKids(a,b,d+1); });
  };
  const qtVer=dv.getUint16(es+16,false);
  const hasCfg=()=>kids.some(k=>k[0]==="esds"||k[0]==="alac"||k[0]==="fLaC");
  const offsets=qtVer===1?[52,36,72]:qtVer===2?[72,36,52]:[36,52,72];
  for(const off of offsets){ walkKids(es+off,entryEnd,0); if(hasCfg()) break; }
  if(fmt==="mp4a"){
    for(const [t,a,b] of kids){
      if(t!=="esds") continue;
      const asc=findASC(dv,a+4,b);
      if(!asc) break;
      description=asc;
      const info=aacInfo(asc);
      codec=info.codec;
      if(info.rate) sampleRate=info.rate;              // beat the 16.16 field
      if(info.channels) channels=info.channels;
      break;
    }
    if(!codec) codec="mp4a.40.2";            // some muxers omit the esds payload
  }else if(fmt==="alac"||fmt==="fLaC"){
    codec="alac";
    for(const [t,a,b] of kids){
      if((t==="alac"||t==="fLaC")&&b-a>=24){
        description=new Uint8Array(dv.buffer.slice(dv.byteOffset+b-24,dv.byteOffset+b)); // ALACSpecificConfig
        const sr=be32(dv,b-4);
        if(sr) sampleRate=sr;
        break;
      }
    }
  }else{
    return null;                            // Opus/AC-3/etc: no WebCodecs path
  }
  if(!sampleRate||!channels) return null;

  const deltas=[];
  const stts=findBox(dv,x,y,"stts");
  if(stts){
    const n=be32(dv,stts[0]+4);
    for(let i=0;i<n;i++){
      const o=stts[0]+8+i*8; if(o+8>y) break;
      const cnt=be32(dv,o), d=be32(dv,o+4);
      for(let k=0;k<cnt && deltas.length<4e6;k++) deltas.push(d);
    }
  }
  const shifts=[];
  const ctts=findBox(dv,x,y,"ctts");
  if(ctts){
    const ver=dv.getUint8(ctts[0]), n=be32(dv,ctts[0]+4);
    for(let i=0;i<n;i++){
      const o=ctts[0]+8+i*8; if(o+8>y) break;
      const cnt=be32(dv,o);
      const off=ver===1 ? dv.getInt32(o+4,false) : (dv.getUint32(o+4,false)<<24>>24);
      for(let k=0;k<cnt;k++) shifts.push(off);
    }
  }
  const stsz=findBox(dv,x,y,"stsz");
  if(!stsz) return null;
  const count=be32(dv,stsz[0]+8), uniform=be32(dv,stsz[0]+4);
  const sizes=new Array(count);
  if(uniform){ sizes.fill(uniform); }
  else for(let i=0;i<count;i++){ const o=stsz[0]+12+i*4; if(o+4>y) return null; sizes[i]=be32(dv,o); }
  if(!count) return null;

  const runs=[];
  const stsc=findBox(dv,x,y,"stsc");
  if(stsc){
    const n=be32(dv,stsc[0]+4);
    for(let i=0;i<n;i++){ const o=stsc[0]+8+i*12; if(o+12>y) break; runs.push([be32(dv,o),be32(dv,o+4)]); }
  }
  let chunks=null;
  const stco=findBox(dv,x,y,"stco");
  if(stco){
    const n=be32(dv,stco[0]+4); chunks=new Array(n);
    for(let i=0;i<n;i++){ const o=stco[0]+8+i*4; if(o+4>y) break; chunks[i]=be32(dv,o); }
  }else{
    const co64=findBox(dv,x,y,"co64");
    if(co64){
      const n=be32(dv,co64[0]+4); chunks=new Array(n);
      for(let i=0;i<n;i++){ const o=co64[0]+8+i*8; if(o+8>y) break; chunks[i]=be64(dv,o); }
    }
  }
  if(!chunks||!chunks.length||!runs.length) return null;

  const samples=[];
  let si=0, dts=0;
  for(let c=0;c<chunks.length&&si<count;c++){
    let spc=runs[0]?runs[0][1]:1;
    for(const r of runs){ if(r[0]-1<=c) spc=r[1]; else break; }
    let off=chunks[c];
    for(let k=0;k<spc&&si<count;k++){
      const d=deltas[si]!==undefined ? deltas[si] : (deltas.length?deltas[deltas.length-1]:1024);
      samples.push({offset:off,size:sizes[si],cts:dts+(shifts[si]||0),dur:d});
      off+=sizes[si]; si++; dts+=d;
    }
  }
  if(!samples.length) return null;
  return {codec,description,channels,sampleRate,timescale,samples};
}
// Top-level boxes by scanning headers only (16 bytes per box, whatever the size).
async function topBoxes(file){
  const out=[]; let p=0,guard=0;
  while(p+8<=file.size&&guard++<512){
    const dv=new DataView(await file.slice(p,p+16).arrayBuffer());
    if(dv.byteLength<8) break;
    let size=be32(dv,0), type=fourcc(dv,4), hdr=8;
    if(size===1){ if(dv.byteLength<16) break; size=be64(dv,8); hdr=16; }
    else if(size===0){ size=file.size-p; }
    if(size<hdr||p+size>file.size) break;
    out.push({type,start:p,end:p+size,hdr});
    p+=size;
  }
  return out;
}
async function demuxAudio(file){
  const boxes=await topBoxes(file);
  if(!boxes.length) throw new Error("not an MP4/MOV file");
  const moov=boxes.find(b=>b.type==="moov");
  if(!moov) throw new Error("no moov box (fragmented or not MP4/MOV)");
  // Read the box payload only — every offset below is relative to it.
  const moovBuf=await file.slice(moov.start+moov.hdr,moov.end).arrayBuffer();
  const dv=new DataView(moovBuf);
  let best=null;
  eachBox(dv,0,dv.byteLength,(t,s,e)=>{
    if(t!=="trak") return;
    const trak=parseAudioTrak(dv,s,e);
    if(trak&&(!best||trak.samples.length>best.samples.length)) best=trak;
  });
  if(!best) throw new Error("no audio track in this video");
  return best;
}
// Byte-range reader with a sliding window: sample data is contiguous inside mdat,
// so a few large slices replace thousands of tiny ones.
function sampleReader(file,samples,windowBytes){
  let winStart=-1,winEnd=-1,buf=null;
  return async function(i){
    const s=samples[i], a=s.offset, b=a+s.size;
    if(!(a>=winStart&&b<=winEnd)){
      let end=b,k=i+1;
      while(k<samples.length&&end-samples[k].offset<=windowBytes&&samples[k].offset===end){ end+=samples[k].size; k++; }
      buf=await file.slice(a,end).arrayBuffer();
      winStart=a; winEnd=end;
    }
    return new Uint8Array(buf,a-winStart,s.size);
  };
}
// One AudioData channel as Float32, whatever the decoder's native format is.
// Non-planar formats ("f32"/"s16"/"u8") are INTERLEAVED — channel p is every
// c-th sample starting at p — not a contiguous block. (The old code sliced
// contiguous halves, which is why video audio came out chopped/garbled while
// plain audio files, which never pass through here, were fine.)
function readPlane(ad,p){
  const c=ad.numberOfChannels, n=ad.numberOfFrames, fmt=ad.format||"";
  try{
    const t=new Float32Array(n);
    ad.copyTo(t,{planeIndex:p,format:"f32-planar"});
    return t;
  }catch(_){}
  const planar=fmt.indexOf("planar")!==-1;
  const plane=planar?p:0;
  const len=n*(planar?1:c);
  const out=new Float32Array(n);
  let i;
  if(fmt.indexOf("f32")===0){
    const all=new Float32Array(len); ad.copyTo(all,{planeIndex:plane});
    if(planar) out.set(all);
    else for(i=0;i<n;i++) out[i]=all[i*c+p];
  }else if(fmt.indexOf("u8")===0){
    const all=new Uint8Array(len); ad.copyTo(all,{planeIndex:plane});
    if(planar) for(i=0;i<n;i++) out[i]=(all[i]-128)/128;
    else for(i=0;i<n;i++) out[i]=(all[i*c+p]-128)/128;
  }else if(fmt.indexOf("s32")===0){
    const all=new Int32Array(len); ad.copyTo(all,{planeIndex:plane});
    if(planar) for(i=0;i<n;i++) out[i]=all[i]/2147483648;
    else for(i=0;i<n;i++) out[i]=all[i*c+p]/2147483648;
  }else{ // s16 and anything else integer-ish
    const all=new Int16Array(len); ad.copyTo(all,{planeIndex:plane});
    if(planar) for(i=0;i<n;i++) out[i]=all[i]/32768;
    else for(i=0;i<n;i++) out[i]=all[i*c+p]/32768;
  }
  return out;
}
function makeAudioBuffer(channels,frames,rate){
  const n=Math.max(1,frames);
  const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(OAC) return new OAC(1,n,rate).createBuffer(channels,n,rate);
  const ac=new (window.AudioContext||window.webkitAudioContext)();
  const b=ac.createBuffer(channels,n,rate);
  ac.close().catch(()=>{});
  return b;
}
function concatParts(parts,frames){
  const out=new Float32Array(frames);
  let p=0;
  for(const q of parts){ const take=Math.min(q.length,frames-p); if(take<=0) break; out.set(take===q.length?q:q.subarray(0,take),p); p+=take; }
  return out;
}
// Demux + WebCodecs decode → a plain AudioBuffer.
async function decodeDemuxedAudio(file,onProgress){
  if(typeof AudioDecoder==="undefined") throw new Error("WebCodecs is not available");
  const dm=await demuxAudio(file);
  const tries=[dm.codec];
  if(dm.codec.startsWith("mp4a")){ tries.push("mp4a.40.2"); if(!tries.includes("mp4a.40.5")) tries.push("mp4a.40.5"); }
  let config=null;
  for(const codec of tries){
    const c={codec,sampleRate:dm.sampleRate,numberOfChannels:dm.channels};
    if(dm.description) c.description=dm.description;
    try{
      const sup=await AudioDecoder.isConfigSupported(c);
      if(sup&&sup.supported){ config=c; break; }
    }catch(_){}
  }
  if(!config) throw new Error("this browser cannot decode "+dm.codec+" audio");

  const planes=[], errors=[];
  let rate=0, frames=0;
  const dec=new AudioDecoder({
    output(ad){
      try{
        const c=ad.numberOfChannels, n=ad.numberOfFrames;
        rate=ad.sampleRate;
        for(let p=0;p<c;p++){
          if(!planes[p]) planes[p]=[];
          planes[p].push(readPlane(ad,p));
        }
        frames+=n;
      }catch(e){ errors.push(e); }
      finally{ try{ ad.close(); }catch(_){} }
    },
    error(e){ errors.push(e); }
  });
  dec.configure(config);

  const get=sampleReader(file,dm.samples,8*1024*1024);
  const us=i=>Math.round(i*1000000/dm.timescale);
  for(let i=0;i<dm.samples.length;i++){
    if(errors.length) break;
    const s=dm.samples[i];
    dec.decode(new EncodedAudioChunk({type:"key",timestamp:us(s.cts),duration:us(s.dur),data:await get(i)}));
    if(dec.decodeQueueSize>96) await sleep(0);
    else if(i%128===0) await sleep(0);
    if(onProgress&&i%512===0) onProgress(i/dm.samples.length);
  }
  await dec.flush().catch(()=>{});
  try{ dec.close(); }catch(_){}
  if(errors.length) throw errors[0];
  if(!frames) throw new Error("the audio track decoded to nothing");

  const ch=Math.max(1,planes.length);
  const buf=makeAudioBuffer(ch,frames,rate||dm.sampleRate);
  for(let p=0;p<ch;p++){
    const total=planes[p].reduce((a,q)=>a+q.length,0);
    buf.copyToChannel(concatParts(planes[p],total),p);
  }
  return {buffer:buf,codec:dm.codec,samples:dm.samples.length};
}
// Last resort: play the file through the graph and record it in real time.
// Works even where WebCodecs and decodeAudioData both refuse MP4/MOV.
async function captureViaElement(file){
  const url=URL.createObjectURL(file);
  const el=document.createElement(isVideoFile(file)?"video":"audio");
  el.src=url; el.playsInline=true; el.preload="auto";
  const meta=new Promise((res,rej)=>{
    el.onloadedmetadata=()=>res();
    el.onerror=()=>rej(new Error("the browser cannot play this file"));
  });
  const AC=window.AudioContext||window.webkitAudioContext;
  let ac=null;
  try{
    await meta;
    if(!AC) throw new Error("no Web Audio in this browser");
    ac=new AC();
    try{ await ac.resume(); }catch(_){}
    if(ac.state!=="running") throw new Error("playback was blocked by the browser");
    const rate=ac.sampleRate;
    const src=ac.createMediaElementSource(el);
    const spn=ac.createScriptProcessor(2048,2,2);
    const mute=ac.createGain(); mute.gain.value=0;
    const planes=[[],[]];
    let stopped=false;
    spn.onaudioprocess=ev=>{
      if(stopped) return;
      planes[0].push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      if(ev.inputBuffer.numberOfChannels>1) planes[1].push(new Float32Array(ev.inputBuffer.getChannelData(1)));
    };
    src.connect(spn); spn.connect(mute); mute.connect(ac.destination);
    await el.play();
    const dur=isFinite(el.duration)?el.duration:0;
    const deadline=Date.now()+dur*1000+15000;
    await new Promise((res,rej)=>{
      const t=setInterval(()=>{
        if(el.ended||(dur&&el.currentTime>=dur-0.03)){ clearInterval(t); res(); }
        else if(Date.now()>deadline){ clearInterval(t); rej(new Error("playback stalled")); }
      },200);
    });
    stopped=true; spn.onaudioprocess=null;
    try{ src.disconnect(); spn.disconnect(); mute.disconnect(); el.pause(); }catch(_){}
    const len=planes[0].reduce((a,q)=>a+q.length,0);
    if(!len) throw new Error("no audio came out of the element");
    // A mono file played through a stereo graph leaves the second channel silent —
    // drop it so the downmix does not halve the level.
    let chs=1;
    if(planes[1].length){
      const right=concatParts(planes[1],planes[1].reduce((a,q)=>a+q.length,0));
      for(let i=0;i<right.length;i++) if(Math.abs(right[i])>1e-6){ chs=2; break; }
    }
    const buf=makeAudioBuffer(chs,len,rate);
    buf.copyToChannel(concatParts(planes[0],len),0);
    if(chs===2) buf.copyToChannel(concatParts(planes[1],len),1);
    return buf;
  }finally{
    if(ac){ try{ await ac.close(); }catch(_){} }
    el.removeAttribute("src");
    try{ el.load(); }catch(_){}
    URL.revokeObjectURL(url);
  }
}
// Audio track out of a video file, whichever way this browser can do it.
async function decodeVideoTrack(file,onProgress){
  const tries=[];
  if(typeof AudioDecoder!=="undefined"){
    try{
      const r=await decodeDemuxedAudio(file,onProgress);
      return {buffer:r.buffer,route:"WebCodecs "+r.codec+" · "+r.samples+" packets"};
    }catch(e){ tries.push("WebCodecs: "+(e.message||e)); }
  }else tries.push("WebCodecs not available");
  try{
    return {buffer:await decodeAudioFile(file),route:"decodeAudioData (whole file)"};
  }catch(e){ tries.push("decodeAudioData: "+(e.message||e)); }
  try{
    return {buffer:await captureViaElement(file),route:"real-time capture (plays the file once)"};
  }catch(e){ tries.push("real-time capture: "+(e.message||e)); }
  throw new Error("This browser cannot get the audio out of "+file.name+".\n"+tries.join("\n"));
}
