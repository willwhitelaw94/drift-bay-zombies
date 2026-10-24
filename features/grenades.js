// Frag grenades (G: hold to cook, release to throw) and molotovs (T: hold to light, release to
// throw). Physics with bounces and rolling against the level octree, a live throw-arc preview,
// a hand view model in the weapon scene, HUD pips + a cook timer, NZ.giveGrenade / NZ.giveFire,
// and refills on Max Ammo through NZ.onMaxAmmo (called from game.js's Max Ammo pickup).
import { kit } from './explosives-kit.js';

const NZ = window.NZ;
const { THREE, camera, world, player, wcam, scene } = NZ;
const V3 = THREE.Vector3;
const rand = kit.rand;
const T = kit.T;

const MAX = 4;
const FUSE = 4.0; // seconds from pin pull; it goes off in your hand at 0
const THROW_FUSE = 2.5; // a thrown frag never has more than this left
const RADIUS = 6;
const G = 17; // gravity on thrown things
const R = 0.075;
const inv = { frag: 2, fire: 2 };
const hpFor = (r) => (r < 10 ? 150 + 100 * (r - 1) : Math.round(950 * Math.pow(1.1, r - 9)));
const fragDamage = () => Math.max(320, hpFor(NZ.ROUND.n || 1) * 1.15);

// ------------------------------------------------------------------ models
const M = {
  olive: new THREE.MeshStandardMaterial({ color: 0x4a5232, roughness: 0.55, metalness: 0.2 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.35, metalness: 0.8 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.6 }),
  fuel: new THREE.MeshStandardMaterial({ color: 0xc27a1a, roughness: 0.3, emissive: 0x2a1000 }),
  rag: new THREE.MeshStandardMaterial({ color: 0xcfc2a4, roughness: 1, emissive: 0x401800 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x23201d, roughness: 0.9 }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x3c4232, roughness: 1 }),
};
const GEO = {
  body: new THREE.SphereGeometry(0.06, 14, 10).scale(1, 1.2, 1),
  band: new THREE.CylinderGeometry(0.062, 0.062, 0.012, 14),
  cap: new THREE.CylinderGeometry(0.022, 0.026, 0.035, 10),
  spoon: new THREE.BoxGeometry(0.016, 0.09, 0.008),
  ring: new THREE.TorusGeometry(0.018, 0.0035, 6, 14),
  led: new THREE.SphereGeometry(0.009, 6, 6),
  bottle: new THREE.CylinderGeometry(0.042, 0.046, 0.17, 14),
  shoulder: new THREE.CylinderGeometry(0.016, 0.042, 0.05, 14),
  neck: new THREE.CylinderGeometry(0.015, 0.016, 0.07, 10),
  fuel: new THREE.CylinderGeometry(0.038, 0.042, 0.11, 12),
  rag: new THREE.BoxGeometry(0.03, 0.07, 0.026),
};

function makeFrag(withRing) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(GEO.body, M.olive));
  const band = new THREE.Mesh(GEO.band, M.steel);
  g.add(band);
  const cap = new THREE.Mesh(GEO.cap, M.steel);
  cap.position.y = 0.08;
  g.add(cap);
  const spoon = new THREE.Mesh(GEO.spoon, M.steel);
  spoon.position.set(0.032, 0.05, 0);
  spoon.rotation.z = -0.25;
  g.add(spoon);
  if (withRing) {
    const ring = new THREE.Mesh(GEO.ring, M.steel);
    ring.position.set(-0.03, 0.085, 0);
    ring.rotation.y = Math.PI / 2;
    g.add(ring);
    g.userData.ring = ring;
  }
  const led = new THREE.Mesh(GEO.led, new THREE.MeshBasicMaterial({ color: 0x330000 }));
  led.position.set(0, 0.03, 0.06);
  g.add(led);
  g.userData.led = led;
  for (const m of g.children) m.castShadow = true;
  return g;
}

