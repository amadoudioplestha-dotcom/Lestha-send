/* Encodage MP3 de l'enregistrement d'une réunion, au fil de l'eau (LAME, licence LGPL : /vendor/LAME-LICENSE.txt)
   rate (facultatif) : fréquence de sortie plus basse, pour la voix seule (replay léger : 24 kHz) */
importScripts('/vendor/lame.min.js');
let enc = null, out = [], step = 1, pos = 0, prev = 0;
function resample(f) {
  if (step === 1) return f;
  // Petit filtre passe-bas (moyenne de 2) puis interpolation linéaire ; « pos » continue d'un bloc à l'autre
  const res = [];
  const at = (i) => i < 0 ? prev : f[i];
  for (; pos < f.length - 1; pos += step) {
    const i = Math.floor(pos), k = pos - i;
    const a = (at(i) + at(i - 1)) / 2, b = (at(i + 1) + at(i)) / 2;
    res.push(a + (b - a) * k);
  }
  pos -= f.length; prev = f[f.length - 1];
  return res;
}
onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'init') {
    const rate = m.rate && m.rate < m.sampleRate ? m.rate : m.sampleRate;
    step = m.sampleRate / rate; pos = 0; prev = 0;
    enc = new lamejs.Mp3Encoder(1, rate, m.kbps); out = []; return;
  }
  if (!enc) return;
  if (m.cmd === 'pcm') {
    const f = resample(m.d), i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const b = enc.encodeBuffer(i16); if (b.length) out.push(new Uint8Array(b));
  } else if (m.cmd === 'end') {
    const b = enc.flush(); if (b.length) out.push(new Uint8Array(b));
    postMessage({ blob: new Blob(out, { type: 'audio/mpeg' }) }); out = []; enc = null;
  }
};
