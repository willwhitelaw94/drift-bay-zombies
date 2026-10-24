// Armed zombies: from round 1 some zombies carry pistols, from round 2 rocket launchers,
// then an escalating mix of pistols / rifles / rockets (scaled by NZ.wanted when present).
// They advance on the normal brain, stop at mid range with line of sight, paint you with
// a laser, then fire tracers (hitscan with spread) or a slow, dodgeable, shootable rocket.
import { gunshot, lockBeep, whizz, rocketLaunch, rocketHiss, boom, setPan } from './enemies-audio.js';

const NZ = window.NZ;
const { THREE, V3 } = NZ;

const KINDS = {
  pistol: { range: 22, min: 2.2, aim: 0.8, shots: 2, every: 0.42, dmg: 7, spread: 0.03, cool: [2.4, 3.8], laser: 0.009 },
  rifle: { range: 28, min: 2.2, aim: 0.8, shots: 4, every: 0.13, dmg: 5, spread: 0.045, cool: [3.0, 4.4], laser: 0.009 },
  rocket: { range: 32, min: 5, aim: 1.05, shots: 1, every: 0.3, dmg: 0, spread: 0, cool: [5.5, 7.5], laser: 0.02 },
};
const ROCKET_SPEED = 11, ROCKET_PLAYER_DMG = 30;

// ------------------------------------------------------------------ shared meshes
const box = (x, y, z, px = 0, py = 0, pz = 0) => new THREE.BoxGeometry(x, y, z).translate(px, py, pz);
const metal = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.45, metalness: 0.7, emissive: 0x050505 });
const olive = new THREE.MeshStandardMaterial({ color: 0x5d683c, roughness: 0.7, metalness: 0.2, emissive: 0x151a08 });
const warhead = new THREE.MeshStandardMaterial({ color: 0x8a2a18, roughness: 0.5, metalness: 0.3, emissive: 0x200604 });
const wood = new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.8 });
// Guns are modelled barrel along +z, then rotated so +z follows the arm (-y) in the hand.
const GEO = {
  pistol: [[box(0.05, 0.07, 0.2, 0, 0.03, 0.06), metal], [box(0.045, 0.12, 0.06, 0, -0.04, -0.01), metal]],
  rifle: [[box(0.06, 0.08, 0.62, 0, 0.03, 0.18), metal], [box(0.03, 0.03, 0.3, 0, 0.05, 0.6), metal], [box(0.05, 0.16, 0.06, 0, -0.07, 0.12), metal],
    [box(0.055, 0.1, 0.26, 0, -0.01, -0.2), wood]],
  rocket: [[new THREE.CylinderGeometry(0.075, 0.075, 1.0, 10, 1, true).rotateX(Math.PI / 2).translate(0, 0.08, 0.15), olive],
    [new THREE.CylinderGeometry(0.11, 0.075, 0.16, 10, 1, true).rotateX(Math.PI / 2).translate(0, 0.08, -0.38), olive],
    [new THREE.ConeGeometry(0.1, 0.24, 10).rotateX(Math.PI / 2).translate(0, 0.08, 0.76), warhead],
    [box(0.04, 0.12, 0.05, 0, -0.04, 0.0), metal], [box(0.05, 0.06, 0.14, 0.09, 0.14, 0.2), metal]],
};
const MUZZLE = { pistol: new V3(0, 0.03, 0.17), rifle: new V3(0, 0.05, 0.76), rocket: new V3(0, 0.08, 0.9) };

function makeGun(kind) {
  const g = new THREE.Group();
  for (const [geo, mat] of GEO[kind]) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    g.add(m);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(MUZZLE[kind]);
  g.add(muzzle);
  g.rotation.x = Math.PI / 2;
  g.position.set(0, -0.6, 0.02);
  if (kind === 'rocket') g.position.set(0.04, -0.5, 0.0);
  return { g, muzzle };
}

const laserGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
const laserMat = {
  gun: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.04, 0.02), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  rocket: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.06, 0.03), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
};
const dotMat = new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,90,70,1)', 'rgba(255,0,0,0.3)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });

function smokeTexture() {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), r = NZ.rng(7);
  for (let k = 0; k < 14; k++) {
    const x = S / 2 + (r() - 0.5) * S * 0.35, y = S / 2 + (r() - 0.5) * S * 0.35, rad = S * (0.18 + r() * 0.18);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ pools (allocated once)
const scene = NZ.scene;
const smokeTex = smokeTexture();
const SMOKE_N = 220, smoke = [];
let smokeNext = 0;
for (let i = 0; i < SMOKE_N; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x9a948c, transparent: true, depthWrite: false, opacity: 0 }));
  s.visible = false;
  scene.add(s);
  smoke.push({ s, life: 0, max: 1, grow: 1, vy: 0 });
}
function puff(p, size, life, grey = 0x9a948c, rise = 0.4, opacity = 0.6) {
  const o = smoke[smokeNext++ % SMOKE_N];
  o.s.position.copy(p);
  o.s.scale.setScalar(size);
  o.s.material.color.setHex(grey);
  o.s.material.rotation = Math.random() * 6.28;
  o.s.material.opacity = opacity;
  o.s.visible = true;
  o.life = o.max = life;
  o.grow = size * 2.2;
  o.vy = rise;
  o.op = opacity;
}

const flashTex = NZ.flashTexture();
const FLASH_N = 6, flashes = [];
for (let i = 0; i < FLASH_N; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.visible = false;
  scene.add(s);
  flashes.push({ s, life: 0 });
}
let flashNext = 0;
function muzzleFlash(p, size) {
  const f = flashes[flashNext++ % FLASH_N];
  f.s.position.copy(p);
  f.s.scale.setScalar(size);
  f.s.material.rotation = Math.random() * 6.28;
  f.s.visible = true;
  f.life = 0.06;
}

// Lights are created up front: adding lights later recompiles every material.
const gunLight = new THREE.PointLight(0xffb060, 0, 12, 1.5);
const boomLight = new THREE.PointLight(0xff7a30, 0, 30, 1.2);
scene.add(gunLight, boomLight);

const tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
const TRACER_N = 16, tracers = [];
for (let i = 0; i < TRACER_N; i++) {
  const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.6, 1.1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.visible = false;
  scene.add(m);
  tracers.push({ m, from: new V3(), dir: new V3(), dist: 0, at: 0, on: false });
}
let tracerNext = 0;
function tracer(from, dir, dist) {
  const tr = tracers[tracerNext++ % TRACER_N];
  tr.from.copy(from);
  tr.dir.copy(dir);
  tr.dist = dist;
  tr.at = 0;
  tr.on = true;
  tr.m.visible = true;
  tr.m.quaternion.setFromUnitVectors(_z, dir);
}

const fireballMat = new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,240,200,1)', 'rgba(255,110,20,0.6)', 128), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
const FIRE_N = 3, fireballs = [];
for (let i = 0; i < FIRE_N; i++) {
  const s = new THREE.Sprite(fireballMat.clone());
  s.visible = false;
  scene.add(s);
  fireballs.push({ s, t: 9, r: 1 });
}
let fireNext = 0;

const rocketParts = [
  [new THREE.CylinderGeometry(0.055, 0.055, 0.42, 8).rotateX(Math.PI / 2), olive],
  [new THREE.ConeGeometry(0.055, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.29), warhead],
  [box(0.2, 0.012, 0.08, 0, 0, -0.18), olive], [box(0.012, 0.2, 0.08, 0, 0, -0.18), olive],
];
const ROCKET_N = 6, rockets = [];
const flameMat = new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,250,210,1)', 'rgba(255,120,30,0.7)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
for (let i = 0; i < ROCKET_N; i++) {
  const g = new THREE.Group();
  for (const [geo, mat] of rocketParts) g.add(new THREE.Mesh(geo, mat));
  const flame = new THREE.Sprite(flameMat);
  flame.position.z = -0.3;
  flame.scale.setScalar(0.5);
  g.add(flame);
  g.visible = false;
  scene.add(g);
  rockets.push({ g, flame, pos: new V3(), vel: new V3(), on: false, t: 0, puffT: 0, hiss: null });
}