function makeBottle(inScene) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(GEO.bottle, M.glass);
  const f = new THREE.Mesh(GEO.fuel, M.fuel);
  f.position.y = -0.025;
  const sh = new THREE.Mesh(GEO.shoulder, M.glass);
  sh.position.y = 0.11;
  const n = new THREE.Mesh(GEO.neck, M.glass);
  n.position.y = 0.17;
  const r = new THREE.Mesh(GEO.rag, M.rag);
  r.position.set(0.004, 0.225, 0);
  r.rotation.z = 0.25;
  g.add(f, b, sh, n, r);
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: kit.fireTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: inScene }));
  flame.position.set(0.01, 0.27, 0);
  flame.scale.setScalar(0.14);
  g.add(flame);
  g.userData.flame = flame;
  return g;
}

// ------------------------------------------------------------------ projectiles (pooled)
const shots = [];
for (let i = 0; i < 6; i++) {
  for (const type of ['frag', 'fire']) {
    const g = type === 'frag' ? makeFrag(false) : makeBottle(true);
    g.visible = false;
    scene.add(g);
    shots.push({ on: false, type, g, pos: new V3(), vel: new V3(), spin: new V3(), fuse: 0, age: 0, rolling: false, bounces: 0, ledT: 0 });
  }
}

const _sphere = new THREE.Sphere(new V3(), R), _n = new V3(), _tmp = new V3(), _fwd = new V3(), _right = new V3();

// One physics step: gravity, move, collide (octree sphere), bounce + friction.
// Returns the impact speed into the surface (0 = no contact); the contact normal is left in _n.
function step(pos, vel, h, radius, rest) {
  vel.y -= G * h;
  pos.addScaledVector(vel, h);
  _sphere.center.copy(pos);
  _sphere.radius = radius;
  const hit = world.octree.sphereIntersect(_sphere);
  if (!hit) return 0;
  pos.addScaledVector(hit.normal, hit.depth);
  _n.copy(hit.normal);
  const vn = vel.dot(_n);
  if (vn >= 0) return 1e-4;
  vel.addScaledVector(_n, -(1 + rest) * vn);
  // Tangential friction on contact.
  const vn2 = vel.dot(_n);
  _tmp.copy(vel).addScaledVector(_n, -vn2);
  vel.addScaledVector(_tmp, _n.y > 0.6 ? -0.28 : -0.12);
  return -vn;
}

function zombieAt(pos) {
  for (const z of NZ.zombies) {
    if (!z.pos || z.state === 'dead' || z.state === 'rising') continue;
    const dx = pos.x - z.pos.x, dz = pos.z - z.pos.z;
    if (dx * dx + dz * dz < 0.16 && pos.y > z.pos.y && pos.y < z.pos.y + 1.85) return z;
  }
  return null;
}

function launch(type, fuse) {
  const s = shots.find((x) => !x.on && x.type === type);
  if (!s) return null;
  camera.getWorldDirection(_fwd);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  s.pos.copy(camera.position).addScaledVector(_fwd, 0.35).addScaledVector(_right, 0.12);
  s.pos.y -= 0.08;
  _sphere.center.copy(s.pos);
  _sphere.radius = R;
  if (world.octree.sphereIntersect(_sphere)) s.pos.copy(camera.position);
  throwVelocity(type, s.vel);
  s.spin.set(rand(-8, 8), rand(-4, 4), type === 'fire' ? rand(9, 13) : rand(-8, 8));
  Object.assign(s, { on: true, fuse, age: 0, rolling: false, bounces: 0, ledT: 0 });
  s.g.position.copy(s.pos);
  s.g.visible = true;
  stats.thrown++;
  return s;
}

function throwVelocity(type, out) {
  camera.getWorldDirection(_fwd);
  out.copy(_fwd).multiplyScalar(type === 'frag' ? 15.5 : 13.5);
  out.y += 3.2;
  out.x += player.vel.x * 0.5;
  out.z += player.vel.z * 0.5;
  return out;
}

function detonate(s) {
  s.on = false;
  s.g.visible = false;
  _tmp.copy(s.pos);
  _tmp.y += 0.12;
  NZ.explode(_tmp, RADIUS, fragDamage(), { source: 'frag' });
}

