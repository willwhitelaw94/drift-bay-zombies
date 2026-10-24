// Synthesised weapon sounds for features/weapons.js, added to the game's Sound instance (NZ.sound).
// Kept out of audio.js so the other feature teams' additions there never collide with these.
const S = window.NZ.sound;

// Band-passed / low-passed noise burst: the basis of every mechanical click, clack and whoosh.
function burst({ type = 'bandpass', f0 = 1500, f1 = f0, q = 1, when = 0, a = 0.002, peak = 0.3, decay = 0.08 }) {
  if (!S.ctx) return;
  const ctx = S.ctx, t = S.t + when;
  const n = S.noiseSrc();
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + a + decay);
  const g = ctx.createGain();
  S.env(g, t, a, peak, decay);
  n.connect(f).connect(g).connect(S.master);
  n.start(t, Math.random());
  n.stop(t + a + decay + 0.05);
}

function tone({ type = 'sine', f0 = 100, f1 = f0, when = 0, a = 0.002, peak = 0.5, decay = 0.2 }) {
  if (!S.ctx) return;
  const ctx = S.ctx, t = S.t + when;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + decay);
  const g = ctx.createGain();
  S.env(g, t, a, peak, decay);
  o.connect(g).connect(S.master);
  o.start(t);
  o.stop(t + a + decay + 0.05);
}

// A short metallic part moving: a click with a little ring on top.
function metal(freq, vol = 0.3, when = 0, ring = 0.25) {
  burst({ f0: freq, q: 5, when, peak: vol, decay: 0.045 });
  burst({ type: 'highpass', f0: 3500, when, peak: vol * 0.4, decay: 0.02 });
  if (ring) tone({ type: 'triangle', f0: freq * 2.3, when, peak: vol * ring, decay: 0.07 });
}

Object.assign(S, {
  shotgun() {
    // A big, chesty boom: wide noise slam, sub thump, then the valley tail.
    burst({ type: 'lowpass', f0: 6500, f1: 180, when: 0, a: 0.001, peak: 1.6, decay: 0.38 });
    burst({ type: 'highpass', f0: 2500, when: 0, a: 0.001, peak: 0.7, decay: 0.03 });
    tone({ f0: 95, f1: 32, a: 0.001, peak: 1.7, decay: 0.32 });
    tone({ type: 'square', f0: 60, f1: 30, a: 0.001, peak: 0.25, decay: 0.12 });
    burst({ type: 'lowpass', f0: 900, f1: 300, when: 0.06, a: 0.03, peak: 0.28, decay: 1.1 });
  },
  pump(when = 0) {
    // chk ... chk: forend back (scrape + hull flick), forend home (heavy clack).
    burst({ f0: 900, f1: 1600, q: 2, when, a: 0.01, peak: 0.25, decay: 0.08 });
    metal(1300, 0.45, when + 0.04, 0.2);
    burst({ f0: 1400, f1: 800, q: 2, when: when + 0.24, a: 0.01, peak: 0.2, decay: 0.06 });
    metal(850, 0.6, when + 0.3, 0.35);
    tone({ f0: 180, f1: 90, when: when + 0.3, peak: 0.25, decay: 0.06 });
  },
  shellIn() {
    metal(1700, 0.32, 0, 0.15);
    burst({ f0: 600, q: 1.5, when: 0.015, peak: 0.25, decay: 0.05 });
  },
  casing(kind = 'brass', vol = 0.12) {
    if (kind === 'hull') {
      burst({ f0: 900 + Math.random() * 300, q: 3, peak: vol * 1.4, decay: 0.05 });
      return;
    }
    const f = 3800 + Math.random() * 1600;
    tone({ f0: f, peak: vol, decay: 0.09 });
    tone({ f0: f * 1.47, peak: vol * 0.6, decay: 0.06 });
  },
  magOut() {
    metal(1200, 0.35, 0, 0.15);
    burst({ f0: 500, f1: 300, q: 1, when: 0.04, a: 0.01, peak: 0.18, decay: 0.12 });
  },
  pouch() {
    burst({ type: 'lowpass', f0: 1200, f1: 500, a: 0.04, peak: 0.12, decay: 0.16 });
  },
  magIn() {
    metal(700, 0.55, 0, 0.3);
    metal(2100, 0.3, 0.03, 0.1);
    tone({ f0: 140, f1: 70, peak: 0.3, decay: 0.07 });
  },
  chargeBack() {
    burst({ f0: 1300, f1: 2400, q: 3, a: 0.02, peak: 0.25, decay: 0.09 });
    metal(1900, 0.3, 0.08, 0.2);
  },
  chargeHome() {
    metal(1100, 0.55, 0, 0.4);
    tone({ f0: 200, f1: 110, peak: 0.25, decay: 0.05 });
  },
  boltUp() { metal(1500, 0.3, 0, 0.2); },
  boltBack() {
    burst({ f0: 1000, f1: 1900, q: 3, a: 0.02, peak: 0.3, decay: 0.1 });
    metal(2200, 0.3, 0.1, 0.25);
  },
  boltHome() {
    burst({ f0: 1800, f1: 1000, q: 3, a: 0.01, peak: 0.25, decay: 0.07 });
    metal(1000, 0.5, 0.07, 0.35);
  },
  boltDown() { metal(1300, 0.4, 0, 0.3); },
  roundIn() { metal(2600, 0.28, 0, 0.2); metal(1400, 0.2, 0.03, 0); },
  swapGun() {
    burst({ type: 'lowpass', f0: 1400, f1: 600, a: 0.03, peak: 0.14, decay: 0.14 });
    metal(1600, 0.18, 0.2, 0.15);
  },
  dryFire() { metal(2600, 0.35, 0, 0); metal(800, 0.2, 0.02, 0); },
  rpgLaunch() {
    // Ignition crack, a hollow tube whump, then the motor tearing away downrange.
    burst({ type: 'lowpass', f0: 5000, f1: 300, a: 0.001, peak: 1.3, decay: 0.3 });
    tone({ f0: 70, f1: 28, a: 0.002, peak: 1.5, decay: 0.45 });
    burst({ f0: 400, f1: 2200, q: 1.2, when: 0.02, a: 0.05, peak: 0.6, decay: 1.4 });
    burst({ type: 'highpass', f0: 3000, f1: 6000, when: 0.05, a: 0.05, peak: 0.25, decay: 1.2 });
  },
  rpgSlide() {
    burst({ f0: 500, f1: 900, q: 2, a: 0.08, peak: 0.22, decay: 0.32 });
  },
  rpgSeat() {
    metal(600, 0.6, 0, 0.35);
    tone({ f0: 160, f1: 80, peak: 0.4, decay: 0.1 });
  },
  rpgBoom(vol = 1) {
    // Fallback blast (used only when the explosives module isn't loaded).
    burst({ type: 'lowpass', f0: 3000, f1: 60, a: 0.002, peak: 1.8 * vol, decay: 1.6 });
    tone({ f0: 55, f1: 18, a: 0.002, peak: 1.8 * vol, decay: 1.0 });
    burst({ type: 'lowpass', f0: 500, f1: 120, when: 0.25, a: 0.1, peak: 0.4 * vol, decay: 2.2 });
  },
});