// ------------------------------------------------------------------ explosions
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _z = new V3(0, 0, 1);
const _ray = new THREE.Ray();

function localExplode(pos, radius, damage, opts = {}) {
  // Fallback when the explosives module isn't loaded.
  const f = fireballs[fireNext++ % FIRE_N];
  f.s.position.copy(pos);
  f.t = 0;
  f.r = radius;
  f.s.visible = true;
  boomLight.position.copy(pos).setY(pos.y + 0.8);
  boomLight.intensity = 260;
  for (let i = 0; i < 12; i++) {
    _a.set(pos.x + (Math.random() - 0.5) * radius * 0.6, pos.y + Math.random() * radius * 0.4, pos.z + (Math.random() - 0.5) * radius * 0.6);
    puff(_a, 0.8 + Math.random() * 0.8, 1.8 + Math.random() * 1.4, 0x2a2622, 0.7, 0.75);
  }
  NZ.emit(pos, 40, [1.0, 0.55, 0.15], 9, 7, 0.6);
  NZ.dust(pos, 24);
  boom(pos);
  for (const z of NZ.zombies) {
    if (z.state === 'dead') continue;
    const d = z.pos.distanceTo(pos);
    if (d < radius) NZ.damageZombie(z, damage * (1 - d / radius), false, false, _b.copy(z.pos).setY(z.pos.y + 1));
  }
  const pp = NZ.player.collider;
  const pd = Math.min(pp.start.distanceTo(pos), pp.end.distanceTo(pos));
  if (pd < radius) {
    const k = 1 - pd / radius;
    NZ.damagePlayer(Math.round((opts.playerDamage ?? damage * 0.5) * (0.4 + 0.6 * k)), opts.source || 'explosion');
    _b.copy(pp.start).sub(pos).setY(0).normalize();
    NZ.player.vel.addScaledVector(_b, 6 * k);
    NZ.player.vel.y += 3 * k;
  }
  shake = Math.max(shake, Math.max(0, 1 - pd / (radius * 4)));
}

const explode = (pos, radius, damage, opts) => (NZ.explode ? NZ.explode(pos, radius, damage, opts) : localExplode(pos, radius, damage, opts));

function detonate(r) {
  r.on = false;
  r.g.visible = false;
  r.hiss?.stop();
  r.hiss = null;
  explode(_c.copy(r.pos), 4, 60, { source: 'zombie-rocket', playerDamage: ROCKET_PLAYER_DMG });
}

function launchRocket(from, dir) {
  const r = rockets.find((x) => !x.on);
  if (!r) return;
  r.on = true;
  r.t = 0;
  r.puffT = 0;
  r.pos.copy(from);
  r.vel.copy(dir).multiplyScalar(ROCKET_SPEED);
  r.g.position.copy(from);
  r.g.quaternion.setFromUnitVectors(_z, dir);
  r.g.visible = true;
  r.hiss = rocketHiss(from);
  rocketLaunch(from);
  // Back-blast.
  for (let i = 0; i < 6; i++) {
    _a.copy(from).addScaledVector(dir, -0.9 - Math.random() * 0.6);
    _a.y += (Math.random() - 0.5) * 0.3;
    puff(_a, 0.5 + Math.random() * 0.4, 1.2 + Math.random(), 0xb0aaa0, 0.3, 0.7);
  }
  muzzleFlash(_a.copy(from).addScaledVector(dir, 0.1), 1.4);
  gunLight.position.copy(from);
  gunLight.intensity = 60;
}

