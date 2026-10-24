// META: kill streaks (kills without taking damage) and their rewards, used with B or 5:
//   5 Max Ammo · 10 UAV (every enemy on the minimap, 30 s) · 15 Air Strike (aimed) · 25 Juggernaut (45 s)
// Uses NZ.explode?.() for the air strike when the explosives module provides it, else a local blast.
const NZ = window.NZ;
const { THREE } = NZ;
const V3 = THREE.Vector3;

const REWARDS = [
  { n: 5, id: 'ammo', name: 'Max Ammo', voice: 'max ammo ready' },
  { n: 10, id: 'uav', name: 'UAV', voice: 'U A V ready' },
  { n: 15, id: 'air', name: 'Air Strike', voice: 'air strike ready' },
  { n: 25, id: 'jugg', name: 'Juggernaut', voice: 'juggernaut ready' },
];
const ICONS = {
  ammo: '<path d="M5 11h22v14H5z M9 7h4v4H9z M19 7h4v4h-4z"/><path d="M10 15h12v2H10z" fill="#123"/>',
  uav: '<circle cx="16" cy="16" r="11" fill="none" stroke-width="2.4"/><circle cx="16" cy="16" r="5" fill="none" stroke-width="2"/><path d="M16 16 L26 9 L27 12 Z"/><circle cx="22" cy="20" r="1.8"/><circle cx="10" cy="11" r="1.6"/>',
  air: '<path d="M16 2 L18.5 12 L30 17 L30 19.5 L18.5 17 L18 25 L22 28 L22 30 L16 28.5 L10 30 L10 28 L14 25 L13.5 17 L2 19.5 L2 17 L13.5 12 Z"/>',
  jugg: '<path d="M6 15 C6 7 11 3 16 3 C21 3 26 7 26 15 L26 22 L20 22 L20 18 L12 18 L12 22 L6 22 Z"/><path d="M9 12 h14 v3 h-14z" fill="#123"/><path d="M8 24 h16 v4 h-16z"/>',
};

const S = { streak: 0, best: 0, ready: [], uavUntil: 0, juggUntil: 0, breathT: 0, pingT: 0, shake: 0 };
const now = () => NZ.clock.elapsedTime;

