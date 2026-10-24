// META: GTA-style wanted level. Heat from kills, gunfire and explosions raises 1–5 stars;
// stars raise the pressure inside a round (spawn rate, max alive, horde size, sprinters, armed
// share) and five stars brings THE HORDE over the hill from one direction.
//
// Contracts: NZ.wanted (0–5), NZ.addHeat(n), NZ.pressure = { spawnMul, sprintBonus, armedBonus,
// maxAliveBonus, hordeBonus } (one object, updated in place).
const NZ = window.NZ;
const { THREE } = NZ;

const THRESHOLDS = [12, 40, 85, 145, 220];
const CAP = 260;
const QUIET = 8, DROP_FLASH = 3; // seconds without heat before a star starts to flash, then drops
const W = { heat: 0, stars: 0, quiet: 0, riseUntil: 0, dropK: 0, hordeCd: 0, queue: 0, queueT: 0, warnUntil: 0, dir: null, sector: [], spawningHorde: false };
const pressure = (NZ.pressure = { spawnMul: 1, sprintBonus: 0, armedBonus: 0, maxAliveBonus: 0, hordeBonus: 0 });

const now = () => NZ.clock.elapsedTime;

function updatePressure() {
  const w = W.stars;
  Object.assign(pressure, {
    spawnMul: 1 - 0.11 * w, // 0.45× the spawn interval at five stars
    sprintBonus: 0.07 * w,
    armedBonus: 0.05 * w,
    maxAliveBonus: 3 * w,
    hordeBonus: 0.1 * w,
  });
}

function starsFor(heat) {
  let s = 0;
  while (s < 5 && heat >= THRESHOLDS[s]) s++;
  return s;
}

function setStars(s) {
  const prev = W.stars;
  W.stars = s;
  updatePressure();
  if (s > prev) {
    W.riseUntil = now() + 2.6;
    NZ.meta?.sting('star');
    // More of them join the current round as the heat rises.
    if (NZ.ROUND.active) NZ.ROUND.toSpawn += 2 * (s - prev);
    if (s === 5 && W.hordeCd <= 0 && NZ.ROUND.active) triggerHorde();
  }
  render();
}

function addHeat(n) {
  if (!(n > 0) || NZ.state !== 'playing') return;
  W.heat = Math.min(CAP, W.heat + n);
  if (n >= 0.3) W.quiet = 0;
  W.dropK = 0;
  const s = starsFor(W.heat);
  if (s > W.stars) setStars(s);
  else render();
}

function setWanted(n) {
  n = Math.max(0, Math.min(5, Math.round(n)));
  W.heat = n ? THRESHOLDS[n - 1] + 1 : 0;
  W.quiet = 0;
  setStars(n);
}

NZ.addHeat = addHeat;
Object.defineProperty(NZ, 'wanted', { get: () => W.stars, set: setWanted, enumerable: true, configurable: true });