function updateRockets(dt) {
  const pp = NZ.player.collider;
  for (const r of rockets) {
    if (!r.on) continue;
    r.t += dt;
    const step = ROCKET_SPEED * dt;
    _ray.origin.copy(r.pos);
    _ray.direction.copy(r.vel).normalize();
    const hit = NZ.world.octree.rayIntersect(_ray);
    if (hit && hit.distance <= step + 0.1) {
      r.pos.copy(hit.position).addScaledVector(_ray.direction, -0.2);
      detonate(r);
      continue;
    }
    r.pos.addScaledVector(r.vel, dt);
    // Proximity to the player (capsule axis).
    _a.subVectors(pp.end, pp.start);
    const k = Math.max(0, Math.min(1, _b.subVectors(r.pos, pp.start).dot(_a) / _a.lengthSq()));
    if (_b.copy(pp.start).addScaledVector(_a, k).distanceTo(r.pos) < 0.6 || r.t > 7 || r.pos.y < NZ.terrainHeight(r.pos.x, r.pos.z) - 0.2) {
      detonate(r);
      continue;
    }
    r.g.position.copy(r.pos);
    r.g.rotateZ(dt * 9);
    r.flame.scale.setScalar(0.35 + Math.random() * 0.35);
    r.puffT -= dt;
    if (r.puffT <= 0) {
      r.puffT = 0.025;
      _a.copy(r.pos).addScaledVector(_ray.direction, -0.35);
      puff(_a, 0.3 + Math.random() * 0.15, 1.8 + Math.random() * 0.8, 0xd0cac0, 0.25, 0.6);
      NZ.emit(_a, 1, [1.0, 0.5, 0.1], 0.6, 0.4, 0.25);
    }
    if (r.hiss) setPan(r.hiss.pan, r.pos);
  }
}

// The player can shoot rockets out of the air.
NZ.hooks.shot.push(() => {
  const cam = NZ.camera;
  cam.getWorldDirection(_d);
  for (const r of rockets) {
    if (!r.on) continue;
    _a.subVectors(r.pos, cam.position);
    const t = _a.dot(_d);
    if (t <= 0 || _a.lengthSq() - t * t > 0.5 * 0.5) continue;
    _ray.origin.copy(cam.position);
    _ray.direction.copy(_d);
    const wall = NZ.world.octree.rayIntersect(_ray);
    if (wall && wall.distance < t) continue;
    NZ.hitmark(true);
    NZ.addPoints(50, true);
    NZ.hint('Rocket shot down', 1.5);
    detonate(r);
  }
});

// ------------------------------------------------------------------ choosing who gets a gun
const wanted = () => (typeof NZ.wanted === 'number' ? NZ.wanted : 0);

function pickKind(n) {
  const w = wanted();
  const r = Math.random();
  if (n <= 1) return r < 0.3 + (NZ.pressure?.armedBonus || 0) ? 'pistol' : null;
  if (n === 2) return r < 0.16 ? 'rocket' : r < 0.4 ? 'pistol' : null;
  const armedP = Math.min(0.8, 0.32 + (n - 3) * 0.04 + w * 0.07 + (NZ.pressure?.armedBonus || 0));
  if (r > armedP) return null;
  const wp = Math.max(0.2, 0.5 - n * 0.02), wr = 0.3 + n * 0.01 + w * 0.03, wk = 0.16 + w * 0.05;
  const x = Math.random() * (wp + wr + wk);
  return x < wp ? 'pistol' : x < wp + wr ? 'rifle' : 'rocket';
}

function rocketCap(n) {
  return n <= 2 ? 1 : 2 + Math.floor(wanted() / 2);
}

function arm(z, kind) {
  if (kind === 'rocket') {
    const live = NZ.zombies.reduce((a, o) => a + (o.arm?.kind === 'rocket' && o.state !== 'dead' ? 1 : 0), 0);
    if (live >= rocketCap(NZ.ROUND.n)) kind = Math.random() < 0.5 ? 'pistol' : 'rifle';
  }
  const { g, muzzle } = makeGun(kind);
  z.parts[6].add(g); // the right-arm mesh: if the arm comes off, the gun goes with it
  const laser = new THREE.Mesh(laserGeo, kind === 'rocket' ? laserMat.rocket : laserMat.gun);
  laser.visible = false;
  laser.frustumCulled = false;
  const dot = new THREE.Sprite(dotMat);
  dot.visible = false;
  dot.scale.setScalar(kind === 'rocket' ? 0.35 : 0.2);
  scene.add(laser, dot);
  z.arm = {
    kind, k: KINDS[kind], gun: g, muzzle, laser, dot, state: 'advance', t: 0, cd: 1 + Math.random() * 2, checkT: 0,
    shots: 0, shotT: 0, losLost: 0, beepT: 0, kick: 0, lock: new V3(), baseSpeed: 0,
  };
}