// ------------------------------------------------------------------ HUD
const css = document.createElement('style');
css.textContent = `
#nzm-streak { position: absolute; right: 30px; bottom: 236px; width: 230px; text-align: right; pointer-events: none; text-shadow: 0 0 6px #000, 0 0 2px #000; }
#nzm-streak .row { display: flex; align-items: baseline; justify-content: flex-end; gap: 8px; }
#nzm-streak .lbl { font-size: 11px; letter-spacing: .28em; text-transform: uppercase; opacity: .75; }
#nzm-streak .num { font: 600 34px/1 "Oswald", sans-serif; color: #fff; min-width: 32px; }
#nzm-streak .num.bump { animation: nzm-bump .3s ease-out; }
#nzm-streak .bar { position: relative; height: 6px; margin-top: 4px; background: rgba(0,0,0,.55); box-shadow: 0 0 0 1px rgba(232,220,203,.25); }
#nzm-streak .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #f29a1e, #ffe48a); box-shadow: 0 0 8px rgba(255,180,60,.8); transition: width .2s; }
#nzm-streak .next { margin-top: 3px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; opacity: .8; }
#nzm-streak .next b { color: #ffe48a; font-weight: 600; }
#nzm-streak.zero { opacity: .55; }
#nzm-ready { position: absolute; right: 30px; bottom: 330px; display: flex; flex-direction: row-reverse; gap: 8px; pointer-events: none; }
#nzm-ready .rw { position: relative; width: 54px; height: 54px; display: grid; place-items: center; background: rgba(10,20,10,.6);
  box-shadow: 0 0 0 2px rgba(185,255,143,.55), 0 0 14px rgba(80,255,120,.35); }
#nzm-ready .rw svg { width: 34px; height: 34px; fill: #b9ff8f; stroke: #b9ff8f; filter: drop-shadow(0 0 4px rgba(80,255,120,.8)); }
#nzm-ready .rw:first-child { box-shadow: 0 0 0 2px #e8ffd8, 0 0 22px rgba(120,255,140,.8); animation: nzm-ready 1s ease-in-out infinite alternate; }
#nzm-ready .rw:not(:first-child) { opacity: .6; transform: scale(.85); }
#nzm-ready .rw span { position: absolute; left: 50%; bottom: -19px; transform: translateX(-50%); white-space: nowrap; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #d8ffc8; }
#nzm-ready .key { position: absolute; top: -9px; left: -9px; min-width: 18px; height: 18px; padding: 0 3px; font: 600 12px/18px "Oswald", sans-serif; text-align: center;
  color: #050305; background: #e8ffd8; border-radius: 3px; box-shadow: 0 0 6px rgba(0,0,0,.8); }
#nzm-active { position: absolute; left: 50%; bottom: 54px; transform: translateX(-50%); display: flex; gap: 18px; pointer-events: none; }
#nzm-active div { font-size: 13px; letter-spacing: .2em; text-transform: uppercase; text-shadow: 0 0 8px #000; }
#nzm-active .uav { color: #ff6a50; }
#nzm-active .jugg { color: #a9c8ff; }
#nzm-uav { position: absolute; top: 16px; right: 16px; width: 180px; height: 180px; border-radius: 50%; pointer-events: none; display: none; }
#minimap.off ~ #nzm-uav { display: none !important; }
#nzm-jugg { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .6s;
  background: radial-gradient(ellipse at center, rgba(60,90,130,.06) 40%, rgba(40,70,110,.45) 75%, rgba(15,25,45,.9) 100%);
  box-shadow: inset 0 0 0 3px rgba(150,180,220,.25); }
#nzm-jugg.on { opacity: 1; }
#nzm-jugg::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 9%; background: linear-gradient(rgba(10,16,28,.9), transparent); }
#nzm-jugg::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 7%; background: linear-gradient(transparent, rgba(10,16,28,.9)); }
@keyframes nzm-bump { from { transform: scale(1.5); color: #ffe48a; } to { transform: scale(1); } }
@keyframes nzm-ready { from { transform: translateY(0); } to { transform: translateY(-3px); } }
`;
document.head.appendChild(css);

const hud = NZ.$('hud');
const streakEl = document.createElement('div');
streakEl.id = 'nzm-streak';
streakEl.innerHTML = '<div class="row"><span class="lbl">Killstreak</span><span class="num">0</span></div><div class="bar"><i></i></div><div class="next"></div>';
const readyEl = document.createElement('div');
readyEl.id = 'nzm-ready';
const activeEl = document.createElement('div');
activeEl.id = 'nzm-active';
const juggEl = document.createElement('div');
juggEl.id = 'nzm-jugg';
const uav = document.createElement('canvas');
uav.id = 'nzm-uav';
uav.width = uav.height = 220;
hud.prepend(juggEl); // under the rest of the HUD
hud.append(uav, streakEl, readyEl, activeEl);
const numEl = streakEl.querySelector('.num'), barEl = streakEl.querySelector('.bar i'), nextEl = streakEl.querySelector('.next');

function renderStreak(bump) {
  numEl.textContent = S.streak;
  if (bump) {
    numEl.classList.remove('bump');
    void numEl.offsetWidth;
    numEl.classList.add('bump');
  }
  streakEl.classList.toggle('zero', S.streak === 0);
  const next = REWARDS.find((r) => r.n > S.streak);
  const prevN = [...REWARDS].reverse().find((r) => r.n <= S.streak)?.n ?? 0;
  if (next) {
    barEl.style.width = `${((S.streak - prevN) / (next.n - prevN)) * 100}%`;
    nextEl.innerHTML = `<b></b> in ${next.n - S.streak}`;
    nextEl.firstChild.textContent = next.name;
  } else {
    barEl.style.width = '100%';
    nextEl.textContent = 'All rewards earned';
  }
}