function shatter(s, z) {
  s.on = false;
  s.g.visible = false;
  kit.sfx.shatter(s.pos);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * 6.28, sp = rand(1.5, 5);
    kit.glow.emit(s.pos.x, s.pos.y + 0.1, s.pos.z, Math.cos(a) * sp, rand(1, 4), Math.sin(a) * sp, rand(0.4, 0.9), rand(0.04, 0.07), 0.02, T.GLASS, -9.8, 0.4);
  }
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * 6.28, sp = rand(1, 3.5);
    kit.glow.emit(s.pos.x, s.pos.y + 0.15, s.pos.z, Math.cos(a) * sp, rand(1, 3), Math.sin(a) * sp, rand(0.3, 0.6), rand(0.3, 0.6), rand(0.8, 1.4), T.FLAME, 1, 2);
  }
  if (z) NZ.ignite(z, 7);
  NZ.ignite(s.pos.clone(), 10);
  stats.fires++;
}

function updateShots(dt, t) {
  for (const s of shots) {
    if (!s.on) continue;
    s.age += dt;
    if (s.type === 'frag') {
      s.fuse -= dt;
      if (s.fuse <= 0) {
        detonate(s);
        continue;
      }
    }
    if (s.pos.y < -45 || s.age > 12) {
      s.on = false;
      s.g.visible = false;
      continue;
    }
    if (!s.rolling || s.vel.lengthSq() > 0.0025) {
      const n = Math.min(14, Math.max(1, Math.ceil((s.vel.length() * dt) / 0.06)));
      const h = dt / n;
      for (let k = 0; k < n; k++) {
        const imp = step(s.pos, s.vel, h, R, s.type === 'frag' ? 0.42 : 0.2);
        if (imp > 0) {
          if (s.type === 'fire' && (imp > 2 || s.age > 0.15)) {
            shatter(s, null);
            break;
          }
          if (imp > 1.2) {
            s.bounces++;
            kit.sfx.clink(s.pos, Math.min(0.6, imp * 0.06));
            kit.smoke.emit(s.pos.x, s.pos.y, s.pos.z, 0, 0.3, 0, 0.5, 0.1, 0.4, T.DUST, 0, 2);
            s.spin.multiplyScalar(0.6);
          }
          if (_n.y > 0.6) {
            s.rolling = true;
            if (Math.abs(s.vel.y) < 1.2) s.vel.y = 0;
            const f = Math.exp(-2.6 * h);
            s.vel.x *= f;
            s.vel.z *= f;
          }
        } else if (imp === 0) s.rolling = false;
        const z = zombieAt(s.pos);
        if (z) {
          if (s.type === 'fire') {
            shatter(s, z);
            break;
          }
          if (!s.hitZ || s.hitZ !== z) {
            s.hitZ = z;
            s.vel.x *= -0.25;
            s.vel.z *= -0.25;
            kit.sfx.thunk(s.pos, 0.5);
          }
        }
      }
      if (!s.on) continue;
    }
    // Spin / roll and the in-flight dressing.
    s.g.position.copy(s.pos);
    if (s.rolling) {
      const sp = Math.hypot(s.vel.x, s.vel.z);
      s.g.rotation.x += (s.vel.z / R) * dt * 0.5;
      s.g.rotation.z -= (s.vel.x / R) * dt * 0.5;
      s.spin.multiplyScalar(Math.exp(-6 * dt));
      if (sp < 0.05) s.vel.set(0, 0, 0);
    } else {
      s.g.rotation.x += s.spin.x * dt;
      s.g.rotation.y += s.spin.y * dt;
      s.g.rotation.z += s.spin.z * dt;
    }
    if (s.type === 'frag') {
      if (!s.rolling && Math.random() < 0.7) kit.smoke.emit(s.pos.x, s.pos.y, s.pos.z, 0, 0.2, 0, 0.45, 0.05, 0.22, T.SMOKE, 0, 1);
      const rate = s.fuse < 0.8 ? 14 : s.fuse < 1.6 ? 7 : 3;
      s.ledT += dt * rate;
      s.g.userData.led.material.color.setHex(s.ledT % 1 < 0.5 ? 0xff2010 : 0x330000);
    } else {
      const fl = s.g.userData.flame;
      fl.scale.setScalar(0.16 + Math.random() * 0.08);
      fl.material.rotation = Math.random() * 6.28;
      _tmp.set(0, 0.26, 0).applyQuaternion(s.g.quaternion).add(s.pos);
      if (Math.random() < 0.8) kit.glow.emit(_tmp.x, _tmp.y, _tmp.z, rand(-0.2, 0.2), rand(0.3, 0.8), rand(-0.2, 0.2), rand(0.15, 0.3), 0.18, 0.05, T.FLAME, 1, 1);
      if (Math.random() < 0.25) kit.smoke.emit(_tmp.x, _tmp.y, _tmp.z, 0, 0.4, 0, 0.8, 0.08, 0.4, T.SMOKE, 0.2, 0.5);
    }
  }
}