NZ.hooks.zombieSpawn.push((z) => {
  if (z.kind) return;
  const kind = forcedKind || pickKind(NZ.ROUND.n);
  forcedKind = null;
  if (kind) arm(z, kind);
});
let forcedKind = null;

function disarm(z) {
  const a = z.arm;
  scene.remove(a.laser, a.dot);
  if (z.state !== 'dead' && a.gun.parent === z.parts[6] && z.parts[6].parent === z.armR) {
    // Disarmed but the arm is still on (or hidden): drop the gun where it is.
    a.gun.getWorldPosition(_a);
    a.gun.getWorldQuaternion(dropped.q);
    a.gun.removeFromParent();
    a.gun.position.copy(_a);
    a.gun.quaternion.copy(dropped.q);
    scene.add(a.gun);
    dropped.list.push({ g: a.gun, vy: 1.5, t: 0, spin: (Math.random() - 0.5) * 8 });
    z.speed = a.baseSpeed || z.speed;
  }
  z.arm = null;
}
const dropped = { list: [], q: new THREE.Quaternion() };

// ------------------------------------------------------------------ brain (layered on the default zombie brain)
NZ.hooks.zombieUpdate.push((z) => {
  const a = z.arm;
  if (!a) return;
  if (!a.baseSpeed) a.baseSpeed = z.speed;
  const aR = z.parts[6];
  if (z.lost?.armR || z.disarmed || !z.armR.visible || !aR.visible || aR.parent !== z.armR) {
    disarm(z);
    return;
  }
  const hold = a.state === 'aim' || a.state === 'fire';
  z.speed = hold ? 0 : a.baseSpeed;
  if (hold) z.stuckT = 0;
});

function lineOfSight(from, to) {
  _ray.origin.copy(from);
  _ray.direction.subVectors(to, from);
  const d = _ray.direction.length();
  _ray.direction.divideScalar(d);
  const hit = NZ.world.octree.rayIntersect(_ray);
  return !hit || hit.distance > d - 0.3;
}

const chest = new V3();
let threat = null, threatLevel = 0;

function fireBullet(z, a) {
  const k = a.k, m = a.muzzle.getWorldPosition(_a);
  const pv = NZ.player.vel, moving = Math.hypot(pv.x, pv.z);
  const spread = k.spread + Math.min(0.05, moving * 0.007);
  _d.subVectors(a.lock, m).normalize();
  _d.x += (Math.random() - 0.5) * spread * 2;
  _d.y += (Math.random() - 0.5) * spread * 2;
  _d.z += (Math.random() - 0.5) * spread * 2;
  _d.normalize();
  _ray.origin.copy(m);
  _ray.direction.copy(_d);
  const wall = NZ.world.octree.rayIntersect(_ray);
  const wallDist = wall ? wall.distance : 80;
  // Does the ray pass through the player's capsule?
  const pp = NZ.player.collider, h2 = _d.x * _d.x + _d.z * _d.z;
  const th = h2 > 1e-6 ? ((pp.start.x - m.x) * _d.x + (pp.start.z - m.z) * _d.z) / h2 : 0;
  const hx = m.x + _d.x * th - pp.start.x, hz = m.z + _d.z * th - pp.start.z, hy = m.y + _d.y * th;
  const hd = Math.hypot(hx, hz);
  const hitP = th > 0 && th < wallDist && hd < 0.36 && hy > pp.start.y - 0.4 && hy < pp.end.y + 0.25;
  const len = hitP ? th : wallDist;
  tracer(m, _d, len);
  muzzleFlash(_b.copy(m).addScaledVector(_d, 0.06), a.kind === 'pistol' ? 0.35 : 0.45);
  gunLight.position.copy(m);
  gunLight.intensity = 30;
  gunshot(m, a.kind);
  a.kick = 1;
  if (hitP) NZ.damagePlayer(k.dmg, 'zombie-' + a.kind);
  else {
    if (wall) {
      NZ.sparks(wall.position);
      NZ.dust(wall.position, 2);
    }
    if (th > 0 && th < wallDist && hd < 2.2) whizz(_b.copy(m).addScaledVector(_d, th));
  }
}

