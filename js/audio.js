"use strict";
/* ModdedTransfer — audio conversion to 48 kHz 16-bit (mono or stereo) + sample header. */

// ---- Audio conversion ------------------------------------------------------
//   1) audio file → decodeAudioData (the browser decodes WAV/MP3/M4A/AAC/OGG/
//      AIFF/FLAC itself — every extension in AUDIO_RE arrives here, including
//      AAC, OGG/Opus and M4A/AIFF which iPadOS decodes natively);
//      video file → the audio track is extracted first (see the demuxer above)
//   2) channel mapping, computed sample by sample:
//      mono = average of ALL channels; stereo = first two channels
//      (a mono source is duplicated to L/R)
//   3) resample each channel to exactly 48000 Hz (one OfflineAudioContext
//      render per channel — no multi-channel routing subtleties)
//   4) peak-normalize (one gain over all channels, so the stereo balance is
//      preserved) when the sample's norm flag is on
//   5) quantize to 16-bit PCM in the wire byte order (WIRE_LE, Elektroid =
//      big-endian); stereo PCM is L/R-interleaved and the device splits it
//      into mid/side planes itself (el_deint on Model-TG firmware)
async function decodeAudioFile(file){
  const AC=window.AudioContext||window.webkitAudioContext;
  const ac=new AC();
  let buf;
  try{
    buf=await ac.decodeAudioData(await file.arrayBuffer());
  }finally{ try{await ac.close()}catch{} }
  return buf;
}
async function decodeTo48k(file,opts,onProgress){
  const stereo=!!(opts&&opts.stereo);
  const normalize=!!(opts&&opts.normalize);
  const video=isVideoFile(file);
  let buf,route;
  if(video){
    log(`Reading the audio track of ${file.name} (${formatBytes(file.size)})…`);
    const r=await decodeVideoTrack(file,onProgress);
    buf=r.buffer; route=r.route;
  }else{
    buf=await decodeAudioFile(file);
  }
  const ch=buf.numberOfChannels, srcRate=buf.sampleRate, srcLen=buf.length;
  const wantCh=stereo?2:1;

  let planes;
  if(!stereo){
    let mono;
    if(ch===1){
      mono=buf.getChannelData(0);
    }else{
      mono=new Float32Array(srcLen);
      const w=1/ch;
      for(let c=0;c<ch;c++){
        const d=buf.getChannelData(c);
        for(let i=0;i<srcLen;i++) mono[i]+=d[i]*w;
      }
    }
    planes=[mono];
  }else{
    const L=buf.getChannelData(0);
    planes=[L, ch>1?buf.getChannelData(1):L];
  }

  const frames=Math.max(1,Math.round(srcLen*48000/srcRate));
  let data;
  const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(OAC){
    data=[];
    for(let c=0;c<wantCh;c++){
      const off=new OAC(1,frames,48000);
      const b=off.createBuffer(1,srcLen,srcRate);
      b.copyToChannel(planes[c],0);
      const s=off.createBufferSource(); s.buffer=b;
      s.connect(off.destination); s.start(0);
      const rendered=await off.startRendering();
      data.push(rendered.getChannelData(0));
    }
  }else{
    data=planes.map(p=>{
      const d=new Float32Array(frames);
      for(let i=0;i<frames;i++){
        const pos=i*(srcLen-1)/Math.max(1,frames-1);
        const i0=Math.floor(pos), i1=Math.min(srcLen-1,i0+1), f=pos-i0;
        d[i]=p[i0]*(1-f)+p[i1]*f;
      }
      return d;
    });
  }

  // Peak-normalize to just under 0 dB when this sample's flag is on.
  let normGain=1;
  if(normalize){
    let peak=0;
    for(let c=0;c<wantCh;c++){
      const d=data[c];
      for(let i=0;i<d.length;i++){ const a=Math.abs(d[i]); if(a>peak) peak=a; }
    }
    if(peak>0){
      normGain=0.99/peak;
      if(normGain!==1) for(let c=0;c<wantCh;c++){
        const d=data[c];
        for(let i=0;i<d.length;i++) d[i]*=normGain;
      }
    }
  }

  const pcm=new Uint8Array(frames*wantCh*2);
  const dv=new DataView(pcm.buffer);
  for(let i=0;i<frames;i++) for(let c=0;c<wantCh;c++){
    const v=Math.max(-1,Math.min(1,data[c][i]));
    dv.setInt16((i*wantCh+c)*2, Math.round(v<0?v*32768:v*32767), WIRE_LE);
  }
  return {pcm,frames,channels:wantCh,srcRate,srcChannels:ch,video,route:route||"decodeAudioData",normGain};
}

// struct elektron_sample_header (64 bytes; 32-bit fields in wire order = WIRE_LE,
// Elektroid sends g_htonl() values → big-endian):
//   type(1) stereo(1) rsvd0(2) size(4) rate(4) loop_start(4) loop_end(4)
//   loop_type(1) rsvd1(3) padding(40)
// size = PCM bytes only (header excluded), rate = 48000, stereo = 0/1,
// loop_type = 0x7f (no loop). Stereo PCM is L/R-interleaved (frames*4 bytes);
// the Model-TG firmware de-interleaves it into mid/side planes itself.
function buildHeader(pcmByteCount,stereo){
  const h=new Uint8Array(64),dv=new DataView(h.buffer);
  h[0]=0;h[1]=stereo?1:0;
  dv.setUint32(4,pcmByteCount,WIRE_LE);
  dv.setUint32(8,48000,WIRE_LE);
  dv.setUint32(12,0,WIRE_LE);
  dv.setUint32(16,0,WIRE_LE);
  h[20]=0x7f;
  return h;
}
