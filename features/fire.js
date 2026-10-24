// NZ.ignite(target: zombie | Vector3, secs) — fire patches on the ground, tussock that catches
// and chains (capped), burning zombies/sheep (flames, damage over time, panic, spreading by
// touch, charring), a flickering light pool, crackle + roar, and the player burning in fire.
import { kit } from './explosives-kit.js';

const NZ = window.NZ;
const { THREE, camera, player, META } = NZ;
const V3 = THREE.Vector3;
const rand = kit.rand;
const T = kit.T;

const PATCH_R = 2.0;
const CLUMP_R = 0.75;
const MAX_CLUMPS = 40;
const MAX_GEN = 5;

// ------------------------------------------------------------------ fires (pooled)
const FIRE_N = 64;
const fires = [];
for (let i = 0; i < FIRE_N; i++) {
  fires.push({ on: false, x: 0, y: 0, z: 0, r: 1, age: 0, life: 1, clump: -1, gen: 0, acc: 0, sacc: 0, tick: 0, spread: 0, light: 0 });
}
let clumpCount = 0;

function startFire(x, y, z, r, life, clump = -1, gen = 0) {
  let f = null;
  for (const c of fires) if (!c.on) { f = c; break; }
  if (!f) return null;
  Object.assign(f, { on: true, x, y, z, r, age: 0, life, clump, gen, acc: 0, sacc: 0, tick: rand(0, 0.3), spread: rand(0.2, 0.6) });
  if (clump >= 0) clumpCount++;
  return f;
}

// ------------------------------------------------------------------ tussock (instanced) lookup + burning
const tus = { list: META.tussock, mesh: null, burnt: new Uint8Array(META.tussock.length), saved: new Map(), hash: new Map(), dirty: false };
const HC = 2;
const hkey = (ix, iy) => (ix + 1000) * 4096 + (iy + 1000);
for (let i = 0; i < tus.list.length; i++) {
  const [x, y] = tus.list[i];
  const k = hkey(Math.floor(x / HC), Math.floor(y / HC));
  if (!tus.hash.has(k)) tus.hash.set(k, []);
  tus.hash.get(k).push(i);
}
// World (three) x,z -> visit tussock indices within r (plan coords: y = -z).
function forTussockNear(x, z, r, fn) {
  const px = x, py = -z;
  const x0 = Math.floor((px - r) / HC), x1 = Math.floor((px + r) / HC);
  const y0 = Math.floor((py - r) / HC), y1 = Math.floor((py + r) / HC);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      const cell = tus.hash.get(hkey(ix, iy));
      if (!cell) continue;
      for (const i of cell) {
        const t = tus.list[i];
        const dx = t[0] - px, dy = t[1] - py;
        if (dx * dx + dy * dy <= r * r) fn(i, Math.sqrt(dx * dx + dy * dy));
      }
    }
  }
}

const _m = new THREE.Matrix4(), _sq = new THREE.Matrix4().makeScale(1, 0.35, 1), _col = new THREE.Color();
function burnTussock(i, gen) {
  if (tus.burnt[i] || clumpCount >= MAX_CLUMPS || gen > MAX_GEN) return false;
  const [x, y, z, s] = tus.list[i];
  const f = startFire(x, z, -y, CLUMP_R * Math.min(1.4, s + 0.2), rand(3, 5), i, gen);
  if (!f) return false;
  tus.burnt[i] = 1;
  if (tus.mesh) {
    const save = { m: new THREE.Matrix4(), c: new THREE.Color() };
    tus.mesh.getMatrixAt(i, save.m);
    if (tus.mesh.instanceColor) tus.mesh.getColorAt(i, save.c);
    tus.saved.set(i, save);
    if (tus.mesh.instanceColor) tus.mesh.setColorAt(i, _col.setRGB(0.32, 0.13, 0.05));
    tus.dirty = true;
  }
  return true;
}
function charTussock(i) {
  if (!tus.mesh) return;
  tus.mesh.getMatrixAt(i, _m);
  tus.mesh.setMatrixAt(i, _m.multiply(_sq));
  if (tus.mesh.instanceColor) tus.mesh.setColorAt(i, _col.setRGB(0.05, 0.045, 0.04));
  tus.dirty = true;
}