function updateArmed(z, dt, t) {
  const a = z.arm;
  if (z.state === 'dead') {
    disarm(z);
    return;
  }
  if (z.state === 'rising') return;
  const cam = NZ.camera, pp = NZ.player.collider.start;
  chest.set(cam.position.x, cam.position.y - 0.38, cam.position.z);
  const dx = pp.x - z.pos.x, dz = pp.z - z.pos.z, dist = Math.hypot(dx, dz);
  a.kick = Math.max(0, a.kick - dt * 8);
  if (a.state === 'advance') {
    a.cd -= dt;
    a.checkT -= dt;
    if (a.checkT <= 0) {
      a.checkT = 0.2 + Math.random() * 0.1;
      if (a.cd <= 0 && dist > a.k.min && dist < a.k.range && Math.abs(pp.y - z.pos.y) < 4 && lineOfSight(_a.set(z.pos.x, z.pos.y + 1.5, z.pos.z), cam.position)) {
        a.state = 'aim';
        a.t = 0;
        a.beepT = 0;
        a.losLost = 0;
        a.lock.copy(chest);
      }
    }
  } else if (a.state === 'aim') {
    a.t += dt;
    // The aim lags the player: rockets lag more so a sidestep beats them.
    a.lock.lerp(chest, Math.min(1, dt * (a.kind === 'rocket' ? 2.5 : 6)));
    a.checkT -= dt;
    if (a.checkT <= 0) {
      a.checkT = 0.2;
      a.losLost = lineOfSight(_a.set(z.pos.x, z.pos.y + 1.5, z.pos.z), cam.position) ? 0 : a.losLost + 0.2;
    }
    if (a.losLost > 0.4 || dist < 1.6) {
      a.state = 'advance';
      a.cd = 0.6;
    } else {
      a.beepT -= dt;
      if (a.beepT <= 0) {
        a.beepT = a.kind === 'rocket' ? Math.max(0.07, 0.3 * (1 - a.t / a.k.aim)) : 0.4;
        lockBeep(z.pos, a.kind === 'rocket');
      }
      if (a.t >= a.k.aim) {
        a.state = 'fire';
        a.shots = 0;
        a.shotT = 0;
      }
    }
  } else if (a.state === 'fire') {
    a.shotT -= dt;
    if (a.shotT <= 0 && a.shots < a.k.shots) {
      a.shotT = a.k.every;
      a.shots++;
      z.root.updateMatrixWorld(true);
      if (a.kind === 'rocket') launchRocket(a.muzzle.getWorldPosition(_c), _d.subVectors(a.lock, _c).normalize());
      else fireBullet(z, a);
      if (a.kind === 'rocket') a.kick = 2;
    } else if (a.shots >= a.k.shots && a.shotT <= 0) {
      a.state = 'advance';
      a.cd = a.k.cool[0] + Math.random() * (a.k.cool[1] - a.k.cool[0]);
    }
  }
  const hold = a.state === 'aim' || a.state === 'fire';
  if (hold) {
    // Plant, square up and raise the gun at the laser point.
    const want = Math.atan2(dx, dz);
    z.heading += Math.atan2(Math.sin(want - z.heading), Math.cos(want - z.heading)) * Math.min(1, dt * 10);
    z.root.rotation.y = z.heading;
    z.spine.rotation.x = 0.06;
    z.spine.rotation.z = 0;
    z.hips.position.y = 0.92;
    z.legL.rotation.x = 0.25;
    z.legR.rotation.x = -0.2;
    const shoulderY = z.pos.y + 1.55 * z.root.scale.y;
    const elev = Math.atan2(a.lock.y - shoulderY, Math.max(0.5, dist));
    z.armR.rotation.x = -(Math.PI / 2 + elev) - z.spine.rotation.x - a.kick * 0.25;
    z.armR.rotation.z = a.kind === 'pistol' ? 0.05 : 0.0;
    if (a.kind !== 'pistol') {
      z.armL.rotation.x = z.armR.rotation.x + 0.15;
      z.armL.rotation.z = 0.5;
    }
    z.neck.rotation.z = 0;
  } else if (!(z.swing > 0)) {
    // Carrying: gun arm lowered and pointed ahead.
    z.armR.rotation.x = a.kind === 'rocket' ? -1.4 : -0.9 + Math.sin(z.phase) * 0.1;
    z.armR.rotation.z = 0.1;
  }
  // Laser.
  const L = a.laser;
  if (a.state === 'aim' || (a.state === 'fire' && a.shots < a.k.shots)) {
    z.root.updateMatrixWorld(true);
    a.muzzle.getWorldPosition(_a);
    _b.subVectors(a.lock, _a);
    // Stop short of the player so the beam doesn't smear across the screen up close.
    const full = _b.length(), len = full > 3 ? full - 1.4 : full;
    L.position.copy(_a);
    L.quaternion.setFromUnitVectors(_z, _b.divideScalar(full));
    const pulse = a.kind === 'rocket' ? 0.7 + 0.3 * Math.sin(t * 40) : 0.85 + 0.15 * Math.sin(t * 25);
    L.scale.set(a.k.laser * pulse, a.k.laser * pulse, len);
    L.visible = true;
    a.dot.position.copy(_a).addScaledVector(_b, 0.05);
    a.dot.visible = true;
    a.dot.material.rotation = t;
    const lvl = a.kind === 'rocket' ? 2 : 1;
    if (lvl > threatLevel) {
      threatLevel = lvl;
      threat = z;
    }
  } else {
    L.visible = false;
    a.dot.visible = false;
  }
}

