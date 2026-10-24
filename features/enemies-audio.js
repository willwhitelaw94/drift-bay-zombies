// Synthesised sounds for the enemies team (sheep baas, zombie gunfire, rockets, booms).
// Everything rides on the game's Sound instance (NZ.sound): no files, nothing fetched.
const NZ = window.NZ;
let voices = 0;
let curve = null;

function ctx() {
  return NZ.sound.ctx;
}

function panner(pos, ref = 3, roll = 1.2) {
  const p = ctx().createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.rolloffFactor = roll;
  setPan(p, pos);
  return p;
}

export function setPan(p, pos, dy = 0) {
  if (p.positionX) {
    p.positionX.value = pos.x; p.positionY.value = pos.y + dy; p.positionZ.value = pos.z;
  } else p.setPosition(pos.x, pos.y + dy, pos.z);
}

function distortion() {
  if (curve) return curve;
  curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const x = (i / 1023) * 2 - 1;
    curve[i] = Math.tanh(x * 6) * 0.8;
  }
  return curve;
}

function out(pos, ref, roll) {
  return pos ? panner(pos, ref, roll) : null;
}

function connectOut(node, pan) {
  if (pan) node.connect(pan).connect(NZ.sound.master);
  else node.connect(NZ.sound.master);
}

// A demonic sheep bleat: a saw + sub-octave through moving vowel formants, a 7 Hz goat
// tremolo, hard-clipped and placed in 3D. `angry` is the scream before a headbutt.
export function baa(pos, pitch = 1, angry = false) {
  if (!ctx() || voices > 6) return;
  const c = ctx(), t = c.currentTime;
  const dur = (angry ? 0.55 : 0.85 + Math.random() * 0.4) / Math.sqrt(pitch);
  const f0 = (angry ? 240 : 170 + Math.random() * 50) * pitch;
  const src = c.createGain();
  for (const [mul, type, g] of [[1, 'sawtooth', 0.7], [0.5, 'sawtooth', 0.55], [1.006, 'square', 0.25]]) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * mul * 0.8, t);
    o.frequency.linearRampToValueAtTime(f0 * mul * 1.08, t + 0.08);
    o.frequency.linearRampToValueAtTime(f0 * mul * (angry ? 1.3 : 0.72), t + dur);
    const vib = c.createOscillator();
    vib.frequency.value = 6.5 + Math.random() * 2;
    const vg = c.createGain();
    vg.gain.value = f0 * mul * 0.07;
    vib.connect(vg).connect(o.frequency);
    const og = c.createGain();
    og.gain.value = g;
    o.connect(og).connect(src);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }
  // Tremolo (the "a-a-a-a" of a bleat).
  const trem = c.createGain();
  trem.gain.value = 0.6;
  const lfo = c.createOscillator();
  lfo.frequency.value = angry ? 11 : 7.5;
  const lg = c.createGain();
  lg.gain.value = 0.4;
  lfo.connect(lg).connect(trem.gain);
  lfo.start(t);
  lfo.stop(t + dur + 0.05);
  src.connect(trem);
  // Formants: "m/b" (closed, low) opening into a nasal "ehh".
  const mix = c.createGain();
  for (const [a, b, q, g] of [[300, 650, 7, 1], [900, 1750, 9, 0.6], [2200, 2600, 12, 0.3]]) {
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(a, t);
    bp.frequency.exponentialRampToValueAtTime(b, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(b * 0.85, t + dur);
    const bg = c.createGain();
    bg.gain.value = g;
    trem.connect(bp).connect(bg).connect(mix);
  }
  const ws = c.createWaveShaper();
  ws.curve = distortion();
  const pre = c.createGain();
  pre.gain.value = 2.2;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(angry ? 0.75 : 0.55, t + 0.05);
  env.gain.setValueAtTime(angry ? 0.75 : 0.55, t + dur * 0.7);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  mix.connect(pre).connect(ws).connect(env);
  connectOut(env, out(pos, 2.5, 1.3));
  voices++;
  setTimeout(() => voices--, dur * 1000 + 100);
}