NZ.hooks.ready.push(() => {
  NZ.scene.traverse((o) => {
    if (o.isInstancedMesh && o.count === tus.list.length && !tus.mesh) tus.mesh = o;
  });
});

// ------------------------------------------------------------------ burning enemies
const burning = new Set();
const charMat = new THREE.MeshStandardMaterial({ color: 0x120c09, roughness: 1, emissive: 0x2a0800 });
let round = () => NZ.ROUND.n || 1;
const hpFor = (r) => (r < 10 ? 150 + 100 * (r - 1) : Math.round(950 * Math.pow(1.1, r - 9)));

function igniteZombie(z, secs) {
  if (!z || z.state === 'dead' && !z.burnT) return;
  if (z.burnT > 0) {
    z.burnT = Math.max(z.burnT, secs);
    return;
  }
  z.burnT = secs;
  z.burnAge = 0;
  z.burnTick = 0.15;
  z.burnAcc = 0;
  z.panicT = 0;
  burning.add(z);
  kit.sfx.scream(z.pos);
  kit.sfx.fwoomp(z.pos, 0.4);
}

// Panic brain: installed over the default brain (z.update) while a zombie burns.
const _zp = new V3();
function panicBrain(z, dt, t) {
  if (z.state === 'dead' || !(z.burnT > 0)) {
    z.update = z._preBurn;
    z._panicking = false;
    return;
  }
  for (const f of NZ.hooks.zombieUpdate) f(z, dt, t);
  z.t += dt;
  z.panicT -= dt;
  if (z.panicT <= 0) {
    z.panicT = rand(0.25, 0.7);
    z.panicHeading = z.heading + rand(-2.4, 2.4);
  }
  let dh = z.panicHeading - z.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  z.heading += dh * Math.min(1, dt * 7);
  const sp = Math.max(2.4, z.speed * 1.3) * dt;
  const nx = z.pos.x + Math.sin(z.heading) * sp, nz = z.pos.z + Math.cos(z.heading) * sp;
  const c = NZ.cellOf(nx, nz);
  if (c >= 0 && NZ.walk[c]) {
    z.pos.x = nx;
    z.pos.z = nz;
    const h = window.__game?.grid?.heights;
    const gy = h ? h[c] : NZ.terrainHeight(nx, nz);
    z.pos.y += (gy - z.pos.y) * Math.min(1, dt * 10);
  } else z.panicT = 0;
  // Touching the player burns them a little.
  const pp = player.collider.start;
  if (Math.hypot(pp.x - z.pos.x, pp.z - z.pos.z) < 0.85 && Math.abs(pp.y - 0.36 - z.pos.y) < 1.4) burnPlayer(dt, 0.5);
  z.phase += dt * 13;
  const s = Math.sin(z.phase);
  z.legL.rotation.x = s * 0.95;
  z.legR.rotation.x = -s * 0.95;
  z.hips.position.y = 0.92 + Math.abs(Math.cos(z.phase)) * 0.08;
  z.spine.rotation.x = 0.15 + Math.sin(t * 9) * 0.1;
  z.spine.rotation.z = Math.sin(t * 7.3) * 0.25;
  z.neck.rotation.z = Math.sin(t * 15) * 0.5;
  z.armL.rotation.x = -2.6 + Math.sin(t * 17 + 1) * 0.9;
  z.armR.rotation.x = -2.4 + Math.sin(t * 15.5) * 0.9;
  z.armL.rotation.z = -0.4 + Math.sin(t * 11) * 0.5;
  z.armR.rotation.z = 0.4 - Math.sin(t * 12.4) * 0.5;
  z.root.position.copy(z.pos);
  z.root.rotation.y = z.heading;
}

// Custom-brain enemies (sheep): keep their brain, add a frantic jitter.
function jitterBrain(z, dt, t) {
  z._preBurn(z, dt, t);
  if (z.state === 'dead' || !(z.burnT > 0)) {
    z.update = z._preBurn;
    z._panicking = false;
    return;
  }
  const nx = z.pos.x + Math.sin(t * 6 + z.burnAge * 3) * dt * 3, nz = z.pos.z + Math.cos(t * 5.1) * dt * 3;
  const c = NZ.cellOf(nx, nz);
  if (c < 0 || NZ.walk[c]) {
    z.pos.x = nx;
    z.pos.z = nz;
  }
  if (z.root) z.root.rotation.y += Math.sin(t * 9) * dt * 4;
}

