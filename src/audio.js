// Procedural WebAudio sound effects — placeholders until real audio assets
// are added. Each named sound below maps 1:1 to a future asset file
// (see README), so swapping in real .mp3/.ogg files is a one-line change.

let ctx = null;
let master = null;

export function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
}

export function resumeAudio() {
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function noiseBuffer(seconds) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envGain(t0, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + decay);
  g.connect(master);
  return g;
}

function burst({ duration = 0.25, peak = 0.8, filterFreq = 1200, filterType = 'lowpass', detune = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(duration);
  src.detune.value = detune;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.setValueAtTime(filterFreq, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(80, filterFreq * 0.2), t0 + duration);
  src.connect(f);
  f.connect(envGain(t0, peak, duration));
  src.start(t0);
}

function tone({ freq = 440, duration = 0.2, peak = 0.3, type = 'sine', slideTo = null }) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
  osc.connect(envGain(t0, peak, duration));
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export const sfx = {
  pistolShot()  { burst({ duration: 0.16, peak: 0.65, filterFreq: 2400 }); tone({ freq: 160, duration: 0.08, peak: 0.3, type: 'square', slideTo: 60 }); },
  smgShot()     { burst({ duration: 0.10, peak: 0.5,  filterFreq: 3000 }); tone({ freq: 200, duration: 0.05, peak: 0.22, type: 'square', slideTo: 90 }); },
  rifleShot()   { burst({ duration: 0.22, peak: 0.75, filterFreq: 1800 }); tone({ freq: 120, duration: 0.12, peak: 0.35, type: 'square', slideTo: 45 }); },
  shotgunShot() { burst({ duration: 0.35, peak: 0.9,  filterFreq: 900 });  tone({ freq: 90,  duration: 0.18, peak: 0.4,  type: 'square', slideTo: 35 }); },
  dryFire()     { tone({ freq: 900, duration: 0.05, peak: 0.15, type: 'square' }); },
  reload()      { tone({ freq: 500, duration: 0.07, peak: 0.18, type: 'square', slideTo: 300 });
                  setTimeout(() => tone({ freq: 350, duration: 0.07, peak: 0.18, type: 'square', slideTo: 600 }), 280); },
  fleshHit()    { burst({ duration: 0.12, peak: 0.45, filterFreq: 500 }); },
  headPop()     { burst({ duration: 0.2, peak: 0.6, filterFreq: 700 }); tone({ freq: 300, duration: 0.1, peak: 0.2, slideTo: 80 }); },
  zombieGroan() { const f = 70 + Math.random() * 60;
                  tone({ freq: f, duration: 0.9 + Math.random() * 0.6, peak: 0.16, type: 'sawtooth', slideTo: f * (0.6 + Math.random() * 0.3) }); },
  zombieAttack(){ burst({ duration: 0.25, peak: 0.4, filterFreq: 600 });
                  tone({ freq: 150, duration: 0.3, peak: 0.2, type: 'sawtooth', slideTo: 70 }); },
  playerHurt()  { tone({ freq: 220, duration: 0.35, peak: 0.4, type: 'sawtooth', slideTo: 90 }); },
  purchase()    { tone({ freq: 660, duration: 0.1, peak: 0.25 }); setTimeout(() => tone({ freq: 990, duration: 0.18, peak: 0.25 }), 100); },
  denied()      { tone({ freq: 220, duration: 0.18, peak: 0.25, type: 'square' }); setTimeout(() => tone({ freq: 160, duration: 0.22, peak: 0.25, type: 'square' }), 140); },
  doorOpen()    { burst({ duration: 0.6, peak: 0.45, filterFreq: 400 }); },
  upgrade()     { [440, 554, 659, 880].forEach((f, i) => setTimeout(() => tone({ freq: f, duration: 0.3, peak: 0.22 }), i * 120)); },
  roundStart()  { tone({ freq: 110, duration: 1.6, peak: 0.3, type: 'sawtooth', slideTo: 55 });
                  setTimeout(() => tone({ freq: 110, duration: 1.6, peak: 0.3, type: 'sawtooth', slideTo: 55 }), 700); },
  roundEnd()    { [330, 262, 220, 165].forEach((f, i) => setTimeout(() => tone({ freq: f, duration: 0.5, peak: 0.2, type: 'triangle' }), i * 260)); },
};
