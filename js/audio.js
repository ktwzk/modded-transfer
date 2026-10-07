"use strict";
/* ModdedTransfer — audio conversion to 48 kHz mono 16-bit + sample header. */

// ---- Audio conversion ------------------------------------------------------
//   1) audio file → decodeAudioData (the browser decodes WAV/MP3/M4A/AAC/OGG/
//      AIFF/FLAC itself — every extension in AUDIO_RE arrives here, including
//      AAC, OGG/Opus and M4A/AIFF which iPadOS decodes natively);
//      video file → the audio track is extracted first (see the demuxer above)
//   2) manual downmix: mono = average of ALL channels, computed sample by sample
//   3) resample the mono buffer to exactly 48000 Hz
//   4) quantize to 16-bit PCM in the wire byte order (WIRE_LE, Elektroid = big-endian)
async function decodeAudioFile(file){
  const AC=window.AudioContext||window.webkitAudioContext;
  const ac=new AC();
  let buf;
  try{
    buf=await ac.decodeAudioData(await file.arrayBuffer());
  }finally{ try{await ac.close()}catch{} }
  return buf;
}
async function decodeToMono48k(file,onProgress){
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

  const frames=Math.max(1,Math.round(srcLen*48000/srcRate));
  let data;
  const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(OAC){
    const off=new OAC(1,frames,48000);
    const b=off.createBuffer(1,srcLen,srcRate);
    b.copyToChannel(mono,0);
    const s=off.createBufferSource(); s.buffer=b;
    s.connect(off.destination); s.start(0);
    const rendered=await off.startRendering();
    data=rendered.getChannelData(0);
  }else{
    data=new Float32Array(frames);
    for(let i=0;i<frames;i++){
      const pos=i*(srcLen-1)/Math.max(1,frames-1);
      const i0=Math.floor(pos), i1=Math.min(srcLen-1,i0+1), f=pos-i0;
      data[i]=mono[i0]*(1-f)+mono[i1]*f;
    }
  }

  // Peak-normalize to just under 0 dB when the option is on — the same buffer
  // is auditioned and uploaded, so what you hear is what lands on the device.
  let normGain=1;
  if(state.normalize){
    let peak=0;
    for(let i=0;i<data.length;i++){ const a=Math.abs(data[i]); if(a>peak) peak=a; }
    if(peak>0){
      normGain=0.99/peak;
      if(normGain!==1) for(let i=0;i<data.length;i++) data[i]*=normGain;
    }
  }

  const pcm=new Uint8Array(data.length*2);
  const dv=new DataView(pcm.buffer);
  for(let i=0;i<data.length;i++){
    const v=Math.max(-1,Math.min(1,data[i]));
    dv.setInt16(i*2, Math.round(v<0?v*32768:v*32767), WIRE_LE);
  }
  return {pcm,frames:data.length,srcRate,srcChannels:ch,video,route:route||"decodeAudioData",normGain};
}

// struct elektron_sample_header (64 bytes; 32-bit fields in wire order = WIRE_LE,
// Elektroid sends g_htonl() values → big-endian):
//   type(1) stereo(1) rsvd0(2) size(4) rate(4) loop_start(4) loop_end(4)
//   loop_type(1) rsvd1(3) padding(40)
// size = PCM bytes only (header excluded), rate = 48000, stereo = 0, loop_type = 0x7f (no loop).
function buildHeader(pcmByteCount){
  const h=new Uint8Array(64),dv=new DataView(h.buffer);
  h[0]=0;h[1]=0;
  dv.setUint32(4,pcmByteCount,WIRE_LE);
  dv.setUint32(8,48000,WIRE_LE);
  dv.setUint32(12,0,WIRE_LE);
  dv.setUint32(16,0,WIRE_LE);
  h[20]=0x7f;
  return h;
}