function renderReady() {
  readyEl.innerHTML = [...S.ready].reverse().map((r, i) =>
    `<div class="rw">${i === 0 ? '<span class="key">B</span>' : ''}<svg viewBox="0 0 32 32">${ICONS[r.id]}</svg><span>${r.name}</span></div>`).join('');
}

// ------------------------------------------------------------------ streak tracking
NZ.hooks.kill.push(() => {
  S.streak++;
  S.best = Math.max(S.best, S.streak);
  const r = REWARDS.find((x) => x.n === S.streak);
  if (r) {
    S.ready.push(r);
    renderReady();
    NZ.meta?.callout(`${r.name} ready`, { kind: 'reward', sub: `${r.n} killstreak · press B or 5`, secs: 2.6 });
    NZ.meta?.sting('reward');
    setTimeout(() => NZ.meta?.say(r.voice), 700);
  }
  renderStreak(true);
});

NZ.hooks.playerDamage.push((n) => {
  // Juggernaut armour: half of every hit is soaked (effectively double health).
  if (now() < S.juggUntil) NZ.player.health += n * 0.5;
  if (S.streak >= 3) {
    NZ.meta?.callout(`Streak lost · ${S.streak}`, { kind: 'lost', secs: 1.2 });
    NZ.meta?.sting('lost');
  }
  if (S.streak) {
    S.streak = 0;
    renderStreak(false);
  }
});

NZ.hooks.key.push((code) => {
  if (code === 'KeyB' || code === 'Digit5' || code === 'Numpad5') useReward();
});

function useReward() {
  const r = S.ready.pop();
  if (!r) {
    NZ.hint('No killstreak reward ready', 1.5);
    return;
  }
  const ok = { ammo: useAmmo, uav: useUav, air: useAirStrike, jugg: useJugg }[r.id]();
  if (ok === false) S.ready.push(r);
  renderReady();
}

function useAmmo() {
  NZ.spawnDrop(NZ.player.collider.start.clone().setY(NZ.player.collider.start.y - 0.8), 'ammo');
}

// ------------------------------------------------------------------ UAV
function useUav() {
  S.uavUntil = now() + 30;
  S.pingT = 0;
  uav.style.display = 'block';
  NZ.meta?.callout('UAV online', { kind: 'reward', sub: 'every enemy on the minimap · 30 s', secs: 2 });
  NZ.meta?.say('U A V online');
}

function ping() {
  const A = NZ.sound;
  if (!A.ctx) return;
  const ctx = A.ctx, t = A.t;
  for (const [d, v] of [[0, 0.09], [0.22, 0.035], [0.44, 0.015]]) {
    const o = ctx.createOscillator();
    o.frequency.value = 1320;
    const g = ctx.createGain();
    A.env(g, t + d, 0.004, v, 0.35);
    o.connect(g).connect(A.master);
    o.start(t + d);
    o.stop(t + d + 0.4);
  }
}