// ------------------------------------------------------------------ HUD
const css = document.createElement('style');
css.textContent = `
#nzm-wanted { position: absolute; top: 204px; right: 20px; display: flex; gap: 1px; pointer-events: none; }
#minimap.off ~ #nzm-wanted { top: 18px; }
#nzm-wanted svg { width: 32px; height: 32px; overflow: visible; }
#nzm-wanted path { stroke: #050305; stroke-width: 2.4; stroke-linejoin: round; fill: rgba(150,150,160,.28); transition: fill .15s; }
#nzm-wanted svg.on path { fill: #fdfbf3; filter: drop-shadow(0 0 4px rgba(255,236,190,.65)); }
#nzm-wanted svg:not(.on) { opacity: .7; }
#nzm-wanted.rise svg.on path, #nzm-wanted svg.drop path { animation: nzm-blink .32s steps(2, jump-none) infinite; }
#nzm-wanted.max svg.on path { animation: nzm-max .5s steps(2, jump-none) infinite, nzm-siren 1s linear infinite; }
@keyframes nzm-blink { 0% { fill: #fdfbf3; } 100% { fill: rgba(150,150,160,.2); } }
@keyframes nzm-max { 0% { fill: #fdfbf3; } 100% { fill: #ff5a47; } }
@keyframes nzm-siren { 0%,49% { filter: drop-shadow(0 0 7px #ff2a1a); } 50%,100% { filter: drop-shadow(0 0 7px #2a6bff); } }
#nzm-horde-arrow { position: absolute; width: 0; height: 0; pointer-events: none; display: none; }
#nzm-horde-arrow i { position: absolute; left: -34px; top: -40px; width: 68px; height: 80px; background: #ff2414;
  clip-path: polygon(50% 0, 100% 60%, 70% 60%, 70% 100%, 30% 100%, 30% 60%, 0 60%); filter: drop-shadow(0 0 12px #f00);
  animation: nzm-pulse .4s ease-in-out infinite alternate; }
#nzm-horde-edge { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .4s; }
@keyframes nzm-pulse { from { opacity: .55; transform: scale(.9); } to { opacity: 1; transform: scale(1.08); } }
`;
document.head.appendChild(css);
const STAR = 'M16 1.5 L20.2 11 L30.5 11.9 L22.6 18.7 L25 28.9 L16 23.6 L7 28.9 L9.4 18.7 L1.5 11.9 L11.8 11 Z';
const hud = document.createElement('div');
hud.id = 'nzm-wanted';
hud.innerHTML = Array.from({ length: 5 }, () => `<svg viewBox="0 0 32 32"><path d="${STAR}"/></svg>`).join('');
const arrow = document.createElement('div');
arrow.id = 'nzm-horde-arrow';
arrow.innerHTML = '<i></i>';
const edge = document.createElement('div');
edge.id = 'nzm-horde-edge';
NZ.$('hud').append(edge, arrow, hud);
const starEls = [...hud.children];

let shown = '';
function render() {
  const t = now();
  const key = `${W.stars}|${t < W.riseUntil}|${W.dropK > 0}`;
  if (key === shown) return;
  shown = key;
  starEls.forEach((el, i) => {
    el.classList.toggle('on', i < W.stars);
    el.classList.toggle('drop', W.dropK > 0 && i === W.stars - 1);
  });
  hud.classList.toggle('rise', t < W.riseUntil && W.stars < 5);
  hud.classList.toggle('max', W.stars === 5);
}

// ------------------------------------------------------------------ THE HORDE
let candidates = [];
NZ.hooks.ready.push(() => {
  candidates = NZ.META.tussock
    .map(([x, y, z]) => ({ x, y, z, c: NZ.cellOf(x, -y) }))
    .filter((p) => p.c >= 0 && NZ.walk[p.c] && (p.x < -2 || p.x > 64 || p.y < -6 || p.y > 38));
});

const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
function triggerHorde() {
  const p = NZ.camera.position, px = p.x, py = -p.z;
  const sectors = Array.from({ length: 8 }, () => []);
  for (const c of candidates) {
    const d = Math.hypot(c.x - px, c.y - py);
    if (d < 14 || d > 46 || NZ.flow[c.c] < 0) continue;
    const a = Math.atan2(c.y - py, c.x - px);
    sectors[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8].push(c);
  }
  const usable = sectors.map((s, i) => [s, i]).filter(([s]) => s.length >= 6);
  const [sector, i] = usable.length ? usable[(Math.random() * usable.length) | 0] : [sectors.flat(), -1];
  if (!sector.length) return;
  W.hordeCd = 80;
  W.sector = sector;
  const a = i >= 0 ? (i * Math.PI) / 4 : 0;
  W.dir = { x: Math.cos(a), y: Math.sin(a) }; // plan direction (x east, y north)
  W.queue = Math.min(30, 10 + NZ.ROUND.n * 2);
  W.queueT = 3.2; // the warning plays before they crest the hill
  W.warnUntil = now() + 9;
  NZ.meta?.callout('THE HORDE', { kind: 'horde', sub: i >= 0 ? `pouring over the hill from the ${COMPASS[i]}` : 'is coming', secs: 4.2 });
  NZ.meta?.sting('horde');
  setTimeout(() => NZ.meta?.say('the horde is coming'), 600);
  edge.style.opacity = 1;
}

function spawnHordeOne() {
  const c = W.sector[(Math.random() * W.sector.length) | 0];
  W.spawningHorde = true;
  NZ.spawnZombie({ x: c.x + (Math.random() - 0.5) * 3, y: c.y + (Math.random() - 0.5) * 3, z: c.z, c: c.c });
  W.spawningHorde = false;
}