// ------------------------------------------------------------------ throw arc preview
const ARC_N = 48;
const arcPos = new Float32Array(ARC_N * 3);
const arcGeo = new THREE.BufferGeometry();
arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPos, 3).setUsage(THREE.DynamicDrawUsage));
const arcMat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xffd9a0, transparent: true, opacity: 0.9, depthWrite: false,
  map: NZ.glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.4)', 32), alphaTest: 0.02 });
const arc = new THREE.Points(arcGeo, arcMat);
arc.frustumCulled = false;
arc.visible = false;
arc.renderOrder = 8;
scene.add(arc);
const marker = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 28), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
marker.visible = false;
marker.renderOrder = 8;
scene.add(marker);
const _ap = new V3(), _av = new V3();
let arcFrame = 0;

function updateArc(type) {
  if (++arcFrame % 2) return;
  camera.getWorldDirection(_fwd);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _ap.copy(camera.position).addScaledVector(_fwd, 0.35).addScaledVector(_right, 0.12);
  _ap.y -= 0.08;
  throwVelocity(type, _av);
  let n = 0, landed = false;
  const h = 0.012;
  for (let k = 0; k < 160 && n < ARC_N; k++) {
    const imp = step(_ap, _av, h, 0.12, 0);
    if ((k % 3 === 0 && k > 6) || imp > 0) {
      arcPos[n * 3] = _ap.x;
      arcPos[n * 3 + 1] = _ap.y;
      arcPos[n * 3 + 2] = _ap.z;
      n++;
    }
    if (imp > 0) {
      landed = true;
      marker.position.copy(_ap).addScaledVector(_n, -0.1);
      marker.lookAt(_tmp.copy(marker.position).add(_n));
      break;
    }
  }
  for (let i = n; i < ARC_N; i++) arcPos[i * 3 + 1] = -9999;
  arcGeo.attributes.position.needsUpdate = true;
  arcGeo.setDrawRange(0, n);
  arc.visible = true;
  marker.visible = landed;
  const c = type === 'frag' ? 0xffd9a0 : 0xff8a3a;
  arcMat.color.setHex(c);
  marker.material.color.setHex(type === 'frag' ? 0xff5a3c : 0xff8a3a);
}

