// META: announcer callouts, synthesised stings, multi-kills ("DOUBLE KILL"…) and
// same-shot kills ("2 FOR 1", "3 FOR 1", "COLLATERAL") with a points multiplier.
// Exposes NZ.meta.{callout, sting, say} for the other meta modules.
const NZ = window.NZ;

// ------------------------------------------------------------------ DOM + CSS
const css = document.createElement('style');
css.textContent = `
#nzm-callouts, #nzm-callouts2 { position: absolute; left: 0; right: 0; top: 32%; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
.nzm-co { text-align: center; text-transform: uppercase; animation: nzm-in .5s cubic-bezier(.2,1.6,.4,1) both, nzm-shake .28s .05s linear 2; }
.nzm-co.out { animation: nzm-out .45s ease-in forwards; }
.nzm-co b { display: block; font: italic 700 58px/1 "Oswald", "Helvetica Neue", Arial, sans-serif; letter-spacing: .03em;
  background: linear-gradient(180deg, #fffbe6 0%, #ffe48a 45%, #f29a1e 70%, #c4520c 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
  -webkit-text-stroke: 1.5px rgba(40,10,0,.85); filter: drop-shadow(0 0 10px rgba(255,140,30,.75)) drop-shadow(3px 4px 0 rgba(0,0,0,.85)); padding: 0 12px; }
.nzm-co small { display: block; margin-top: 2px; font: 600 20px/1.1 "Oswald", sans-serif; letter-spacing: .22em; color: #ffe28a; text-shadow: 0 0 8px #000, 0 0 3px #000; }
.nzm-co.collat b { font-size: 44px; background: linear-gradient(180deg, #fff 0%, #ffb3a6 45%, #e3261a 75%, #8a0b05 100%); -webkit-background-clip: text; background-clip: text;
  filter: drop-shadow(0 0 10px rgba(255,40,20,.75)) drop-shadow(3px 4px 0 rgba(0,0,0,.85)); }
.nzm-co.reward b { font-size: 38px; background: linear-gradient(180deg, #f2fff0 0%, #b9ff8f 50%, #3aa83f 100%); -webkit-background-clip: text; background-clip: text;
  filter: drop-shadow(0 0 10px rgba(80,255,120,.6)) drop-shadow(2px 3px 0 rgba(0,0,0,.85)); }
.nzm-co.reward small { color: #d8ffc8; }
.nzm-co.horde b { font: 400 92px/1 "Creepster", "Oswald", serif; letter-spacing: .06em; background: linear-gradient(180deg, #fff 0%, #ff8d7a 35%, #d0160b 70%, #5c0602 100%);
  -webkit-background-clip: text; background-clip: text; filter: drop-shadow(0 0 22px rgba(255,20,0,.85)) drop-shadow(4px 5px 0 rgba(0,0,0,.9)); }
.nzm-co.horde small { font-size: 22px; color: #ffd0c4; letter-spacing: .3em; }
.nzm-co.horde { animation: nzm-in .6s cubic-bezier(.2,1.6,.4,1) both, nzm-shake .22s .05s linear 6; }
.nzm-co.lost b { font-size: 26px; background: none; color: #ff6a50; -webkit-text-stroke: 0; filter: drop-shadow(0 0 6px #000); }
#nzm-callouts2 { top: 67%; }
@keyframes nzm-in { 0% { opacity: 0; transform: scale(2.4); filter: blur(6px); } 60% { opacity: 1; filter: none; } 100% { opacity: 1; transform: scale(1); } }
@keyframes nzm-out { to { opacity: 0; transform: translateY(-18px) scale(.92); } }
@keyframes nzm-shake { 0%,100% { translate: 0 0; } 25% { translate: -5px 2px; } 50% { translate: 4px -3px; } 75% { translate: -3px -1px; } }
`;
document.head.appendChild(css);
const box = document.createElement('div');
box.id = 'nzm-callouts';
const box2 = document.createElement('div'); // rewards + streak messages sit low, clear of the crosshair
box2.id = 'nzm-callouts2';
NZ.$('hud').append(box, box2);