NZ.hooks.zombieSpawn.push((z) => {
  if (z.update) return; // sheep and other custom brains keep their own pace
  const sprint = W.spawningHorde ? 0.55 : pressure.sprintBonus;
  if (!z.sprinter && Math.random() < sprint) {
    z.sprinter = true;
    z.speed = 3.4 + Math.random() * 1.2;
  }
  if (W.spawningHorde) z.horde = true;
});

// ------------------------------------------------------------------ heat sources
NZ.hooks.kill.push((z, headshot, melee) => {
  let h = 2.5;
  if (headshot) h += 1.5;
  if (melee) h += 1;
  if (z.gibbed || z.dismembered) h += 2;
  if (NZ.vehicle) h += 3;
  addHeat(h);
});

NZ.hooks.shot.push((gun) => {
  const g = String(gun).toLowerCase();
  const loud = /rpg|rocket|launcher|grenade|mortar/.test(g) ? 3 : /sniper|rifle|magnum/.test(g) ? 1.6 : /shotgun/.test(g) ? 0.9 : /pistol|silenc|suppress|bow/.test(g) ? 0.2 : 0.35;
  addHeat(loud);
});

NZ.hooks.round.push(() => {
  NZ.ROUND.toSpawn += Math.round(NZ.ROUND.toSpawn * pressure.hordeBonus);
});

const _fwd = new THREE.Vector3();
NZ.hooks.update.push((dt) => {
  const t = now();
  if (W.hordeCd > 0) W.hordeCd -= dt;
  // Cooling off: after a quiet spell the top star flashes, then drops; one at a time.
  W.quiet += dt;
  if (W.stars > 0 && W.quiet > QUIET) {
    W.dropK = (W.quiet - QUIET) / DROP_FLASH;
    if (W.dropK >= 1) {
      W.heat = THRESHOLDS[W.stars - 1] - 0.5;
      W.quiet = QUIET - 2;
      W.dropK = 0;
      setStars(W.stars - 1);
    }
  } else if (W.stars === 0 && W.quiet > QUIET) W.heat = Math.max(0, W.heat - 2 * dt);
  else W.dropK = 0;
  render();
  // Horde: stagger the spawns so they stream in.
  if (W.queue > 0) {
    W.queueT -= dt;
    const alive = NZ.zombies.reduce((a, z) => a + (z.state !== 'dead' ? 1 : 0), 0);
    if (W.queueT <= 0 && alive < 48) {
      spawnHordeOne();
      W.queue--;
      W.queueT = 0.16 + Math.random() * 0.12;
    }
  }
  // Point at where they're coming from.
  if (t < W.warnUntil && W.dir) {
    NZ.camera.getWorldDirection(_fwd);
    const fx = _fwd.x, fy = -_fwd.z, len = Math.hypot(fx, fy) || 1;
    const fwdX = fx / len, fwdY = fy / len; // plan coords
    const ahead = W.dir.x * fwdX + W.dir.y * fwdY;
    const right = W.dir.x * fwdY - W.dir.y * fwdX;
    const a = Math.atan2(right, ahead);
    arrow.style.display = 'block';
    arrow.style.left = `${50 + Math.sin(a) * 36}%`;
    arrow.style.top = `${50 - Math.cos(a) * 34}%`;
    arrow.style.transform = `rotate(${a}rad)`;
    const k = Math.min(1, (W.warnUntil - t) / 2);
    edge.style.opacity = k;
    edge.style.background = `radial-gradient(ellipse at ${50 + Math.sin(a) * 60}% ${50 - Math.cos(a) * 60}%, rgba(255,20,0,.55), transparent 55%)`;
  } else if (arrow.style.display !== 'none') {
    arrow.style.display = 'none';
    edge.style.opacity = 0;
  }
});

NZ.hooks.reset.push(() => {
  Object.assign(W, { heat: 0, quiet: 0, riseUntil: 0, dropK: 0, hordeCd: 0, queue: 0, warnUntil: 0, dir: null });
  setStars(0);
});

// ------------------------------------------------------------------ test hooks
window.__game_meta = Object.defineProperties(window.__game_meta || {}, Object.getOwnPropertyDescriptors({
  setWanted,
  addHeat,
  horde() { W.hordeCd = 0; triggerHorde(); },
  get wanted() { return { stars: W.stars, heat: +W.heat.toFixed(1), quiet: +W.quiet.toFixed(1), pressure: { ...pressure }, hordeQueue: W.queue } },
}));