// ------------------------------------------------------------------ hand view model (weapon scene)
const hand = new THREE.Group();
const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.34), M.sleeve);
sleeve.position.set(0.02, -0.03, 0.2);
sleeve.rotation.x = 0.25;
const glove = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.1), M.glove);
glove.position.set(0, 0, 0.02);
const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.03, 0.06), M.glove);
thumb.position.set(-0.045, 0.02, -0.02);
thumb.rotation.y = 0.4;
hand.add(sleeve, glove, thumb);
const handFrag = makeFrag(true);
handFrag.position.set(0, 0.045, -0.04);
handFrag.rotation.set(-0.3, 0.4, 0);
const handBottle = makeBottle(false);
handBottle.position.set(0, 0.02, -0.04);
handBottle.rotation.set(-0.5, 0, -0.15);
handBottle.scale.setScalar(0.85);
hand.add(handFrag, handBottle);
hand.visible = false;
hand.scale.setScalar(0.62);
wcam.add(hand);
const handLight = new THREE.PointLight(0xff8030, 0, 1.2, 1.2);
handLight.position.set(0.15, -0.05, -0.45);
NZ.wscene.add(handLight);
// Pose keys: lowered, held, wound-up, follow-through.
const P_LOW = [0.26, -0.5, -0.32, 0.2, 0.2, -0.1];
const P_HOLD = [0.16, -0.14, -0.4, 0.25, 0.35, -0.15];
const P_WIND = [0.2, -0.06, -0.3, -0.5, 0.45, -0.35];
const P_FWD = [0.04, -0.05, -0.66, 0.9, 0.1, 0.1];
const pose = [0, 0, 0, 0, 0, 0];
const lerpPose = (a, b, k) => { for (let i = 0; i < 6; i++) pose[i] = a[i] + (b[i] - a[i]) * k; };

let hold = null; // { type, key, t0, beepNext }
let throwT = -1, throwType = 'frag', raise = 0;
const THROW_TIME = 0.42;

function updateHand(dt, t) {
  const want = hold || throwT >= 0 ? 1 : 0;
  raise += (want - raise) * Math.min(1, dt * 14);
  if (raise < 0.01 && !want) {
    hand.visible = false;
    handLight.intensity = 0;
    return;
  }
  hand.visible = true;
  const type = hold ? hold.type : throwType;
  handFrag.visible = type === 'frag' && (throwT < 0 || throwT < 0.17);
  handBottle.visible = type === 'fire' && (throwT < 0 || throwT < 0.17);
  if (throwT >= 0) {
    const k = throwT / THROW_TIME;
    if (k < 0.3) lerpPose(P_HOLD, P_WIND, k / 0.3);
    else if (k < 0.6) lerpPose(P_WIND, P_FWD, (k - 0.3) / 0.3);
    else lerpPose(P_FWD, P_LOW, (k - 0.6) / 0.4);
  } else {
    lerpPose(P_LOW, P_HOLD, raise);
    if (hold) {
      const held = t - hold.t0;
      if (held < 0.25) pose[2] += Math.sin((held / 0.25) * Math.PI) * 0.05; // tug the pin
      if (hold.type === 'frag') {
        const left = FUSE - held, shake = left < 1.5 ? (1.5 - left) * 0.006 : 0;
        pose[0] += (Math.random() - 0.5) * shake;
        pose[1] += (Math.random() - 0.5) * shake + Math.sin(t * 2) * 0.004;
      }
    }
  }
  hand.position.set(pose[0], pose[1], pose[2]);
  hand.rotation.set(pose[3], pose[4], pose[5]);
  handFrag.userData.ring.visible = !hold || t - hold.t0 < 0.12;
  handFrag.userData.led.material.color.setHex(hold && hold.type === 'frag' && Math.sin(t * 20) > 0 ? 0xff2010 : 0x330000);
  if (handBottle.visible) {
    const fl = handBottle.userData.flame;
    fl.scale.setScalar(0.12 + Math.random() * 0.06);
    fl.material.rotation = Math.random() * 6.28;
    handLight.intensity = 2.2 + Math.random() * 1.2;
  } else handLight.intensity = 0;
  // Lower the gun out of the way.
  const v = NZ.view;
  v.position.y -= 0.24 * raise;
  v.position.x += 0.04 * raise;
  v.rotation.x -= 0.35 * raise;
}

// ------------------------------------------------------------------ input
function press(type, key, t) {
  if (hold || throwT >= 0) return;
  if (inv[type] <= 0) {
    NZ.sound.click(700, 0, 0.3);
    NZ.hint(type === 'frag' ? 'No frag grenades: Max Ammo refills them' : 'No molotovs: Max Ammo refills them', 1.6);
    bump(type, true);
    return;
  }
  inv[type]--;
  hold = { type, key, t0: t, beepNext: t + 0.5 };
  if (type === 'frag') kit.sfx.pin();
  else kit.sfx.lighter();
  NZ.weapon.firing = false;
  NZ.weapon.ads = false;
  renderHud();
}