// One element per slot ('multi', 'collat', 'reward', 'horde'…): a new callout in a slot replaces the old one.
const slots = {};
function callout(text, { kind = 'multi', sub = '', secs = 1.8, slot = kind } = {}) {
  const old = slots[slot];
  if (old) old.el.remove(), clearTimeout(old.timer);
  const el = document.createElement('div');
  el.className = 'nzm-co ' + kind;
  el.innerHTML = `<b></b>${sub ? '<small></small>' : ''}`;
  el.firstChild.textContent = text;
  if (sub) el.lastChild.textContent = sub;
  const order = { horde: 0, multi: 1, collat: 2, reward: 3, lost: 4 };
  el.style.order = order[kind] ?? 5;
  (kind === 'reward' || kind === 'lost' ? box2 : box).appendChild(el);
  const s = { el, timer: 0 };
  s.timer = setTimeout(() => {
    el.classList.add('out');
    s.timer = setTimeout(() => { el.remove(); if (slots[slot] === s) delete slots[slot]; }, 450);
  }, secs * 1000);
  slots[slot] = s;
  return el;
}

// ------------------------------------------------------------------ synthesised stings
function ctx() {
  const S = NZ.sound;
  return S.ctx && S.ctx.state !== 'closed' ? S : null;
}
function osc(S, type, f0, f1, t, dur, peak, dest, filter) {
  const o = S.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.9);
  const g = S.ctx.createGain();
  S.env(g, t, 0.006, peak, dur);
  if (filter) o.connect(filter).connect(g);
  else o.connect(g);
  g.connect(dest || S.master);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}
function noise(S, t, dur, peak, type, f0, f1, q = 1) {
  const n = S.noiseSrc();
  const f = S.ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = S.ctx.createGain();
  S.env(g, t, Math.min(0.08, dur * 0.3), peak, dur);
  n.connect(f).connect(g).connect(S.master);
  n.start(t, Math.random());
  n.stop(t + dur + 0.1);
}
function boom(S, t, vol = 1) {
  osc(S, 'sine', 120, 32, t, 0.7, 1.1 * vol);
  noise(S, t, 0.9, 0.7 * vol, 'lowpass', 2400, 120);
}
// A brassy stab: detuned saws through a swept low-pass.
function stab(S, t, root, dur, vol) {
  const f = S.ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 6;
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(4200, t + 0.06);
  f.frequency.exponentialRampToValueAtTime(700, t + dur);
  for (const [m, d] of [[1, 0], [1, 7], [1.5, -5], [2, 4], [2.52, 0]]) osc(S, 'sawtooth', root * m * Math.pow(2, d / 1200), root * m * Math.pow(2, d / 1200), t, dur, vol * 0.22, null, f);
}

function sting(kind, tier = 1) {
  const S = ctx();
  if (!S) return;
  const t = S.t + 0.01;
  if (kind === 'multi') {
    noise(S, t - 0.0, 0.18, 0.35, 'bandpass', 600, 5000, 2); // riser
    const root = 110 * Math.pow(2, (tier * 2) / 12);
    stab(S, t + 0.12, root, 0.55, 1);
    if (tier >= 3) stab(S, t + 0.36, root * 1.5, 0.6, 0.8);
    boom(S, t + 0.12, 0.7 + tier * 0.1);
  } else if (kind === 'collat') {
    S.bell([[880, 1], [1320, 0.5], [2093, 0.3], [2794, 0.15]], 0, 0.9, 0.2);
    stab(S, t + 0.05, 98, 0.45, 0.8);
    boom(S, t, 0.8);
  } else if (kind === 'reward') {
    [523, 659, 784, 1047, 1319].forEach((f, i) => osc(S, 'square', f, f, t + i * 0.06, 0.22, 0.07));
    S.bell([[1568, 1], [3136, 0.3]], 0.32, 1.2, 0.12);
  } else if (kind === 'star') {
    // Police-radio blip.
    osc(S, 'square', 1250, 1250, t, 0.07, 0.06);
    osc(S, 'square', 940, 940, t + 0.09, 0.09, 0.06);
    noise(S, t, 0.2, 0.08, 'bandpass', 2400, 1800, 3);
  } else if (kind === 'horde') {
    // Air-raid siren wailing up and down over a war-drum pulse.
    const o = S.ctx.createOscillator();
    o.type = 'sawtooth';
    const f = S.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 1.2;
    const g = S.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.8);
    g.gain.setValueAtTime(0.22, t + 5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6.5);
    o.frequency.setValueAtTime(180, t);
    for (let i = 0; i < 3; i++) {
      o.frequency.exponentialRampToValueAtTime(720, t + i * 2.1 + 1.2);
      o.frequency.exponentialRampToValueAtTime(260, t + i * 2.1 + 2.1);
    }
    o.connect(f).connect(g).connect(S.master);
    o.start(t);
    o.stop(t + 6.6);
    for (let i = 0; i < 8; i++) boom(S, t + i * 0.75, i % 2 ? 0.5 : 0.85);
    stab(S, t, 55, 1.4, 1.2);
  } else if (kind === 'lost') {
    osc(S, 'sawtooth', 300, 90, t, 0.4, 0.12);
  }
}

