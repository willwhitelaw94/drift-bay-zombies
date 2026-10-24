// NZ.explode(pos, radius, damage, {source, fire, heat, playerDamage}) — the shared explosion contract.
// opts.playerDamage caps the damage dealt to the player (before distance falloff).
// Fireball billows + shock ring, flame/ember/smoke/dust particles, debris, a light pulse, a
// scorch decal, distance-scaled camera shake and boom, radius damage with falloff and wall
// occlusion, gibbing (NZ.dismember, gore module), knock-back, player self-damage and heat.
import { kit } from './explosives-kit.js';

const NZ = window.NZ;
const { THREE, camera, world, player } = NZ;
const V3 = THREE.Vector3;
const rand = kit.rand;
const T = kit.T;

const _c = new V3(), _to = new V3(), _ray = new THREE.Ray(), _pp = new V3();
const PARTS = ['head', 'armL', 'armR', 'legL', 'legR'];
const flung = new Set();

function occluded(from, to, dist) {
  _ray.origin.copy(from);
  _ray.direction.copy(to).sub(from).normalize();
  const hit = world.octree.rayIntersect(_ray);
  return !!hit && hit.distance < dist - 0.35;
}

function explode(pos, radius = 5, damage = 300, opts = {}) {
  const x = pos.x, z = pos.z;
  const ground = NZ.groundAt(x, z, pos.y + 0.6);
  const nearGround = pos.y - ground < 1.6;
  const y = nearGround ? Math.max(pos.y, ground + 0.25) : pos.y;
  _c.set(x, y, z);
  const s = radius / 5;

  // ---- visuals
  kit.lightPulse(x, y + 0.6, z, 220 * s, radius * 6, 0.55);
  kit.shock(x, y + 0.3, z, radius * 2.0);
  for (let i = 0; i < 6; i++) {
    kit.billow(x + rand(-0.6, 0.6) * s, y + rand(0, 0.9) * s, z + rand(-0.6, 0.6) * s,
      radius * 0.35, radius * rand(0.9, 1.4), rand(0.45, 0.75), rand(1.5, 3.5));
  }
  const nF = Math.round(70 * Math.min(2, s));
  for (let i = 0; i < nF; i++) {
    const a = Math.random() * 6.28, e = rand(-0.2, 1.2), sp = rand(4, 13) * s;
    kit.glow.emit(x, y + 0.3, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 1, Math.sin(a) * Math.cos(e) * sp,
      rand(0.35, 0.8), rand(0.8, 1.6) * s, rand(1.8, 3.2) * s, T.FLAME, 3, 4.5);
  }
  for (let i = 0; i < 55; i++) {
    const a = Math.random() * 6.28, sp = rand(5, 18);
    kit.glow.emit(x, y + 0.3, z, Math.cos(a) * sp * rand(0.3, 1), rand(3, 14), Math.sin(a) * sp * rand(0.3, 1),
      rand(0.6, 1.6), rand(0.06, 0.12), 0.03, T.EMBER, -9.8, 0.6);
  }
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * 6.28, sp = rand(1, 4) * s;
    kit.smoke.emit(x + rand(-0.5, 0.5), y + rand(0.2, 1.5) * s, z + rand(-0.5, 0.5), Math.cos(a) * sp, rand(1, 3), Math.sin(a) * sp,
      rand(2.5, 5), rand(1.2, 2) * s, rand(4, 7) * s, T.SMOKE, 0.5, 0.9);
  }
  if (nearGround) {
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * 6.28 + rand(0, 0.2), sp = rand(7, 11) * s;
      kit.smoke.emit(x, ground + 0.25, z, Math.cos(a) * sp, rand(0.2, 1), Math.sin(a) * sp, rand(0.9, 1.6), 0.6 * s, 2.4 * s, T.DUST, 0, 3.2);
    }
    for (let i = 0; i < Math.round(18 * Math.min(1.6, s)); i++) {
      const a = Math.random() * 6.28, sp = rand(3, 10);
      kit.debris(x, ground + 0.3, z, Math.cos(a) * sp, rand(5, 13), Math.sin(a) * sp, rand(0.05, 0.16), ground, Math.random() < 0.4);
    }
    kit.scorch(x, ground, z, radius * 1.2);
  }

  // ---- shake, flash, sound
  const cd = camera.position.distanceTo(_c);
  kit.shake(Math.max(0, 1.25 * Math.min(1.5, s) * (1 - cd / (radius * 7))));
  camera.getWorldDirection(_to);
  const facing = Math.max(0, _to.dot(_pp.copy(_c).sub(camera.position).normalize()));
  kit.flash((0.25 + 0.75 * facing) * Math.max(0, 1 - cd / (radius * 3.5)));
  kit.sfx.boom(_c, Math.min(1.6, 0.7 + 0.3 * s));

  // ---- damage, gibs, knock-back
  let kills = 0;
  const big = damage * 0.45;
  for (const zb of NZ.zombies) {
    if (!zb.pos || zb.state === 'rising') continue;
    _to.copy(zb.pos);
    _to.y += 1.0;
    const d = _to.distanceTo(_c);
    if (d > radius) continue;
    const fall = 1 - d / radius;
    const blocked = occluded(_c, _to, d);
    const dirx = (zb.pos.x - x) / (d || 1), dirz = (zb.pos.z - z) / (d || 1);
    if (zb.state !== 'dead') {
      const dmg = damage * (0.2 + 0.8 * fall) * (blocked ? 0.25 : 1);
      NZ.damageZombie(zb, dmg, false, false, _pp.copy(_to));
      if (opts.fire && !blocked) NZ.ignite?.(zb, 4 + 3 * fall);
      if (zb.state === 'dead') {
        kills++;
        if (!blocked && dmg > big && NZ.dismember) {
          const n = fall > 0.65 ? 3 : fall > 0.35 ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const part = PARTS[(Math.random() * PARTS.length) | 0];
            NZ.dismember(zb, part, new V3(dirx * (6 + 10 * fall) + rand(-2, 2), 4 + 7 * fall, dirz * (6 + 10 * fall) + rand(-2, 2)));
          }
        }
      } else if (!blocked && fall > 0.55 && NZ.dismember && Math.random() < 0.3) {
        NZ.dismember(zb, Math.random() < 0.5 ? 'legL' : 'legR', new V3(dirx * 5, 4, dirz * 5)); // a crawler
      }
    }
    if (blocked) continue;
    const dead = zb.state === 'dead';
    zb._kb = { vx: dirx * (dead ? 4 + 9 * fall : 1.5 + 4 * fall), vz: dirz * (dead ? 4 + 9 * fall : 1.5 + 4 * fall),
      vy: dead ? 3.5 + 6 * fall : 0, lift: 0, spin: dead ? rand(-6, 6) : 0, t: dead ? 1.6 : 0.35 };
    flung.add(zb);
  }

  // ---- player
  _pp.copy(player.collider.start).lerp(player.collider.end, 0.5);
  const pd = _pp.distanceTo(_c);
  if (pd < radius && opts.source !== 'immune') {
    const fall = 1 - pd / radius;
    const blocked = occluded(_c, _pp, pd);
    const maxHurt = opts.playerDamage ?? Math.min(135, damage * 0.32);
    const hurt = Math.round(maxHurt * (0.25 + 0.75 * fall) * (blocked ? 0.3 : 1));
    if (hurt > 0) NZ.damagePlayer(hurt, 'explosion');
    if (!blocked && !player.control) {
      _to.copy(_pp).sub(_c).setY(0).normalize();
      player.vel.addScaledVector(_to, 9 * fall);
      player.vel.y += 4 * fall;
    }
  }

  if (opts.fire) NZ.ignite?.(new V3(x, ground, z), typeof opts.fire === 'number' ? opts.fire : 8);
  NZ.addHeat?.(opts.heat ?? 0.35 * Math.min(2, s) + 0.1 * kills);
  if (kills >= 3) NZ.message(`${kills} IN ONE BLAST`, false, 1.6);
  stats.explosions++;
  stats.lastKills = kills;
  return kills;
}