function charZombie(z) {
  if (z._charred) return;
  z._charred = true;
  for (const p of z.parts || []) if (p.isMesh) p.material = charMat;
}

function updateBurning(dt, t) {
  for (const z of burning) {
    if (z.remove || !z.pos) {
      burning.delete(z);
      continue;
    }
    const dead = z.state === 'dead';
    z.burnT -= dt * (dead ? 1.6 : 1);
    z.burnAge += dt;
    if (z.burnAge > 1.4) charZombie(z);
    if (z.burnT <= 0) {
      z.burnT = 0;
      burning.delete(z);
      continue;
    }
    if (!dead && !z._panicking && z.state !== 'rising') {
      z._preBurn = z.update;
      z.update = z._preBurn ? jitterBrain : panicBrain;
      z._panicking = true;
    }
    // Flames licking up the body.
    const sc = z.root ? z.root.scale.y : 1, base = z.root ? z.root.position : z.pos;
    const k = dead ? 0.5 : 1;
    z.burnAcc += dt * 46 * k;
    while (z.burnAcc >= 1) {
      z.burnAcc--;
      const h = dead ? rand(0.05, 0.5) : rand(0.2, 1.75) * sc;
      kit.glow.emit(base.x + rand(-0.25, 0.25), base.y + h, base.z + rand(-0.25, 0.25), rand(-0.3, 0.3), rand(1.2, 2.6), rand(-0.3, 0.3),
        rand(0.3, 0.6), rand(0.25, 0.45), rand(0.05, 0.15), T.FLAME, 2, 1.5);
    }
    if (Math.random() < dt * 7) kit.smoke.emit(base.x, base.y + 1.6 * sc, base.z, 0, 1.6, 0, rand(1.4, 2.4), 0.35, 1.6, T.SMOKE, 0.3, 0.8);
    if (Math.random() < dt * 5) kit.glow.emit(base.x, base.y + 1.0, base.z, rand(-1, 1), rand(1, 3), rand(-1, 1), rand(0.6, 1.2), 0.07, 0.02, T.EMBER, 1.5, 0.5);
    if (dead) continue;
    z.burnTick -= dt;
    if (z.burnTick <= 0) {
      z.burnTick = 0.5;
      const dps = Math.max(55, hpFor(round()) * 0.2);
      _zp.copy(z.pos).setY(z.pos.y + 1.2);
      NZ.damageZombie(z, dps * 0.5, false, false, _zp);
      // Spread to anything it stumbles into, and to tussock underfoot.
      for (const o of NZ.zombies) {
        if (o === z || o.state === 'dead' || o.burnT > 0 || !o.pos) continue;
        if (Math.hypot(o.pos.x - z.pos.x, o.pos.z - z.pos.z) < 1.0 && Math.random() < 0.6) igniteZombie(o, 4);
      }
      forTussockNear(z.pos.x, z.pos.z, 0.9, (i) => { if (Math.random() < 0.35) burnTussock(i, 2); });
    }
  }
}

// ------------------------------------------------------------------ player in fire
let playerTick = 0, playerHeat = 0;
const heatEl = document.createElement('div');
heatEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:1;' +
  'background:radial-gradient(ellipse at 50% 60%, transparent 40%, rgba(255,110,20,.45) 78%, rgba(255,60,0,.8) 100%)';
document.body.appendChild(heatEl);
function burnPlayer(dt, k = 1) {
  playerHeat = Math.min(1, playerHeat + dt * 4 * k);
  playerTick -= dt * k;
  if (playerTick <= 0) {
    playerTick = 0.35;
    NZ.damagePlayer(7, 'fire');
  }
}

// ------------------------------------------------------------------ fire update
const lights = [];
for (let i = 0; i < 3; i++) {
  const l = new THREE.PointLight(0xff6a1a, 0, 10, 1.5);
  NZ.scene.add(l);
  lights.push(l);
}
const _best = [null, null, null], _score = [0, 0, 0];