// Spoken line through the game's own speech helper (falls back to silence).
const say = (text) => NZ.sound.say(text);

NZ.meta = Object.assign(NZ.meta || {}, { callout, sting, say, boom: (vol) => { const S = ctx(); if (S) boom(S, S.t, vol); } });

// ------------------------------------------------------------------ multi-kills + same-shot kills
const CHAIN_WINDOW = 1.5;
const TIERS = ['', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'MEGA KILL', 'UNSTOPPABLE'];
const COLLAT = (n) => (n === 2 ? '2 FOR 1' : n === 3 ? '3 FOR 1' : 'COLLATERAL');
const mk = { pending: [], chain: 0, last: -99, tier: 0, frame: 0 };
NZ.meta.multi = mk;

NZ.hooks.kill.push((z, headshot, melee) => {
  mk.pending.push(melee ? 130 : headshot ? 100 : 60);
});

// Kills land during a frame (one shot / one explosion = one frame); the group is scored at
// the start of the next frame so every kill from a single shot or blast counts together.
NZ.hooks.frame.push(() => {
  if (!mk.pending.length) return;
  const group = mk.pending;
  mk.pending = [];
  const now = performance.now() / 1000;
  const n = group.length, base = group.reduce((a, b) => a + b, 0);
  mk.chain = now - mk.last <= CHAIN_WINDOW ? mk.chain + n : n;
  mk.last = now;
  if (mk.chain < 2) mk.tier = 0;
  let heat = 0;
  if (n >= 2) {
    const bonus = Math.round(base * 0.5 * Math.min(3, n - 1));
    NZ.addPoints(bonus, true);
    callout(COLLAT(n), { kind: 'collat', sub: `${n > 3 ? n + ' for 1  ' : ''}+${bonus}`, secs: 1.6 });
    sting('collat');
    heat += (n - 1) * 2;
  }
  const tier = Math.min(mk.chain, 6) - 1;
  if (tier >= 1) {
    const bonus = Math.round(base * 0.5 * tier);
    NZ.addPoints(bonus, true);
    const extra = mk.chain > 6 ? ` x${mk.chain}` : '';
    callout(TIERS[tier] + extra, { kind: 'multi', sub: `+${bonus}  ×${(1 + tier * 0.5).toFixed(1)}`, secs: 1.7 });
    if (tier > mk.tier) {
      sting('multi', tier);
      setTimeout(() => say(TIERS[tier].toLowerCase()), 150);
    }
    mk.tier = Math.max(mk.tier, tier);
    heat += tier * 1.5;
  } else if (n >= 2) setTimeout(() => say(n === 2 ? 'two for one' : n === 3 ? 'three for one' : 'collateral'), 120);
  if (heat) NZ.addHeat?.(heat);
});

NZ.hooks.reset.push(() => {
  Object.assign(mk, { pending: [], chain: 0, last: -99, tier: 0 });
  for (const k in slots) slots[k].el.remove(), clearTimeout(slots[k].timer), delete slots[k];
});