function noiseBurst(pos, { freq = 2000, type = 'lowpass', q = 1, end = 300, peak = 0.6, dur = 0.2, delay = 0, ref = 3, roll = 1.1 }) {
  const c = ctx(), t = c.currentTime + delay;
  const n = NZ.sound.noiseSrc();
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  f.frequency.exponentialRampToValueAtTime(end, t + dur);
  const g = c.createGain();
  NZ.sound.env(g, t, 0.002, peak, dur);
  n.connect(f).connect(g);
  connectOut(g, out(pos, ref, roll));
  n.start(t, Math.random());
  n.stop(t + dur + 0.05);
}

function tone(pos, { f0, f1, type = 'sine', peak = 0.4, dur = 0.15, delay = 0, ref = 3 }) {
  const c = ctx(), t = c.currentTime + delay;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  NZ.sound.env(g, t, 0.003, peak, dur);
  o.connect(g);
  connectOut(g, out(pos, ref, 1));
  o.start(t);
  o.stop(t + dur + 0.05);
}

export function gunshot(pos, kind) {
  if (!ctx()) return;
  if (kind === 'pistol') {
    noiseBurst(pos, { freq: 4200, end: 500, peak: 0.9, dur: 0.14 });
    tone(pos, { f0: 220, f1: 60, peak: 0.6, dur: 0.1 });
  } else {
    noiseBurst(pos, { freq: 6000, end: 350, peak: 1.0, dur: 0.18 });
    tone(pos, { f0: 140, f1: 40, peak: 0.8, dur: 0.14 });
  }
}

// Laser lock tone: a quick rising chirp. Rockets get a nastier square.
export function lockBeep(pos, rocket) {
  if (!ctx()) return;
  tone(pos, { f0: rocket ? 900 : 1500, f1: rocket ? 1800 : 2200, type: rocket ? 'square' : 'sine', peak: rocket ? 0.22 : 0.12, dur: 0.09, ref: 6 });
}

export function whizz(pos) {
  if (!ctx()) return;
  noiseBurst(pos, { freq: 5000, end: 1800, type: 'bandpass', q: 6, peak: 0.35, dur: 0.12, ref: 1.5, roll: 2 });
}

export function rocketLaunch(pos) {
  if (!ctx()) return;
  noiseBurst(pos, { freq: 300, end: 4000, type: 'bandpass', q: 1.5, peak: 1.0, dur: 0.45 });
  tone(pos, { f0: 90, f1: 45, peak: 0.8, dur: 0.3 });
}

// A looping hiss that follows a rocket: returns { pan, stop() }.
export function rocketHiss(pos) {
  if (!ctx()) return null;
  const c = ctx(), t = c.currentTime;
  const n = NZ.sound.noiseSrc(true);
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1400;
  f.Q.value = 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.1);
  const pan = panner(pos, 3, 1.1);
  n.connect(f).connect(g).connect(pan).connect(NZ.sound.master);
  n.start(t, Math.random());
  return {
    pan,
    stop() {
      const now = c.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      n.stop(now + 0.1);
    },
  };
}

export function boom(pos) {
  if (!ctx()) return;
  noiseBurst(pos, { freq: 3000, end: 80, peak: 1.6, dur: 1.1, ref: 8, roll: 0.6 });
  tone(pos, { f0: 70, f1: 24, peak: 1.6, dur: 0.8, ref: 8 });
  noiseBurst(pos, { freq: 900, end: 120, peak: 0.4, dur: 1.8, delay: 0.25, ref: 8, roll: 0.5 });
}

export function hoofs(pos) {
  if (!ctx()) return;
  noiseBurst(pos, { freq: 900, end: 200, type: 'bandpass', q: 3, peak: 0.25, dur: 0.05, ref: 2, roll: 1.6 });
}

export function headbutt() {
  if (!ctx()) return;
  tone(null, { f0: 120, f1: 50, peak: 0.9, dur: 0.18 });
  noiseBurst(null, { freq: 1200, end: 200, peak: 0.5, dur: 0.12 });
}