function updateFires(dt, t) {
  const pp = player.collider.start;
  let roar = 0, crackles = 0;
  _best[0] = _best[1] = _best[2] = null;
  _score[0] = _score[1] = _score[2] = 0;
  for (const f of fires) {
    if (!f.on) continue;
    f.age += dt;
    if (f.age >= f.life) {
      f.on = false;
      if (f.clump >= 0) {
        clumpCount--;
        charTussock(f.clump);
        kit.scorch(f.x, f.y, f.z, rand(1.2, 1.8));
      } else kit.scorch(f.x, f.y, f.z, f.r * 2.3);
      continue;
    }
    const patch = f.clump < 0;
    const inten = Math.min(1, f.age / 0.3) * Math.min(1, (f.life - f.age) / (patch ? 2.5 : 1.2));
    // Flames, smoke, embers.
    f.acc += dt * (patch ? 95 : 26) * inten;
    while (f.acc >= 1) {
      f.acc--;
      const a = Math.random() * 6.28, rr = f.r * Math.sqrt(Math.random()) * (patch ? 1 : 0.6);
      const edge = patch ? 1 - (rr / f.r) * 0.5 : 1;
      kit.glow.emit(f.x + Math.cos(a) * rr, f.y + 0.05, f.z + Math.sin(a) * rr, rand(-0.2, 0.2), rand(1.0, patch ? 2.4 : 3.2) * edge, rand(-0.2, 0.2),
        rand(0.45, 0.95) * edge, rand(0.45, 0.9) * (patch ? 1 : 0.85), rand(0.1, 0.3), T.FLAME, 1.5, 1.2);
    }
    f.sacc += dt * (patch ? 9 : 3) * inten;
    while (f.sacc >= 1) {
      f.sacc--;
      kit.smoke.emit(f.x + rand(-f.r, f.r) * 0.5, f.y + 1.2, f.z + rand(-f.r, f.r) * 0.5, rand(-0.3, 0.3), rand(1.2, 2), rand(-0.3, 0.3),
        rand(2.5, 4), 0.6, patch ? 3.2 : 2, T.SMOKE, 0.2, 0.5);
    }
    if (Math.random() < dt * 6 * inten) kit.glow.emit(f.x, f.y + 0.5, f.z, rand(-1, 1), rand(2, 4.5), rand(-1, 1), rand(0.8, 1.6), 0.07, 0.02, T.EMBER, 0.6, 0.6);
    // Sound levels.
    const d = Math.hypot(f.x - camera.position.x, f.y - camera.position.y, f.z - camera.position.z);
    const near = (patch ? 1 : 0.4) * inten / (1 + d * 0.35);
    roar += near;
    crackles += near;
    // Light pool candidates.
    const sc = (patch ? 3 : 1) * inten / (1 + d * 0.1);
    for (let k = 0; k < 3; k++) {
      if (sc > _score[k]) {
        for (let j = 2; j > k; j--) { _score[j] = _score[j - 1]; _best[j] = _best[j - 1]; }
        _score[k] = sc;
        _best[k] = f;
        break;
      }
    }
    f.inten = inten;
    // Damage + spread on a tick.
    f.tick -= dt;
    if (f.tick <= 0) {
      f.tick = 0.3;
      for (const z of NZ.zombies) {
        if (!z.pos || z.state === 'dead' || z.state === 'rising') continue;
        const dx = z.pos.x - f.x, dz = z.pos.z - f.z;
        if (dx * dx + dz * dz < (f.r + 0.25) * (f.r + 0.25) && Math.abs(z.pos.y - f.y) < 1.2) igniteZombie(z, 4);
      }
    }
    const dpx = pp.x - f.x, dpz = pp.z - f.z;
    if (dpx * dpx + dpz * dpz < f.r * f.r && Math.abs(pp.y - 0.36 - f.y) < 0.9 && inten > 0.3) burnPlayer(dt);
    f.spread -= dt;
    if (f.spread <= 0) {
      f.spread = rand(0.35, 0.7);
      const reach = patch ? f.r + 1.2 : 2.2;
      const p = patch ? 0.5 : 0.36 * (1 - f.gen / (MAX_GEN + 1));
      forTussockNear(f.x, f.z, reach, (i) => { if (Math.random() < p) burnTussock(i, f.gen + 1); });
    }
  }
  for (let k = 0; k < 3; k++) {
    const l = lights[k], f = _best[k];
    if (!f) {
      l.intensity = 0;
      continue;
    }
    const patch = f.clump < 0;
    l.position.set(f.x, f.y + (patch ? 1.0 : 0.8), f.z);
    l.distance = patch ? 13 : 8;
    l.intensity = (patch ? 34 : 14) * f.inten * (0.72 + 0.16 * Math.sin(t * 17 + k * 2) + 0.12 * Math.sin(t * 41 + k) * Math.random());
  }
  if (burning.size) roar += burning.size * 0.08;
  kit.setRoar(roar * 0.35);
  if (Math.random() < dt * Math.min(40, crackles * 26)) {
    const f = _best[0];
    if (f) kit.sfx.crackle(_zp.set(f.x + rand(-1, 1), f.y + 0.3, f.z + rand(-1, 1)), rand(0.15, 0.45));
  }
  if (tus.dirty && tus.mesh) {
    tus.mesh.instanceMatrix.needsUpdate = true;
    if (tus.mesh.instanceColor) tus.mesh.instanceColor.needsUpdate = true;
    tus.dirty = false;
  }
  playerHeat = Math.max(0, playerHeat - dt * 1.5);
  heatEl.style.opacity = playerHeat.toFixed(3);
}

