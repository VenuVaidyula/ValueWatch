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
// Synthesize the alert chime as a WAV blob
// ---------------------------------------------------------------------------
// A WAV file = 44-byte header + raw PCM samples. We build both from scratch
// so we don't need to ship an audio asset in the extension bundle. The
// samples describe a gentle two-note "doorbell" chime:
//
//   • Note 1: A5 (880 Hz) sine wave, 0.5s, exponential decay envelope
//   • Note 2: E5 (659 Hz) sine wave, 0.5s, exponential decay envelope
//   • Silent gap: 0.3s tail before the audio element loops back
//
// Pure sine waves (rather than the earlier square wave) sound rounded and
// non-piercing. The exponential envelope makes each note feel like a struck
// bell rather than a raw tone. Overall amplitude is capped at 50% to keep
// the loudness moderate without needing users to adjust system volume.

function generateChimeWavBlob() {
  const sampleRate = 44100;        // CD-quality sample rate (Hz)

  const noteDuration = 0.5;        // seconds per note
  const gapDuration  = 0.3;        // silent tail before the loop restarts
  const totalDuration = 2 * noteDuration + gapDuration;
  const numSamples = Math.floor(sampleRate * totalDuration);

  // 16-bit signed PCM samples. Int16 max is 32767; scale by 0.5 to keep
  // the chime deliberately quieter than the previous siren.
  const samples = new Int16Array(numSamples);
  const peakAmplitude = 0.5 * 32767;

  // Musical notes (descending doorbell feel).
  const NOTE_1_HZ = 880;   // A5
  const NOTE_2_HZ = 659;   // E5

  // Envelope shape: fast linear attack, then exponential decay.
  //   • attackSec — how quickly the note ramps up from silence to full
  //     amplitude. Very short (10 ms) so the strike feels crisp, but not
  //     zero (a zero-duration attack causes an audible click).
  //   • decayTau  — the exponential decay time constant. Larger = the note
  //     rings longer before fading out.
  const attackSec = 0.01;
  const decayTau  = 0.18;

  // envelope(t) → amplitude multiplier in [0, 1] for time `t` into a note.
  const envelope = (t) => {
    if (t < attackSec) return t / attackSec;                 // linear rise
    return Math.exp(-(t - attackSec) / decayTau);            // exponential fall
  };

  // Generate one sample at a time. Anything past the two notes stays at
  // zero, producing the silent gap.
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sampleValue = 0;

    if (t < noteDuration) {
      // First note (A5)
      const localT = t;
      const env = envelope(localT);
      sampleValue = Math.sin(2 * Math.PI * NOTE_1_HZ * localT) * env * peakAmplitude;
    } else if (t < 2 * noteDuration) {
      // Second note (E5)
      const localT = t - noteDuration;
      const env = envelope(localT);
      sampleValue = Math.sin(2 * Math.PI * NOTE_2_HZ * localT) * env * peakAmplitude;
    }
    // else: silent gap — sampleValue stays 0.

    samples[i] = Math.round(sampleValue);
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
// in a blob URL, and hand it to <audio>. Loop mode makes the ~1.3-second
// chime clip play indefinitely until we pause it.
function ensureAudio() {
  if (audio) return audio;
  const blob = generateChimeWavBlob();
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