// Knock-back: living zombies stagger back, corpses are thrown and tumble.
NZ.hooks.update.push((dt) => {
  if (!flung.size) return;
  for (const zb of flung) {
    const k = zb._kb;
    if (!k || zb.remove) {
      flung.delete(zb);
      continue;
    }
    k.t -= dt;
    const dx = k.vx * dt, dz = k.vz * dt, nx = zb.pos.x + dx, nz = zb.pos.z + dz;
    const c = NZ.cellOf(nx, nz);
    if (c < 0 || NZ.walk[c]) {
      zb.pos.x = nx;
      zb.pos.z = nz;
    } else {
      k.vx *= -0.3;
      k.vz *= -0.3;
    }
    const drag = Math.exp(-(zb.state === 'dead' ? 1.2 : 6) * dt);
    k.vx *= drag;
    k.vz *= drag;
    if (zb.state === 'dead') {
      k.vy -= 18 * dt;
      k.lift = Math.max(0, k.lift + k.vy * dt);
      if (k.lift === 0 && k.vy < 0) k.vy = 0;
      zb.root.position.x = zb.pos.x;
      zb.root.position.z = zb.pos.z;
      zb.root.position.y += k.lift;
      if (k.lift > 0) zb.root.rotation.z += k.spin * dt;
    } else if (zb.root) {
      zb.root.position.x = zb.pos.x;
      zb.root.position.z = zb.pos.z;
    }
    if (k.t <= 0 && k.lift <= 0) {
      zb._kb = null;
      flung.delete(zb);
    }
  }
});
NZ.hooks.reset.push(() => flung.clear());

const stats = { explosions: 0, lastKills: 0 };
NZ.explode = explode;
window.__game_explosives = Object.defineProperties(window.__game_explosives || {}, Object.getOwnPropertyDescriptors({
  explodeAt(px, py, r = 6, dmg = 600, fire = false) {
    const g = NZ.groundAt(px, -py);
    return explode(new V3(px, g + 0.3, -py), r, dmg, { source: 'test', fire });
  },
  get explosionStats() { return { ...stats }; },
}));