// ------------------------------------------------------------------ HUD: threat marker
const style = document.createElement('style');
style.textContent = `
#nz-threat { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; opacity: 0; transition: opacity .12s; }
#nz-threat.on { opacity: 1; }
#nz-threat i { position: absolute; left: -16px; top: -150px; width: 0; height: 0; border-left: 16px solid transparent; border-right: 16px solid transparent;
  border-bottom: 26px solid #ffb21c; filter: drop-shadow(0 0 8px #ff7a00); animation: nzthreat .25s steps(2) infinite; }
#nz-threat.rocket i { border-bottom-color: #ff2a12; filter: drop-shadow(0 0 12px #ff0000); animation-duration: .12s; }
#nz-threat b { position: absolute; left: -60px; top: -190px; width: 120px; text-align: center; font: 600 13px "Oswald", sans-serif; letter-spacing: .3em; color: #ff3b22; text-shadow: 0 0 6px #000; }
@keyframes nzthreat { 0% { opacity: 1; } 100% { opacity: .35; } }`;
document.head.appendChild(style);
const threatEl = document.createElement('div');
threatEl.id = 'nz-threat';
threatEl.innerHTML = '<i></i><b></b>';
NZ.$('hud').appendChild(threatEl);
const threatLabel = threatEl.querySelector('b');
let threatShown = 0;

function updateThreat() {
  const lvl = threat ? threatLevel : 0;
  if (lvl !== threatShown) {
    threatShown = lvl;
    threatEl.classList.toggle('on', lvl > 0);
    threatEl.classList.toggle('rocket', lvl === 2);
    threatLabel.textContent = lvl === 2 ? 'ROCKET LOCK' : '';
  }
  if (threat) {
    // Bearing of the shooter relative to where the player looks (0 = straight ahead).
    const yaw = NZ.player.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = threat.pos.x - NZ.camera.position.x, dz = threat.pos.z - NZ.camera.position.z;
    const ang = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz);
    threatEl.style.transform = `rotate(${(-ang).toFixed(3)}rad)`;
  }
  threat = null;
  threatLevel = 0;
}