function release(t) {
  if (!hold) return;
  const { type } = hold;
  const held = t - hold.t0;
  hold = null;
  throwT = 0;
  throwType = type;
  pendingFuse = type === 'frag' ? Math.min(THROW_FUSE, FUSE - held) : 0;
  pendingLaunch = true;
  kit.sfx.whoosh(0.3);
  arc.visible = marker.visible = false;
  cookEl.classList.remove('on');
}
let pendingLaunch = false, pendingFuse = 0;

NZ.hooks.key.push((code, e) => {
  if (e && e.repeat) return;
  const t = NZ.clock.elapsedTime;
  if (code === 'KeyG') press('frag', 'KeyG', t);
  if (code === 'KeyT') press('fire', 'KeyT', t);
});
NZ.hooks.keyup.push((code) => {
  if (hold && code === hold.key) release(NZ.clock.elapsedTime);
});

NZ.hooks.update.push((dt, t) => {
  if (hold) {
    if (!NZ.keys[hold.key]) release(t);
    else {
      NZ.weapon.firing = false;
      NZ.weapon.cd = Math.max(NZ.weapon.cd, 0.15);
      const held = t - hold.t0;
      if (held > 0.1) updateArc(hold.type);
      if (hold.type === 'frag') {
        const left = FUSE - held;
        if (left <= 0) {
          // Cooked it.
          hold = null;
          arc.visible = marker.visible = false;
          cookEl.classList.remove('on');
          camera.getWorldDirection(_fwd);
          _tmp.copy(camera.position).addScaledVector(_fwd, 0.4);
          _tmp.y -= 0.35;
          NZ.message('COOKED IT', false, 1.8);
          stats.cookedOff++;
          NZ.explode(_tmp, RADIUS, fragDamage(), { source: 'frag' });
        } else {
          if (t >= hold.beepNext) {
            hold.beepNext = t + (left < 1.5 ? 0.16 : left < THROW_FUSE ? 0.3 : 0.5);
            kit.sfx.beep(left < THROW_FUSE);
          }
          showCook(left, held);
        }
      } else showCook(-1, held);
    }
  }
  if (throwT >= 0) {
    throwT += dt;
    if (pendingLaunch && throwT >= 0.15) {
      pendingLaunch = false;
      launch(throwType, pendingFuse);
    }
    if (throwT >= THROW_TIME) throwT = -1;
  }
  updateShots(dt, t);
  updateHand(dt, t);
});

NZ.hooks.frame.push((dt, t, state) => {
  if (state !== 'playing' && state !== 'paused') {
    hand.visible = false;
    arc.visible = marker.visible = false;
  }
});

NZ.hooks.reset.push(() => {
  inv.frag = 2;
  inv.fire = 2;
  hold = null;
  throwT = -1;
  pendingLaunch = false;
  raise = 0;
  for (const s of shots) {
    s.on = false;
    s.g.visible = false;
  }
  arc.visible = marker.visible = false;
  cookEl.classList.remove('on');
  renderHud();
});