function drawUav(t) {
  const g = uav.getContext('2d'), W = uav.width, R = W / 2, s = 2.4; // same scale as the minimap
  const px = NZ.camera.position.x, py = -NZ.camera.position.z, yaw = NZ.player.yaw;
  g.clearRect(0, 0, W, W);
  g.save();
  g.beginPath();
  g.arc(R, R, R, 0, 7);
  g.clip();
  // Radar sweep.
  const sweep = (t * 2.2) % (Math.PI * 2);
  const grad = g.createConicGradient ? g.createConicGradient(sweep - 0.9, R, R) : null;
  if (grad) {
    grad.addColorStop(0, 'rgba(255,40,30,0)');
    grad.addColorStop(0.14, 'rgba(255,40,30,.22)');
    grad.addColorStop(0.145, 'rgba(255,40,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, W);
  }
  g.strokeStyle = 'rgba(255,60,40,.35)';
  g.lineWidth = 1;
  for (const r of [R * 0.33, R * 0.66]) {
    g.beginPath();
    g.arc(R, R, r, 0, 7);
    g.stroke();
  }
  g.translate(R, R);
  g.rotate(yaw);
  const pulse = 0.5 + 0.5 * Math.sin(t * 8);
  for (const z of NZ.zombies) {
    if (z.state === 'dead') continue;
    let x = (z.pos.x - px) * s, y = (-z.pos.z - py) * -s;
    const d = Math.hypot(x, y), edge = d > R - 7;
    if (edge) x *= (R - 7) / d, y *= (R - 7) / d; // off the map: pinned to the rim
    g.fillStyle = edge ? 'rgba(255,70,50,.85)' : '#ff2a1a';
    g.shadowColor = '#ff1a00';
    g.shadowBlur = 6 + pulse * 6;
    g.beginPath();
    g.arc(x, y, edge ? 2.6 : 3.6 + pulse, 0, 7);
    g.fill();
  }
  g.restore();
  g.strokeStyle = 'rgba(255,60,40,.8)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(R, R, R - 1.5, 0, 7);
  g.stroke();
}

// ------------------------------------------------------------------ air strike
const smokeTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const fx = []; // { obj, life, max, update(f, k, dt) }
function addFx(obj, life, update) {
  NZ.scene.add(obj);
  fx.push({ obj, life, max: life, update });
}

const strikes = [];
const _ray = new THREE.Ray(), _dir = new V3();
function useAirStrike() {
  NZ.camera.getWorldDirection(_dir);
  _ray.origin.copy(NZ.camera.position);
  _ray.direction.copy(_dir);
  const hit = NZ.world.octree.rayIntersect(_ray);
  if (!hit || hit.distance > 220 || hit.distance < 6) {
    NZ.hint(hit && hit.distance < 6 ? 'Too close: aim further out to call the air strike' : 'No target: aim at the ground to call the air strike', 2.5);
    return false;
  }
  const target = hit.position.clone();
  // The jet crosses your view left to right, laying the bombs across the mark.
  const yaw = NZ.player.yaw, along = new V3(Math.cos(yaw), 0, -Math.sin(yaw));
  const st = { target, along, t: 0, smoke: 0, jet: null, bombs: [], light: null };
  for (let i = 0; i < 6; i++) st.bombs.push({ at: target.clone().addScaledVector(along, (i - 2.5) * 4.2), done: false });
  st.light = new THREE.PointLight(0xff2a1a, 30, 18, 1.6);
  st.light.position.copy(target).setY(target.y + 1);
  NZ.scene.add(st.light);
  strikes.push(st);
  NZ.meta?.callout('Air strike inbound', { kind: 'reward', sub: 'red smoke marks the target', secs: 2.4 });
  NZ.meta?.say('air strike inbound');
  NZ.addHeat?.(6);
}

let jetModel = null;
function makeJet() {
  if (!jetModel) {
    const m = new THREE.MeshStandardMaterial({ color: 0x5a636e, metalness: 0.6, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d2228, metalness: 0.4, roughness: 0.6 });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.95, 13, 10), m);
    body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 4, 10), m);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 8.5;
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), dark);
    canopy.scale.set(1, 0.9, 2.4);
    canopy.position.set(0, 0.55, 4.4);
    const wing = new THREE.Mesh(new THREE.BufferGeometry(), m);
    const wv = new Float32Array([0, 0, 3.5, 7.5, 0, -2.5, 0, 0, -3.5, 0, 0, 3.5, 0, 0, -3.5, -7.5, 0, -2.5]);
    wing.geometry.setAttribute('position', new THREE.BufferAttribute(wv, 3));
    wing.geometry.computeVertexNormals();
    wing.material = m.clone();
    wing.material.side = THREE.DoubleSide;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.8, 2.4), m);
    fin.position.set(0, 1.6, -5.2);
    fin.rotation.x = -0.35;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.12, 1.8), m);
    tail.position.set(0, 0.1, -5.6);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,230,180,1)', 'rgba(255,120,30,0.5)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(4.5);
    glow.position.z = -7.2;
    g.add(body, nose, canopy, wing, fin, tail, glow);
    jetModel = g;
  }
  return jetModel.clone();
}

