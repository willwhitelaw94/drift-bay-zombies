// Every sound is synthesised with WebAudio: no audio files, nothing to fetch.
export class Sound {
  constructor() {
    this.ctx = null;
    this.groans = 0;
  }

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.ambience();
  }

  suspend() {
    if (this.ctx) this.ctx.suspend();
  }

  get t() {
    return this.ctx.currentTime;
  }

  env(gain, t, a, peak, dcy) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
  }

  noiseSrc(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    return s;
  }

  ambience() {
    const ctx = this.ctx;
    // Wind: band-limited noise with a slow swell.
    const wind = this.noiseSrc(true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const wg = ctx.createGain();
    wg.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain).connect(wg.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.11;
    const lfo2g = ctx.createGain();
    lfo2g.gain.value = 160;
    lfo2.connect(lfo2g).connect(lp.frequency);
    wind.connect(lp).connect(wg).connect(this.master);
    wind.start();
    lfo.start();
    lfo2.start();
    // Drone: two detuned low saws, swelled during rounds.
    this.drone = ctx.createGain();
    this.drone.gain.value = 0.0;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 220;
    for (const f of [55, 55.4, 82.6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(dl);
      o.start();
    }
    dl.connect(this.drone).connect(this.master);
  }

  setDrone(level) {
    if (!this.ctx) return;
    this.drone.gain.setTargetAtTime(level, this.t, 2.5);
  }

  listener(pos, fwd) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  sniper() {
    // Heavier crack with a long valley echo, then the bolt.
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const n = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(7000, t);
    f.frequency.exponentialRampToValueAtTime(250, t + 0.4);
    const g = ctx.createGain();
    this.env(g, t, 0.001, 1.3, 0.45);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.5);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.3);
    const og = ctx.createGain();
    this.env(og, t, 0.001, 1.4, 0.35);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
    const echo = this.noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 600;
    const eg = ctx.createGain();
    this.env(eg, t + 0.35, 0.05, 0.25, 1.6);
    echo.connect(bp).connect(eg).connect(this.master);
    echo.start(t + 0.35, Math.random());
    echo.stop(t + 2.1);
    setTimeout(() => { this.click(1400, 0, 0.35); setTimeout(() => this.click(900, 0, 0.35), 160); }, 520);
  }

  shot() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const n = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5200, t);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.22);
    const g = ctx.createGain();
    this.env(g, t, 0.002, 0.9, 0.25);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.3);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    const og = ctx.createGain();
    this.env(og, t, 0.002, 1.0, 0.18);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.22);
    // A little room tail.
    const tail = this.noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    const tg = ctx.createGain();
    this.env(tg, t + 0.03, 0.02, 0.12, 0.6);
    tail.connect(bp).connect(tg).connect(this.master);
    tail.start(t + 0.03, Math.random());
    tail.stop(t + 0.75);
  }

  click(freq = 2400, when = 0, vol = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t + when;
    const n = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 4;
    const g = ctx.createGain();
    this.env(g, t, 0.001, vol, 0.05);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.08);
  }

  reload() {
    this.click(1800, 0.15, 0.3);
    this.click(900, 0.5, 0.35);
    this.click(2600, 1.45, 0.3);
    this.click(1400, 1.85, 0.4);
  }

  hit(kill) {
    this.click(kill ? 3800 : 5200, 0, kill ? 0.35 : 0.2);
  }

  thud(vol = 0.6) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const g = ctx.createGain();
    this.env(g, t, 0.005, vol, 0.25);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.3);
  }

  hurt() {
    this.thud(0.9);
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const n = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    const g = ctx.createGain();
    this.env(g, t, 0.01, 0.5, 0.3);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.4);
  }

  knife() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const n = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(1500, t);
    f.frequency.exponentialRampToValueAtTime(5000, t + 0.15);
    const g = ctx.createGain();
    this.env(g, t, 0.03, 0.25, 0.12);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  // A zombie moan, placed in 3D at `pos`.
  groan(pos, pitch = 1, angry = false) {
    if (!this.ctx || this.groans > 5) return;
    const ctx = this.ctx, t = this.t;
    const dur = angry ? 0.7 : 1.1 + Math.random() * 0.9;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = (angry ? 120 : 75 + Math.random() * 40) * pitch;
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * (0.75 + Math.random() * 0.5), t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5 + Math.random() * 5;
    const vg = ctx.createGain();
    vg.gain.value = base * 0.05;
    vib.connect(vg).connect(o.frequency);
    const mix = ctx.createGain();
    mix.gain.value = 1;
    for (const [fr, q, gv] of [[500 + Math.random() * 200, 6, 0.7], [1100 + Math.random() * 300, 8, 0.4], [2400, 10, 0.15]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fr;
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = gv;
      o.connect(bp).connect(bg).connect(mix);
    }
    const n = this.noiseSrc();
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass';
    nb.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.value = angry ? 0.5 : 0.25;
    n.connect(nb).connect(ng).connect(mix);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(angry ? 1.2 : 0.8, t + 0.15);
    g.gain.setValueAtTime(angry ? 1.2 : 0.8, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = 2.5;
    pan.rolloffFactor = 1.3;
    if (pan.positionX) {
      pan.positionX.value = pos.x; pan.positionY.value = pos.y + 1.5; pan.positionZ.value = pos.z;
    } else pan.setPosition(pos.x, pos.y + 1.5, pos.z);
    mix.connect(g).connect(pan).connect(this.master);
    o.start(t);
    vib.start(t);
    n.start(t, Math.random());
    o.stop(t + dur);
    vib.stop(t + dur);
    n.stop(t + dur);
    this.groans++;
    o.onended = () => { this.groans--; };
  }

  bell(freqs, when, dur, vol) {
    const ctx = this.ctx, t = this.t + when;
    for (const [f, a] of freqs) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      this.env(g, t, 0.01, vol * a, dur);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  roundStart() {
    if (!this.ctx) return;
    // Tolling minor bell + a low swell.
    for (let i = 0; i < 3; i++) this.bell([[110, 1], [131, 0.5], [165, 0.6], [220, 0.35], [262, 0.2], [497, 0.1]], i * 1.1, 3.2, 0.32);
    this.thud(0.7);
  }

  roundEnd() {
    if (!this.ctx) return;
    const notes = [392, 349, 311, 294, 262, 233];
    notes.forEach((f, i) => this.bell([[f, 1], [f * 2, 0.25], [f * 1.5, 0.15]], i * 0.32, 1.6, 0.18));
  }

  powerup() {
    if (!this.ctx) return;
    [523, 659, 784, 1047].forEach((f, i) => this.bell([[f, 1], [f * 2.01, 0.3]], i * 0.08, 0.9, 0.16));
  }

  heartbeat() {
    this.thud(0.5);
    setTimeout(() => this.thud(0.35), 180);
  }

  say(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.pitch = 0.1;
      u.rate = 0.75;
      u.volume = 0.9;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      // Speech is a garnish; the on-screen message carries it.
    }
  }
}