// ------------------------------------------------------------------ per-frame
let shake = 0;
NZ.hooks.update.push((dt, t) => {
  for (const z of NZ.zombies) if (z.arm) updateArmed(z, dt, t);
  updateRockets(dt);
  updateThreat();
  if (shake > 0.01) {
    NZ.player.pitch += (Math.random() - 0.5) * shake * 0.03;
    NZ.player.yaw += (Math.random() - 0.5) * shake * 0.03;
    shake *= Math.exp(-dt * 6);
  }
});

// Effects keep animating while paused/menu so nothing freezes half-drawn.
NZ.hooks.frame.push((dt, t, state) => {
  if (state !== 'playing') return;
  for (const o of smoke) {
    if (o.life <= 0) continue;
    o.life -= dt;
    const k = 1 - o.life / o.max;
    o.s.position.y += o.vy * dt;
    o.s.scale.setScalar(o.grow * (0.45 + k * 0.55));
    o.s.material.opacity = o.op * (1 - k) * Math.min(1, k * 8 + 0.3);
    if (o.life <= 0) o.s.visible = false;
  }
  for (const f of flashes) {
    if (f.life <= 0) continue;
    f.life -= dt;
    if (f.life <= 0) f.s.visible = false;
  }
  for (const tr of tracers) {
    if (!tr.on) continue;
    tr.at += dt * 150;
    const tail = Math.max(0, tr.at - 3);
    if (tail >= tr.dist) {
      tr.on = tr.m.visible = false;
      continue;
    }
    tr.m.position.copy(tr.from).addScaledVector(tr.dir, tail);
    tr.m.scale.set(0.022, 0.022, Math.min(tr.at, tr.dist) - tail);
  }
  for (const f of fireballs) {
    if (f.t > 0.6) continue;
    f.t += dt;
    const k = f.t / 0.6;
    f.s.scale.setScalar(f.r * 2.4 * (0.3 + Math.sqrt(k)));
    f.s.material.opacity = 1 - k;
    if (f.t > 0.6) f.s.visible = false;
  }
  gunLight.intensity *= Math.exp(-dt * 30);
  boomLight.intensity *= Math.exp(-dt * 7);
  for (let i = dropped.list.length - 1; i >= 0; i--) {
    const d = dropped.list[i];
    d.t += dt;
    const gy = NZ.terrainHeight(d.g.position.x, d.g.position.z);
    if (d.g.position.y > gy + 0.05) {
      d.vy -= 12 * dt;
      d.g.position.y = Math.max(gy + 0.05, d.g.position.y + d.vy * dt);
      d.g.rotation.x += d.spin * dt;
    }
    if (d.t > 6) {
      scene.remove(d.g);
      dropped.list.splice(i, 1);
    }
  }
});

NZ.hooks.reset.push(() => {
  for (const r of rockets) {
    r.on = r.g.visible = false;
    r.hiss?.stop();
    r.hiss = null;
  }
  for (const z of NZ.zombies) if (z.arm) scene.remove(z.arm.laser, z.arm.dot);
  for (const d of dropped.list) scene.remove(d.g);
  dropped.list.length = 0;
});

NZ.zombieRockets = rockets;

window.__game_enemies = Object.defineProperties(window.__game_enemies || {}, Object.getOwnPropertyDescriptors({
  // Spawn one armed zombie (kind: pistol | rifle | rocket), optionally at plan (x, y).
  spawnArmed(kind = 'pistol', x, y) {
    forcedKind = kind;
    if (x === undefined) NZ.spawnZombie();
    else window.__game.spawnAt(x, y);
    const z = NZ.zombies[NZ.zombies.length - 1];
    if (z.arm) z.arm.cd = 0;
    return !!z.arm;
  },
  get armed() {
    return NZ.zombies.filter((z) => z.arm && z.state !== 'dead').map((z) => ({ kind: z.arm.kind, state: z.arm.state, x: +z.pos.x.toFixed(1), y: +(-z.pos.z).toFixed(1) }));
  },
  get rockets() { return rockets.filter((r) => r.on).length; },
  disarm(i = 0) {
    const z = NZ.zombies.filter((o) => o.arm && o.state !== 'dead')[i];
    if (z) z.lost = { ...(z.lost || {}), armR: true };
    return !!z;
  },
  pickKind,
}));