// Synth roar whose pitch and level follow the jet (a cheap Doppler).
function jetSound() {
  const A = NZ.sound;
  if (!A.ctx) return null;
  const ctx = A.ctx;
  const n = A.noiseSrc(true);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;
  lp.Q.value = 2;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 70;
  const og = ctx.createGain();
  og.gain.value = 0.25;
  const g = ctx.createGain();
  g.gain.value = 0.0001;
  n.connect(lp).connect(g);
  o.connect(og).connect(lp);
  g.connect(A.master);
  n.start();
  o.start();
  return { g, lp, o, stop() { const t = A.t; g.gain.setTargetAtTime(0.0001, t, 0.3); n.stop(t + 1.5); o.stop(t + 1.5); } };
}

const JET_SPEED = 150, JET_LEAD = 520;
const _rel = new V3();
function updateStrike(st, dt) {
  st.t += dt;
  // Red smoke billowing off the marker.
  st.smoke -= dt;
  if (st.smoke <= 0 && st.t < 7.5) {
    st.smoke = 0.07;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: new THREE.Color(0.7, 0.03 + Math.random() * 0.04, 0.02), transparent: true, depthWrite: false, opacity: 0.8, fog: false }));
    sp.position.copy(st.target).add(new V3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4));
    const drift = new V3((Math.random() - 0.5) * 0.6 + 0.4, 1.3 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6);
    addFx(sp, 3.2, (f, k, d) => {
      f.obj.position.addScaledVector(drift, d);
      f.obj.scale.setScalar(0.8 + (1 - k) * 4.5);
      f.obj.material.opacity = 0.75 * k;
    });
  }
  if (st.light) st.light.intensity = 22 + Math.sin(st.t * 30) * 8;
  // Jet: appears at 2.5 s, crosses the mark at 2.5 + JET_LEAD / JET_SPEED.
  if (st.t > 2.5 && !st.jet && !st.gone) {
    st.jet = makeJet();
    st.jet.position.copy(st.target).addScaledVector(st.along, -JET_LEAD).setY(st.target.y + 26);
    st.jet.lookAt(st.jet.position.clone().add(st.along));
    NZ.scene.add(st.jet);
    st.snd = jetSound();
  }
  if (st.jet) {
    st.jet.position.addScaledVector(st.along, JET_SPEED * dt);
    const cam = NZ.camera.position;
    _rel.copy(cam).sub(st.jet.position);
    const d = _rel.length();
    const vr = st.along.dot(_rel) / d * JET_SPEED; // + when closing
    const dop = 340 / Math.max(120, 340 - vr);
    if (st.snd) {
      const T = NZ.sound.t;
      st.snd.g.gain.setTargetAtTime(Math.min(1.1, 60 / (d + 20)), T, 0.05);
      st.snd.lp.frequency.setTargetAtTime(500 * dop + 4000 / (1 + d / 25), T, 0.05);
      st.snd.o.frequency.setTargetAtTime(62 * dop, T, 0.05);
    }
    const passed = st.along.dot(_rel.copy(st.jet.position).sub(st.target));
    for (const b of st.bombs) {
      const bp = st.along.dot(_rel.copy(b.at).sub(st.target));
      if (!b.done && passed > bp + 20) { // bombs fall a beat after the jet passes
        b.done = true;
        explode(b.at);
      }
    }
    if (passed > 600) {
      NZ.scene.remove(st.jet);
      st.jet = null;
      st.gone = true;
      st.snd?.stop();
    }
  }
  if (st.gone && st.bombs.every((b) => b.done)) {
    if (st.light) NZ.scene.remove(st.light), (st.light = null);
    return st.t < 11;
  }
  return true;
}

function explode(pos) {
  if (NZ.explode) NZ.explode(pos, 7, 1200, { source: 'airstrike' });
  else localExplode(pos, 7, 1200);
  const d = pos.distanceTo(NZ.camera.position);
  S.shake = Math.max(S.shake, Math.min(1, 14 / (d + 4)));
}