NZ.hooks.update.push((dt, t) => {
  updateFires(dt, t);
  updateBurning(dt, t);
});
NZ.hooks.frame.push((dt, t, state) => {
  if (state !== 'playing') kit.setRoar(0);
});

NZ.hooks.reset.push(() => {
  for (const f of fires) f.on = false;
  clumpCount = 0;
  for (const z of burning) z.burnT = 0;
  burning.clear();
  if (tus.mesh) {
    for (const [i, s] of tus.saved) {
      tus.mesh.setMatrixAt(i, s.m);
      if (tus.mesh.instanceColor) tus.mesh.setColorAt(i, s.c);
    }
    tus.dirty = tus.saved.size > 0;
  }
  tus.saved.clear();
  tus.burnt.fill(0);
  for (const l of lights) l.intensity = 0;
  playerHeat = 0;
  heatEl.style.opacity = 0;
});

// ------------------------------------------------------------------ contract
function ignite(target, secs) {
  if (!target) return;
  if (target.isVector3) {
    const y = NZ.groundAt(target.x, target.z, target.y + 1.0);
    const f = startFire(target.x, y, target.z, PATCH_R, secs ?? 10);
    if (!f) return;
    kit.sfx.fwoomp(target, 1);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.28, sp = rand(2, 6);
      kit.glow.emit(target.x, y + 0.2, target.z, Math.cos(a) * sp, rand(1, 4), Math.sin(a) * sp, rand(0.3, 0.6), rand(0.7, 1.2), rand(1.2, 2), T.FLAME, 2, 3.5);
    }
    kit.lightPulse(target.x, y + 0.8, target.z, 90, 14, 0.5);
    forTussockNear(target.x, target.z, PATCH_R, (i) => burnTussock(i, 1));
    return f;
  }
  igniteZombie(target, secs ?? 5);
}
NZ.ignite = ignite;

window.__game_explosives = Object.defineProperties(window.__game_explosives || {}, Object.getOwnPropertyDescriptors({
  igniteAt(px, py, secs = 10) {
    const g = NZ.groundAt(px, -py);
    return !!ignite(new V3(px, g, -py), secs);
  },
  igniteZombies() { for (const z of NZ.zombies) if (z.state !== 'dead') ignite(z, 6); },
  get fireStats() {
    return { fires: fires.filter((f) => f.on).length, clumps: clumpCount, burnt: tus.burnt.reduce((a, b) => a + b, 0),
      burning: burning.size, tussockMesh: !!tus.mesh };
  },
}));
