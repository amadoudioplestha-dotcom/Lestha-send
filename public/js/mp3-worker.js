/* Encodage MP3 de l'enregistrement d'une réunion, au fil de l'eau (LAME, licence LGPL : /vendor/LAME-LICENSE.txt) */
importScripts('/vendor/lame.min.js');
let enc = null, out = [];
onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'init') { enc = new lamejs.Mp3Encoder(1, m.sampleRate, m.kbps); out = []; return; }
  if (!enc) return;
  if (m.cmd === 'pcm') {
    const f = m.d, i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const b = enc.encodeBuffer(i16); if (b.length) out.push(new Uint8Array(b));
  } else if (m.cmd === 'end') {
    const b = enc.flush(); if (b.length) out.push(new Uint8Array(b));
    postMessage({ blob: new Blob(out, { type: 'audio/mpeg' }) }); out = []; enc = null;
  }
};