// Minimal blast for when the explosives module isn't loaded.
const flashMat = new THREE.SpriteMaterial({ map: NZ.flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
function localExplode(pos, radius, damage) {
  const fl = new THREE.Sprite(flashMat.clone());
  fl.position.copy(pos).setY(pos.y + 1.5);
  addFx(fl, 0.5, (f, k) => { f.obj.scale.setScalar(4 + (1 - k) * 12); f.obj.material.opacity = k; });
  const light = new THREE.PointLight(0xff8a3a, 90, 40, 1.4);
  light.position.copy(pos).setY(pos.y + 2);
  addFx(light, 0.6, (f, k) => { f.obj.intensity = 90 * k * k; });
  const fire = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0xff7a26, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  fire.position.copy(pos).setY(pos.y + 1);
  addFx(fire, 0.9, (f, k) => { f.obj.scale.setScalar(3 + (1 - k) * 9); f.obj.material.opacity = k; f.obj.position.y += 0.03; });
  const smoke = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x2a2420, transparent: true, depthWrite: false }));
  smoke.position.copy(pos).setY(pos.y + 2);
  addFx(smoke, 3, (f, k, d) => { f.obj.scale.setScalar(5 + (1 - k) * 10); f.obj.material.opacity = 0.7 * k; f.obj.position.y += d * 2; });
  NZ.emit(_rel.copy(pos).setY(pos.y + 0.5), 50, [1, 0.6, 0.2], 14, 12, 0.6);
  NZ.emit(_rel, 30, [0.15, 0.12, 0.1], 10, 10, 1.6);
  NZ.dust(pos, 20);
  NZ.meta?.boom(Math.min(1.3, 30 / (pos.distanceTo(NZ.camera.position) + 10)));
  for (const z of NZ.zombies) {
    if (z.state === 'dead') continue;
    const d = Math.hypot(z.pos.x - pos.x, z.pos.z - pos.z);
    if (d < radius) NZ.damageZombie(z, damage * (1 - 0.6 * (d / radius)), false, false, z.pos.clone().setY(z.pos.y + 1));
  }
  NZ.addHeat?.(4);
}

// ------------------------------------------------------------------ juggernaut
function useJugg() {
  S.juggUntil = now() + 45;
  S.breathT = 0;
  NZ.player.health = 100;
  juggEl.classList.add('on');
  NZ.meta?.callout('Juggernaut', { kind: 'reward', sub: 'double health · 45 s', secs: 2.4 });
  NZ.meta?.boom(0.9);
  NZ.meta?.say('juggernaut');
}

// Slow, heavy breathing behind a visor: band-passed noise in and out.
function breathe() {
  const A = NZ.sound;
  if (!A.ctx) return;
  const ctx = A.ctx, t = A.t;
  for (const [d, dur, f0, f1, v] of [[0, 1.1, 500, 900, 0.16], [1.3, 1.4, 750, 380, 0.22]]) {
    const n = A.noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(f0, t + d);
    bp.frequency.linearRampToValueAtTime(f1, t + d + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(v, t + d + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + dur);
    n.connect(bp).connect(g).connect(A.master);
    n.start(t + d, Math.random());
    n.stop(t + d + dur + 0.05);
  }
}

// ------------------------------------------------------------------ per frame
let activeKey = '';
NZ.hooks.update.push((dt, t) => {
  const T = now();
  if (T < S.uavUntil) {
    drawUav(T);
    S.pingT -= dt;
    if (S.pingT <= 0) (S.pingT = 2.8), ping();
  } else if (uav.style.display !== 'none') uav.style.display = 'none';
  if (T < S.juggUntil) {
    S.breathT -= dt;
    if (S.breathT <= 0) (S.breathT = 3.4), breathe();
  } else if (juggEl.classList.contains('on')) {
    juggEl.classList.remove('on');
    NZ.hint('Juggernaut armour is gone', 2);
  }
  const parts = [];
  if (T < S.uavUntil) parts.push(['uav', `UAV ${Math.ceil(S.uavUntil - T)}`]);
  if (T < S.juggUntil) parts.push(['jugg', `Juggernaut ${Math.ceil(S.juggUntil - T)}`]);
  const key = parts.map((p) => p[1]).join('|');
  if (key !== activeKey) {
    activeKey = key;
    activeEl.innerHTML = parts.map(([c, s]) => `<div class="${c}">${s}</div>`).join('');
  }
  for (let i = strikes.length - 1; i >= 0; i--) if (!updateStrike(strikes[i], dt)) strikes.splice(i, 1);
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.life -= dt;
    if (f.life <= 0) {
      NZ.scene.remove(f.obj);
      f.obj.material?.dispose();
      fx.splice(i, 1);
    } else f.update(f, f.life / f.max, dt);
  }
  // Blast shake (camera rotation is rebuilt from player yaw/pitch every frame).
  if (S.shake > 0.01) {
    NZ.camera.rotation.x += (Math.random() - 0.5) * 0.05 * S.shake;
    NZ.camera.rotation.y += (Math.random() - 0.5) * 0.05 * S.shake;
    S.shake *= Math.exp(-dt * 5);
  }
});

