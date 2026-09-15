console.log('[Value Watch] offscreen loading. chrome APIs:', {
  chrome: typeof chrome,
  runtime: typeof chrome?.runtime,
  storage: typeof chrome?.storage
});

let audio = null;

function generateSirenWavBlob() {
  const sampleRate = 44100;
  const duration = 0.5;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Int16Array(numSamples);
  const amplitude = Math.round(0.85 * 32767);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = t < 0.25 ? 800 : 1200;
    const wave = Math.sign(Math.sin(2 * Math.PI * freq * t));
    samples[i] = wave * amplitude;
  }

  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Int16Array(buffer, 44).set(samples);
  return new Blob([buffer], { type: 'audio/wav' });
}

function ensureAudio() {
  if (audio) return audio;
  const blob = generateSirenWavBlob();
  audio = new Audio(URL.createObjectURL(blob));
  audio.loop = true;
  audio.volume = 1.0;
  console.log('[Value Watch] audio element created, src blob URL:', audio.src);
  return audio;
}

function startSiren() {
  const a = ensureAudio();
  a.play()
    .then(() => console.log('[Value Watch] siren playing'))
    .catch(err => console.error('[Value Watch] audio.play() failed:', err.name, err.message));
}

function stopSiren() {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  console.log('[Value Watch] siren stopped');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  console.log('[Value Watch] offscreen received:', msg.type);
  if (msg.type === 'startSiren') startSiren();
  else if (msg.type === 'stopSiren') stopSiren();
  sendResponse({ ok: true });
  return true;
});

console.log('[Value Watch] offscreen ready, requesting current state');
chrome.runtime.sendMessage({ type: 'offscreenReady' }).catch(err => {
  console.warn('[Value Watch] offscreenReady message failed:', err);
});