// ------------------------------------------------------------------ HUD
const css = document.createElement('style');
css.textContent = `
#nz-gren { position: absolute; right: 250px; bottom: 30px; display: grid; gap: 6px; text-shadow: 0 0 6px #000; }
#nz-gren .row { display: flex; align-items: center; gap: 8px; transition: opacity .2s, transform .15s; }
#nz-gren .row.empty { opacity: .38; }
#nz-gren .row.bump { animation: nzgBump .35s ease-out; }
#nz-gren .row.deny { animation: nzgDeny .3s linear; }
#nz-gren .row.live { transform: scale(1.12); }
#nz-gren svg.ico { width: 22px; height: 22px; filter: drop-shadow(0 0 3px #000); }
#nz-gren .pips { display: flex; gap: 4px; }
#nz-gren .pips i { width: 9px; height: 15px; border-radius: 5px 5px 4px 4px; border: 1.5px solid rgba(232,220,203,.55); box-sizing: border-box; }
#nz-gren .frag .pips i.on { background: #9aa45e; border-color: #d6dca0; box-shadow: 0 0 6px rgba(190,210,110,.6); }
#nz-gren .fire .pips i.on { background: #ff8a2a; border-color: #ffd08a; box-shadow: 0 0 8px rgba(255,120,30,.8); }
#nz-gren kbd { font: 600 11px "Oswald", sans-serif; min-width: 16px; text-align: center; padding: 1px 4px; border-radius: 3px;
  border: 1px solid rgba(232,220,203,.5); color: var(--chalk, #e8dccb); background: rgba(0,0,0,.35); }
#nz-gren .lbl { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; opacity: .6; min-width: 58px; }
@keyframes nzgBump { 0% { transform: scale(1.35); filter: brightness(2); } 100% { transform: scale(1); } }
@keyframes nzgDeny { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
#nz-cook { position: absolute; left: 50%; top: 50%; width: 76px; height: 76px; margin: -38px 0 0 -38px; opacity: 0; transition: opacity .12s; }
#nz-cook.on { opacity: 1; }
#nz-cook svg { width: 100%; height: 100%; transform: rotate(-90deg); }
#nz-cook circle { fill: none; stroke-width: 4; }
#nz-cook .bg { stroke: rgba(0,0,0,.45); }
#nz-cook .fg { stroke: #f2c14e; stroke-linecap: round; filter: drop-shadow(0 0 4px rgba(255,160,40,.8)); }
#nz-cook .sec { position: absolute; left: 0; right: 0; top: 84px; text-align: center; font: 600 22px "Oswald", sans-serif;
  color: #f2c14e; text-shadow: 0 0 6px #000; }
#nz-cook .tag { position: absolute; left: -40px; right: -40px; top: 112px; text-align: center; font-size: 11px; letter-spacing: .3em;
  text-transform: uppercase; opacity: .75; text-shadow: 0 0 6px #000; }
#nz-cook.hot .fg { stroke: #ff5a3c; }
#nz-cook.hot .sec { color: #ff5a3c; animation: nzgPulse .3s infinite alternate; }
#nz-cook.fire .fg { stroke: #ff8a2a; }
@keyframes nzgPulse { to { transform: scale(1.18); } }
`;
document.head.appendChild(css);

const FRAG_SVG = '<svg class="ico" viewBox="0 0 24 24"><ellipse cx="11" cy="14" rx="6.5" ry="7.5" fill="#7d8648" stroke="#d6dca0" stroke-width="1"/><rect x="8.5" y="3.5" width="5" height="4" rx="1" fill="#aab"/><path d="M13.5 5 L18 8 L17 16" stroke="#ccd" stroke-width="1.6" fill="none"/><circle cx="7" cy="4.5" r="2.2" stroke="#ccd" stroke-width="1.2" fill="none"/><path d="M5 12h12M5 16h12" stroke="#3d4322" stroke-width="1"/></svg>';
const FIRE_SVG = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 1c2 3-1 3 0 6 2-1 2-3 2-3 1 2 1 4-2 5" fill="#ffb347"/><rect x="10.5" y="7" width="3" height="4" fill="#cfc2a4"/><path d="M10 11h4v2l3 3v6a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-6l3-3z" fill="#3f7a4a" stroke="#9fd0a8" stroke-width="1"/><rect x="8" y="17" width="8" height="5" fill="#c27a1a" opacity=".85"/></svg>';
const gren = document.createElement('div');
gren.id = 'nz-gren';
gren.innerHTML = `
  <div class="row frag">${FRAG_SVG}<span class="pips"></span><span class="lbl">Frag</span><kbd>G</kbd></div>
  <div class="row fire">${FIRE_SVG}<span class="pips"></span><span class="lbl">Molotov</span><kbd>T</kbd></div>`;