NZ.hooks.reset.push(() => {
  for (const st of strikes) {
    if (st.jet) NZ.scene.remove(st.jet);
    if (st.light) NZ.scene.remove(st.light);
    st.snd?.stop();
  }
  strikes.length = 0;
  for (const f of fx) NZ.scene.remove(f.obj);
  fx.length = 0;
  Object.assign(S, { streak: 0, ready: [], uavUntil: 0, juggUntil: 0, shake: 0 });
  juggEl.classList.remove('on');
  uav.style.display = 'none';
  renderReady();
  renderStreak(false);
});

renderStreak(false);

// ------------------------------------------------------------------ test hooks
const _p = new V3();
window.__game_meta = Object.defineProperties(window.__game_meta || {}, Object.getOwnPropertyDescriptors({
  // Kill n fresh zombies in front of the player, all at once (withinMs = 0: one "shot") or spread over withinMs.
  fakeKills(n, withinMs = 0) {
    const made = [];
    const cam = NZ.camera.position;
    for (let i = 0; i < n; i++) {
      const a = NZ.player.yaw + (i - (n - 1) / 2) * 0.12;
      _p.set(cam.x - Math.sin(a) * 9, 0, cam.z - Math.cos(a) * 9);
      const x = _p.x, y = -_p.z;
      NZ.spawnZombie({ x, y, z: NZ.groundAt(_p.x, _p.z), c: NZ.cellOf(_p.x, _p.z) });
      made.push(NZ.zombies[NZ.zombies.length - 1]);
    }
    const kill = (z, i) => NZ.killZombie(z, i % 2 === 0, false);
    if (!withinMs) made.forEach(kill);
    else made.forEach((z, i) => setTimeout(() => kill(z, i), (i * withinMs) / Math.max(1, n - 1)));
    return n;
  },
  // Spawn n zombies in a row ahead of the player (no kill).
  spawnAhead(n, dist = 18) {
    const cam = NZ.camera.position;
    for (let i = 0; i < n; i++) {
      const a = NZ.player.yaw + (i - (n - 1) / 2) * 0.1;
      _p.set(cam.x - Math.sin(a) * dist, 0, cam.z - Math.cos(a) * dist);
      NZ.spawnZombie({ x: _p.x, y: -_p.z, z: NZ.groundAt(_p.x, _p.z), c: NZ.cellOf(_p.x, _p.z) });
    }
  },
  clear() {
    for (const z of NZ.zombies) NZ.scene.remove(z.root);
    NZ.zombies.length = 0;
    NZ.refreshHitMeshes();
  },
  streak(n) {
    S.ready = REWARDS.filter((r) => r.n <= n);
    S.streak = n;
    renderReady();
    renderStreak(true);
  },
  use: useReward,
  get streaks() { return { streak: S.streak, ready: S.ready.map((r) => r.id), uav: S.uavUntil > now(), jugg: S.juggUntil > now(), strikes: strikes.length, strikeT: strikes[0]?.t ?? -1, health: NZ.player.health }; },
}));
