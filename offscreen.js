// ============================================================================
// offscreen.js — Audio playback worker
// ----------------------------------------------------------------------------
// Manifest V3 service workers cannot use the <audio> element or the Web
// Audio API. The workaround is an "offscreen document": a hidden HTML page
// Chrome hosts for us in the background, whose sole purpose here is to play
// a siren sound when the background worker asks it to.
//
// The document is created by background.js via chrome.offscreen.createDocument
// and torn down by Chrome when idle. This script:
//   1. Synthesizes a two-tone square-wave WAV in memory (no bundled audio
//      asset — the siren is generated from scratch at first play).
//   2. Listens for `startSiren` / `stopSiren` messages from background.js.
//   3. On load, tells background.js it's ready so an in-flight alert can
//      be resumed if the previous offscreen doc was torn down mid-alert.
// ============================================================================


// Diagnostic log — confirms which Chrome APIs are available in this context.
// Offscreen documents have a limited chrome.* surface; useful when
// debugging permission issues.
console.log('[Value Watch] offscreen loading. chrome APIs:', {
  chrome: typeof chrome,
  runtime: typeof chrome?.runtime,
  storage: typeof chrome?.storage
});

// Single HTMLAudioElement, created lazily on first play. Kept in module
// scope so start/stop share the same instance.
let audio = null;


// ---------------------------------------------------------------------------
// Synthesize the siren as a WAV blob
// ---------------------------------------------------------------------------
// A WAV file = 44-byte header + raw PCM samples. We build both from scratch
// so we don't need to ship an audio asset in the extension bundle. The
// samples describe a 0.5-second sound: 800 Hz for the first quarter, then
// 1200 Hz — an alternating two-tone siren pattern when looped.

function generateSirenWavBlob() {
  const sampleRate = 44100;        // CD-quality sample rate (Hz)
  const duration = 0.5;            // total length in seconds
  const numSamples = Math.floor(sampleRate * duration);

  // 16-bit signed PCM samples. Int16 max is 32767; scale by 0.85 to leave
  // a bit of headroom so playback doesn't clip on any hardware.
  const samples = new Int16Array(numSamples);
  const amplitude = Math.round(0.85 * 32767);

  // Generate the waveform. `Math.sign(sin(...))` produces a square wave
  // (a much harsher, more attention-grabbing sound than a pure sine).
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = t < 0.25 ? 800 : 1200;  // switch tone halfway through
    const wave = Math.sign(Math.sin(2 * Math.PI * freq * t));
    samples[i] = wave * amplitude;
  }

  // Build the WAV container. See http://soundfile.sapp.org/doc/WaveFormat/
  // for the field-by-field layout. Everything is little-endian.
  const dataSize = samples.length * 2;      // 2 bytes per Int16 sample
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // "RIFF" chunk header
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);   // file size minus 8
  writeStr(8, 'WAVE');
  // "fmt " sub-chunk describing the audio format
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // audio format: 1 = PCM
  view.setUint16(22, 1, true);              // channels: 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  // "data" sub-chunk containing the actual samples
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // Copy the sample array into the buffer immediately after the header.
  new Int16Array(buffer, 44).set(samples);

  return new Blob([buffer], { type: 'audio/wav' });
}


// ---------------------------------------------------------------------------
// Audio element lifecycle
// ---------------------------------------------------------------------------

// Lazy-init the audio element on first play. We generate the WAV, wrap it
// in a blob URL, and hand it to <audio>. Loop mode makes the half-second
// clip play indefinitely until we pause it.
function ensureAudio() {
  if (audio) return audio;
  const blob = generateSirenWavBlob();
  audio = new Audio(URL.createObjectURL(blob));
  audio.loop = true;
  audio.volume = 1.0;
  console.log('[Value Watch] audio element created, src blob URL:', audio.src);
  return audio;
}

// Start (or resume) playback. play() returns a promise that rejects if
// browser autoplay policy blocks us — we log rather than throw because
// there's nothing meaningful we can do about it here.
function startSiren() {
  const a = ensureAudio();
  a.play()
    .then(() => console.log('[Value Watch] siren playing'))
    .catch(err => console.error('[Value Watch] audio.play() failed:', err.name, err.message));
}

// Pause and rewind to the start, so the next startSiren() begins fresh
// rather than continuing from wherever the loop happened to be.
function stopSiren() {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  console.log('[Value Watch] siren stopped');
}


// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
// chrome.runtime.sendMessage broadcasts to every context of the extension,
// so we filter: only handle messages tagged `target: 'offscreen'`, and
// only from our own extension (sender.id check).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (sender.id !== chrome.runtime.id) return;  // SECURITY: same-extension only

  console.log('[Value Watch] offscreen received:', msg.type);
  if (msg.type === 'startSiren') startSiren();
  else if (msg.type === 'stopSiren') stopSiren();

  sendResponse({ ok: true });
  return true;   // keeps the message channel open for the async response
});


// ---------------------------------------------------------------------------
// Ready handshake
// ---------------------------------------------------------------------------
// Tell the background worker we've finished loading. If it turns out an
// alert is currently active (e.g. the previous offscreen doc was torn down
// mid-alert), the worker will send us a startSiren so audio resumes.

console.log('[Value Watch] offscreen ready, requesting current state');
chrome.runtime.sendMessage({ type: 'offscreenReady' }).catch(err => {
  console.warn('[Value Watch] offscreenReady message failed:', err);
});