const cookEl = document.createElement('div');
cookEl.id = 'nz-cook';
cookEl.innerHTML = '<svg viewBox="0 0 76 76"><circle class="bg" cx="38" cy="38" r="33"/><circle class="fg" cx="38" cy="38" r="33" stroke-dasharray="207.3" stroke-dashoffset="0"/></svg><div class="sec"></div><div class="tag"></div>';
const hudRoot = document.getElementById('hud') || document.body;
hudRoot.append(gren, cookEl);
const rows = { frag: gren.querySelector('.frag'), fire: gren.querySelector('.fire') };
const cookFg = cookEl.querySelector('.fg'), cookSec = cookEl.querySelector('.sec'), cookTag = cookEl.querySelector('.tag');

let shown = { frag: -1, fire: -1 };
function renderHud() {
  for (const type of ['frag', 'fire']) {
    const row = rows[type];
    row.classList.toggle('empty', inv[type] <= 0);
    row.classList.toggle('live', !!hold && hold.type === type);
    if (shown[type] === inv[type]) continue;
    shown[type] = inv[type];
    row.querySelector('.pips').innerHTML = Array.from({ length: MAX }, (_, i) => `<i class="${i < inv[type] ? 'on' : ''}"></i>`).join('');
  }
}
function bump(type, deny) {
  const row = rows[type], cls = deny ? 'deny' : 'bump';
  row.classList.remove(cls);
  void row.offsetWidth;
  row.classList.add(cls);
}
let lastCookText = '';
function showCook(left, held) {
  cookEl.classList.add('on');
  cookEl.classList.toggle('fire', left < 0);
  if (left < 0) {
    cookFg.setAttribute('stroke-dashoffset', '0');
    if (lastCookText !== 'fire') {
      lastCookText = 'fire';
      cookSec.textContent = '';
      cookTag.textContent = 'release to throw';
    }
    cookEl.classList.remove('hot');
    return;
  }
  cookFg.setAttribute('stroke-dashoffset', (207.3 * (1 - left / FUSE)).toFixed(1));
  cookEl.classList.toggle('hot', left < THROW_FUSE);
  const txt = left.toFixed(1);
  if (txt !== lastCookText) {
    lastCookText = txt;
    cookSec.textContent = txt;
    cookTag.textContent = left < 1.2 ? 'throw it!' : left < THROW_FUSE ? 'cooking' : 'pin pulled';
  }
}
renderHud();

// Controls legend on the title/pause panel.
const dl = document.querySelector('.controls');
if (dl) {
  const dt = document.createElement('dt');
  dt.textContent = 'G / T';
  const dd = document.createElement('dd');
  dd.innerHTML = 'frag grenade (hold to cook) &middot; molotov';
  dl.append(dt, dd);
}

// ------------------------------------------------------------------ contracts
function give(type, n) {
  const before = inv[type];
  inv[type] = Math.max(0, Math.min(MAX, inv[type] + n));
  if (inv[type] > before) bump(type, false);
  renderHud();
  return inv[type];
}
NZ.giveGrenade = (n = 1) => give('frag', n);
NZ.giveFire = (n = 1) => give('fire', n);
NZ.grenades = inv;
const prevMaxAmmo = NZ.onMaxAmmo;
NZ.onMaxAmmo = () => {
  prevMaxAmmo?.();
  give('frag', MAX);
  give('fire', MAX);
};

const stats = { thrown: 0, fires: 0, cookedOff: 0 };
window.__game_explosives = Object.defineProperties(window.__game_explosives || {}, Object.getOwnPropertyDescriptors({
  get inventory() { return { ...inv }; },
  get grenadeStats() { return { ...stats, inFlight: shots.filter((s) => s.on).length }; },
  get shots() { return shots.filter((s) => s.on).map((s) => ({ type: s.type, x: +s.pos.x.toFixed(2), y: +s.pos.y.toFixed(2), z: +s.pos.z.toFixed(2), fuse: +s.fuse.toFixed(2), rolling: s.rolling, bounces: s.bounces })); },
  give(f = 4, m = 4) { NZ.giveGrenade(f); NZ.giveFire(m); },
  maxAmmo() { NZ.onMaxAmmo(); },
}));
