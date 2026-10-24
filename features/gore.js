// GORE: the machete (V/F), dismemberment (NZ.dismember), physics gibs and collectible parts (NZ.addPart).
// Everything here is pooled; per-frame code only touches preallocated vectors and typed arrays.
const NZ = window.NZ;
const { THREE, V3, hooks, scene, camera, wcam, view, player, weapon, zombies, sound, world } = NZ;

// ------------------------------------------------------------------ shared temps
const _a = new V3(), _b = new V3(), _c = new V3(), _fwd = new V3(), _right = new V3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _ray = new THREE.Ray(new V3(), new V3(0, -1, 0));
const _sphere = new THREE.Sphere(new V3(), 0.11);
const UP = new V3(0, 1, 0);
const now = () => NZ.clock.elapsedTime;
const playing = () => NZ.state === 'playing';
const ease = {
  outCubic: (k) => 1 - (1 - k) ** 3,
  inQuad: (k) => k * k,
  outQuad: (k) => 1 - (1 - k) * (1 - k),
  inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
  outBack: (k) => 1 + 2.4 * (k - 1) ** 3 + 1.4 * (k - 1) ** 2,
};

// ------------------------------------------------------------------ textures (canvas, generated locally)
function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function blob(g, x, y, r, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(70,0,0,${a})`);
  gr.addColorStop(0.65, `rgba(95,4,2,${a * 0.9})`);
  gr.addColorStop(1, 'rgba(60,0,0,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.fill();
}
const splatTex = canvasTex(128, (g, s) => {
  blob(g, s / 2, s / 2, s * 0.3, 0.95);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * 6.28, d = s * (0.18 + Math.random() * 0.28);
    blob(g, s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.02 + Math.random() * 0.07), 0.9);
  }
});
const dropTex = canvasTex(32, (g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
});
const bladeBloodTex = canvasTex(128, (g, s) => {
  for (let i = 0; i < 40; i++) {
    const x = s * (0.25 + Math.random() * 0.75), y = s * (0.1 + Math.random() * 0.75);
    g.fillStyle = `rgba(110,4,4,${0.5 + Math.random() * 0.5})`;
    g.beginPath();
    g.ellipse(x, y, 3 + Math.random() * 12, 2 + Math.random() * 6, Math.random() * 3, 0, 7);
    g.fill();
  }
  g.fillStyle = 'rgba(120,6,4,0.85)';
  g.fillRect(s * 0.55, s * 0.0, s * 0.45, s * 0.2); // the edge takes the most
});

// ------------------------------------------------------------------ blood droplets (directional arcs)
const DROP_N = 700;
const dropPos = new Float32Array(DROP_N * 3), dropCol = new Float32Array(DROP_N * 3);
const dropVel = new Float32Array(DROP_N * 3), dropLife = new Float32Array(DROP_N), dropFloor = new Float32Array(DROP_N);
const dropGeo = new THREE.BufferGeometry();
dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
dropGeo.setAttribute('color', new THREE.BufferAttribute(dropCol, 3));
const drops = new THREE.Points(dropGeo, new THREE.PointsMaterial({ size: 0.06, map: dropTex, vertexColors: true, transparent: true, depthWrite: false, alphaTest: 0.05 }));
drops.frustumCulled = false;
drops.renderOrder = 3;
scene.add(drops);
let dropNext = 0, dropsLive = 0;
for (let i = 0; i < DROP_N; i++) dropPos[i * 3 + 1] = -999;

// Spray n droplets from p along (dx,dy,dz) * speed with a cone of `spread`.
function spray(p, dx, dy, dz, speed, spread, n, floorY, life = 1.1) {
  for (let k = 0; k < n; k++) {
    const i = dropNext++ % DROP_N, o = i * 3, s = speed * (0.45 + Math.random() * 0.8);
    dropPos[o] = p.x; dropPos[o + 1] = p.y; dropPos[o + 2] = p.z;
    dropVel[o] = (dx + (Math.random() - 0.5) * spread) * s;
    dropVel[o + 1] = (dy + (Math.random() - 0.5) * spread) * s;
    dropVel[o + 2] = (dz + (Math.random() - 0.5) * spread) * s;
    const v = 0.55 + Math.random() * 0.6;
    dropCol[o] = 0.55 * v; dropCol[o + 1] = 0.015 * v; dropCol[o + 2] = 0.02 * v;
    dropLife[i] = life * (0.6 + Math.random() * 0.6);
    dropFloor[i] = floorY;
  }
  dropsLive = 1.6;
}

function updateDrops(dt) {
  if (dropsLive <= 0) return;
  dropsLive -= dt;
  for (let i = 0; i < DROP_N; i++) {
    if (dropLife[i] <= 0) continue;
    const o = i * 3;
    dropLife[i] -= dt;
    dropVel[o + 1] -= 13 * dt;
    dropPos[o] += dropVel[o] * dt;
    dropPos[o + 1] += dropVel[o + 1] * dt;
    dropPos[o + 2] += dropVel[o + 2] * dt;
    if (dropPos[o + 1] < dropFloor[i] || dropLife[i] <= 0) {
      dropLife[i] = 0;
      dropPos[o + 1] = -999;
    }
  }
  dropGeo.attributes.position.needsUpdate = true;
  dropGeo.attributes.color.needsUpdate = true;
}

// ------------------------------------------------------------------ ground splats (ring buffer of decals)
const DECAL_N = 64;
const decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const decalMat = new THREE.MeshBasicMaterial({ map: splatTex, transparent: true, depthWrite: false, opacity: 0.92, color: 0xb02020 });
const decals = [];
for (let i = 0; i < DECAL_N; i++) {
  const m = new THREE.Mesh(decalGeo, decalMat);
  m.visible = false;
  m.renderOrder = 1;
  scene.add(m);
  decals.push(m);
}
let decalNext = 0;
function splat(x, y, z, size) {
  const m = decals[decalNext++ % DECAL_N];
  m.position.set(x, y + 0.012 + (decalNext % 7) * 0.0015, z);
  m.rotation.y = Math.random() * 6.28;
  m.scale.setScalar(size * (0.8 + Math.random() * 0.5));
  m.visible = true;
}

// Floor under a point: octree ray straight down, falling back to the terrain.
function floorAt(x, y, z) {
  _ray.origin.set(x, y + 0.35, z);
  _ray.direction.set(0, -1, 0);
  const hit = world.octree.rayIntersect(_ray);
  if (hit && hit.distance < 30) return hit.position.y;
  return NZ.terrainAt ? NZ.terrainAt(x, z) : NZ.terrainHeight(x, z);
}

// ------------------------------------------------------------------ sounds (synthesised on the game's context)
function sfxOK() { return sound.ctx && sound.ctx.state === 'running'; }
function noiseThrough(t, type, f0, f1, dur, q, peak, attack = 0.005, pan = 0) {
  const ctx = sound.ctx, n = sound.noiseSrc(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  sound.env(g, t, attack, peak, dur);
  let tail = g;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(pan, t);
    p.pan.linearRampToValueAtTime(-pan, t + dur);
    g.connect(p);
    tail = p;
  }
  n.connect(f).connect(g);
  tail.connect(sound.master);
  n.start(t, Math.random() * 1.5);
  n.stop(t + attack + dur + 0.05);
}
function tone(t, type, f0, f1, dur, peak, attack = 0.004) {
  const ctx = sound.ctx, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  sound.env(g, t, attack, peak, dur);
  o.connect(g).connect(sound.master);
  o.start(t);
  o.stop(t + attack + dur + 0.05);
}
const sfx = {
  whoosh(side, when = 0) {
    if (!sfxOK()) return;
    const t = sound.t + when;
    noiseThrough(t, 'bandpass', 500, 2800, 0.2, 1.4, 0.55, 0.05, side * 0.7);
    noiseThrough(t + 0.04, 'bandpass', 2600, 700, 0.16, 2.2, 0.25, 0.02, side * 0.5);
    tone(t + 0.02, 'sine', 160, 70, 0.18, 0.18, 0.04);
  },
  chop(kill) {
    if (!sfxOK()) return;
    const t = sound.t;
    tone(t, 'triangle', 150, 42, 0.16, 0.75);
    noiseThrough(t, 'lowpass', 2400, 260, 0.14, 0.8, 0.9, 0.002);
    noiseThrough(t + 0.015, 'bandpass', 1100, 180, 0.22, 7, 0.9, 0.01); // wet squelch
    if (kill) noiseThrough(t + 0.05, 'bandpass', 600, 120, 0.3, 5, 0.6, 0.02);
  },
  crack() {
    if (!sfxOK()) return;
    const t = sound.t;
    for (let i = 0; i < 3; i++) noiseThrough(t + i * 0.018 + Math.random() * 0.01, 'highpass', 2600, 1800, 0.025, 0.7, 0.6, 0.001);
    noiseThrough(t, 'bandpass', 700, 200, 0.25, 4, 0.55, 0.01); // tearing
  },
  splatAt(p, vol = 0.35) {
    if (!sfxOK()) return;
    const d = p.distanceTo(camera.position);
    if (d > 25) return;
    const t = sound.t, v = vol / (1 + d * 0.35);
    noiseThrough(t, 'lowpass', 900, 150, 0.1, 1, v, 0.002);
    tone(t, 'sine', 90, 50, 0.08, v * 0.8);
  },
  pickup(kind) {
    if (!sfxOK()) return;
    const t = sound.t, base = kind === 'head' ? 330 : kind === 'wool' ? 520 : 400;
    noiseThrough(t, 'bandpass', 900, 300, 0.09, 6, 0.5, 0.003);
    tone(t + 0.02, 'sine', base, base * 2.2, 0.12, 0.28);
    tone(t + 0.09, 'triangle', base * 1.5, base * 3, 0.14, 0.16);
  },
  reward() {
    if (!sfxOK()) return;
    sound.bell([[196, 1], [294, 0.6], [392, 0.5], [588, 0.25]], 0, 1.8, 0.3);
    sound.bell([[262, 1], [392, 0.6], [523, 0.4]], 0.18, 1.6, 0.26);
    sound.thud(0.8);
  },
};

// ------------------------------------------------------------------ machete view model
const machete = { hand: new THREE.Group(), blood: null, bloodK: 0, trail: null };
function buildMachete() {
  const { hand } = machete;
  const steel = new THREE.MeshStandardMaterial({ color: 0xa4a9af, metalness: 0.6, roughness: 0.32, emissive: 0x0b0c0d });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x4a4d52, metalness: 0.6, roughness: 0.5 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a40, metalness: 0.7, roughness: 0.4 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x2b2722, roughness: 0.9 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x4a523d, roughness: 1 });
  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };
  // Hand frame: origin at the grip, blade along -z, edge toward -y. Forearm trails behind (+z).
  add(hand, new THREE.BoxGeometry(0.075, 0.08, 0.22), sleeve, 0.006, -0.012, 0.21);
  add(hand, new THREE.BoxGeometry(0.085, 0.09, 0.05), sleeve, 0.006, -0.012, 0.1);
  add(hand, new THREE.BoxGeometry(0.058, 0.07, 0.09), glove, 0.014, -0.004, 0.0);
  add(hand, new THREE.BoxGeometry(0.03, 0.05, 0.08), glove, -0.024, -0.012, -0.002, 0, 0, 0.25);
  add(hand, new THREE.BoxGeometry(0.026, 0.03, 0.045), glove, -0.01, 0.034, 0.02, 0.3, 0, 0);
  const handle = new THREE.Group();
  hand.add(handle);
  add(handle, new THREE.CylinderGeometry(0.015, 0.017, 0.15, 10), grip, 0, 0, 0, Math.PI / 2);
  for (const z of [-0.045, 0.045]) add(handle, new THREE.CylinderGeometry(0.0175, 0.0175, 0.006, 10), grip, 0, 0, z, Math.PI / 2);
  add(handle, new THREE.SphereGeometry(0.02, 10, 8), darkSteel, 0, 0, 0.083);
  add(handle, new THREE.BoxGeometry(0.016, 0.07, 0.012), brass, 0, -0.005, -0.08);
  // Blade: classic Collins profile, widening to a clipped belly near the tip.
  const s = new THREE.Shape();
  s.moveTo(0, 0.019);
  s.lineTo(0.37, 0.023);
  s.quadraticCurveTo(0.455, 0.022, 0.475, 0.0);
  s.quadraticCurveTo(0.465, -0.05, 0.33, -0.047);
  s.quadraticCurveTo(0.14, -0.03, 0, -0.021);
  s.closePath();
  const bg = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0016, bevelSize: 0.0025, bevelSegments: 1, curveSegments: 10 });
  bg.rotateY(Math.PI / 2).translate(-0.002, 0, -0.085);
  bg.computeVertexNormals();
  add(handle, bg, steel, 0, 0, 0);
  add(handle, new THREE.BoxGeometry(0.0062, 0.004, 0.36), darkSteel, 0, 0.019, -0.27); // spine
  // Blood that builds up on the blade with every chop.
  const bt = bladeBloodTex;
  bt.repeat.set(1 / 0.48, 1 / 0.08);
  bt.offset.set(0, 0.05 / 0.08);
  bt.wrapS = bt.wrapT = THREE.ClampToEdgeWrapping;
  machete.blood = add(handle, bg, new THREE.MeshBasicMaterial({ map: bt, color: 0x8a1010, transparent: true, opacity: 0, depthWrite: false }), 0, 0, 0);
  machete.blood.scale.set(1.6, 1.0, 1.0);
  hand.visible = false;
  wcam.add(hand);
  // Slash streak: a ribbon swept along the blade's own path, rebuilt from the pose curve each frame.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  g.setAttribute('alpha', new THREE.BufferAttribute(trailAlpha, 1));
  const idx = [];
  for (let i = 0; i < TRAIL_N; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  g.setIndex(idx);
  machete.trail = new THREE.Mesh(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTint: { value: new THREE.Color(1, 0.92, 0.86) } },
    vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uTint; varying float vA; void main(){ gl_FragColor = vec4(uTint * vA, vA); }',
  }));
  machete.trail.frustumCulled = false;
  machete.trail.visible = false;
  machete.trail.renderOrder = 10;
  wcam.add(machete.trail);
}

// Keyframes in view space: [hand x,y,z,  blade direction x,y,z,  edge direction x,y,z] at SWING_T.
const SWING_T = [0, 0.11, 0.19, 0.29, 0.52];
const SWING_EASE = [ease.outCubic, ease.inQuad, ease.outQuad, ease.inOutCubic];
const FORE = [
  [0.34, -0.5, -0.3, 0.2, 0.9, -0.3, -0.9, 0.1, -0.4],
  [0.3, -0.04, -0.34, 0.35, 0.92, 0.1, -0.55, 0.2, -0.8],
  [0.1, -0.12, -0.46, -0.7, 0.35, -0.62, -0.45, -0.85, 0.2],
  [-0.12, -0.15, -0.5, -0.85, -0.22, -0.4, -0.3, -0.92, 0.1],
  [0.0, -0.8, -0.36, -0.55, -0.65, -0.4, 0.1, -0.9, 0.4],
];
// The backhand mirrors the forehand (so the edge leads the other way), nudged back toward the right hand.
const BACK = FORE.map((p) => [-p[0] + 0.12, p[1], p[2], -p[3], p[4], p[5], -p[6], p[7], p[8]]);
const toPose = (table) => table.map((p) => {
  const z = new V3(-p[3], -p[4], -p[5]).normalize();
  const y = new V3(-p[6], -p[7], -p[8]);
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new V3().crossVectors(y, z);
  return { p: new V3(p[0], p[1], p[2]), q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)) };
});
const POSES = { 1: toPose(FORE), [-1]: toPose(BACK) };
const SWING_DUR = SWING_T[SWING_T.length - 1], HIT_AT = 0.165;
const swing = { active: false, t: 0, side: 1, hitDone: false, pause: 0, freezeAt: -1, count: 0 };
const TRAIL_N = 24, TRAIL_SPAN = 0.15;
const trailPos = new Float32Array((TRAIL_N + 1) * 6), trailAlpha = new Float32Array((TRAIL_N + 1) * 2);
const _pp = new V3(), _pq = new THREE.Quaternion();

// Pose of the hand at swing time t (pure function of t, so the trail can sample the past).
function poseAt(side, t, outP, outQ) {
  const ks = POSES[side];
  let i = 0;
  while (i < SWING_T.length - 2 && t > SWING_T[i + 1]) i++;
  const k = SWING_EASE[i](Math.min(1, Math.max(0, (t - SWING_T[i]) / (SWING_T[i + 1] - SWING_T[i]))));
  outP.lerpVectors(ks[i].p, ks[i + 1].p, k);
  outQ.slerpQuaternions(ks[i].q, ks[i + 1].q, k);
}

function updateTrail(t, side) {
  const tA = SWING_T[1] - 0.015, tB = SWING_T[3] + 0.03;
  const fade = t < tB ? 1 : Math.max(0, 1 - (t - tB) * 7);
  for (let i = 0; i <= TRAIL_N; i++) {
    const ti = Math.max(tA, Math.min(tB, t) - (i / TRAIL_N) * TRAIL_SPAN);
    poseAt(side, ti, _pp, _pq);
    _a.set(0, -0.012, -0.34).applyQuaternion(_pq).add(_pp);
    _b.set(0, -0.03, -0.6).applyQuaternion(_pq).add(_pp);
    trailPos[i * 6] = _a.x; trailPos[i * 6 + 1] = _a.y; trailPos[i * 6 + 2] = _a.z;
    trailPos[i * 6 + 3] = _b.x; trailPos[i * 6 + 4] = _b.y; trailPos[i * 6 + 5] = _b.z;
    const k = (1 - i / TRAIL_N) ** 2 * fade * (t > tA ? 0.5 : 0);
    trailAlpha[i * 2] = 0;
    trailAlpha[i * 2 + 1] = k;
  }
  const g = machete.trail.geometry;
  g.attributes.position.needsUpdate = true;
  g.attributes.alpha.needsUpdate = true;
  machete.trail.visible = fade > 0 && t > tA;
}

function startSwing() {
  if (NZ.vehicle || !playing()) return;
  if (swing.active && swing.t < 0.4) return;
  swing.active = true;
  swing.t = 0;
  swing.hitDone = false;
  swing.pause = 0;
  swing.side = swing.count++ % 2 === 0 ? 1 : -1; // 1 = forehand (right to left)
  if (weapon.reloading > 0) weapon.reloading = 0; // melee cancels a reload, CoD style
  weapon.ads = false;
  weapon.firing = false;
  weapon.cd = Math.max(weapon.cd, SWING_DUR - 0.08);
  machete.hand.visible = true;
  sfx.whoosh(swing.side, 0.07);
  // A small lunge.
  camera.getWorldDirection(_fwd).setY(0).normalize();
  player.vel.addScaledVector(_fwd, 2.2);
}

// Every zombie inside a ~2.2 m, ~110 degree cone takes the blade.
const REACH = 2.2, COS_HALF = Math.cos((55 * Math.PI) / 180);
let macheteActive = false;
function macheteHit() {
  camera.getWorldDirection(_fwd);
  const pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
  _fwd.setY(0).normalize();
  _right.set(-_fwd.z, 0, _fwd.x);
  const cam = camera.position, round = Math.max(1, NZ.ROUND.n);
  const dmg = 300 + 50 * round;
  let hits = 0, kills = 0, closest = 99;
  macheteActive = true;
  for (const z of zombies) {
    if (z.state === 'dead' || z.state === 'rising' || !z.head) continue;
    const chestY = z.pos.y + (z.crawler ? 0.45 : 1.15);
    _a.set(z.pos.x - cam.x, 0, z.pos.z - cam.z);
    const d = _a.length();
    if (d > REACH + 0.35 || Math.abs(chestY - cam.y) > 1.9) continue;
    if (d > 0.45 && _a.dot(_fwd) / d < COS_HALF) continue;
    // No chopping through walls.
    _ray.origin.copy(cam);
    _ray.direction.set(z.pos.x - cam.x, chestY - cam.y, z.pos.z - cam.z);
    const full = _ray.direction.length();
    _ray.direction.divideScalar(full);
    const wall = world.octree.rayIntersect(_ray);
    if (wall && wall.distance < full - 0.35) continue;
    hits++;
    closest = Math.min(closest, d);
    _b.copy(cam).addScaledVector(_ray.direction, Math.max(0.3, full - 0.2)); // hit point on the body
    NZ.damageZombie(z, dmg, false, true, _b);
    const willDie = z.state === 'dead';
    // Blood arcs off the blade in the direction of the swing.
    spray(_b, -_right.x * swing.side + _fwd.x * 0.3, 0.55, -_right.z * swing.side + _fwd.z * 0.3, 4.2, 0.9, 34, z.pos.y);
    spray(_b, -_fwd.x, 0.4, -_fwd.z, 2.2, 1.2, 10, z.pos.y);
    // Which limb comes off: aim high for heads, low for legs, otherwise the arm the blade meets first.
    _c.set(-_right.x * swing.side * 3.2 + _fwd.x * 2, 2.6, -_right.z * swing.side * 3.2 + _fwd.z * 2);
    const armFirst = swing.side > 0 ? 'armR' : 'armL', armSecond = swing.side > 0 ? 'armL' : 'armR';
    if (willDie) {
      kills++;
      if (pitch > 0.12 || Math.random() < 0.35) dismember(z, 'head', _c);
      else if (pitch < -0.32) { dismember(z, 'legL', _c); dismember(z, 'legR', _c); }
      else { dismember(z, armFirst, _c); if (Math.random() < 0.4) dismember(z, armSecond, _c); }
    } else if (pitch < -0.32) dismember(z, Math.random() < 0.5 ? 'legL' : 'legR', _c);
    else if (Math.random() < 0.6) dismember(z, z.lost?.[armFirst] ? armSecond : armFirst, _c);
  }
  macheteActive = false;
  if (hits) {
    sfx.chop(kills > 0);
    swing.pause = 0.065; // hit-stop
    machete.bloodK = Math.min(1, machete.bloodK + 0.6);
    machete.trail.material.uniforms.uTint.value.setRGB(1, 0.35, 0.3);
    player.yaw += 0.018 * swing.side;
    player.pitch -= 0.012;
    if (closest < 1.4) screenSplat(0.55 + kills * 0.2);
    if (hits > 1) NZ.message(hits + ' IN ONE', false, 1.4);
  }
}

function updateSwing(dt) {
  machete.bloodK = Math.max(0, machete.bloodK - dt * 0.02);
  machete.blood.material.opacity = machete.bloodK;
  if (!swing.active) return;
  if (swing.freezeAt >= 0) swing.t = swing.freezeAt;
  else if (swing.pause > 0) swing.pause -= dt;
  else swing.t += dt;
  const t = swing.t;
  poseAt(swing.side, t, machete.hand.position, machete.hand.quaternion);
  updateTrail(t, swing.side);
  if (!swing.hitDone && t >= HIT_AT) {
    swing.hitDone = true;
    macheteHit();
  }
  // Gun dips out of the way while the blade is out.
  const dip = Math.sin(Math.min(1, t / SWING_DUR) * Math.PI);
  view.position.y -= dip * 0.32;
  view.rotation.x -= dip * 0.4;
  if (t >= SWING_DUR && swing.freezeAt < 0) {
    swing.active = false;
    machete.hand.visible = false;
    machete.trail.visible = false;
    machete.trail.material.uniforms.uTint.value.setRGB(1, 0.92, 0.86);
  }
}

// ------------------------------------------------------------------ screen blood
const css = document.createElement('style');
css.textContent = `
#gore-splat { position: absolute; inset: 0; opacity: 0; background-size: cover; background-position: center; pointer-events: none; mix-blend-mode: multiply; }
#gore-parts { position: absolute; left: 26px; bottom: 150px; min-width: 150px; padding: 7px 12px 8px; text-shadow: 0 1px 4px #000;
  background: linear-gradient(90deg, rgba(0,0,0,.5), rgba(0,0,0,0)); border-left: 3px solid var(--blood); transition: transform .12s; }
#gore-parts.bump { transform: scale(1.08); }
#gore-parts .gp-top { display: flex; align-items: baseline; gap: 10px; }
#gore-parts .gp-label { font-size: 13px; letter-spacing: .3em; opacity: .75; }
#gore-parts .gp-total { font-size: 30px; font-weight: 600; color: var(--gold); line-height: 1; }
#gore-parts .gp-row { display: flex; gap: 12px; margin-top: 5px; font-size: 16px; }
#gore-parts .gp-row span { display: flex; align-items: center; gap: 3px; opacity: .45; transition: opacity .2s; }
#gore-parts .gp-row span.has { opacity: 1; }
#gore-parts svg { width: 20px; height: 20px; fill: var(--chalk); }
#gore-parts .gp-bar { height: 3px; margin-top: 6px; background: rgba(232,220,203,.15); }
#gore-parts .gp-bar i { display: block; height: 100%; width: 0; background: var(--blood); box-shadow: 0 0 6px var(--blood); transition: width .25s; }
#gore-pops { position: absolute; left: 26px; bottom: 250px; width: 260px; height: 0; }
#gore-pops div { position: absolute; left: 0; bottom: 0; white-space: nowrap; font-weight: 600; font-size: 26px; letter-spacing: .08em;
  color: #fff; text-shadow: 0 0 8px rgba(160,0,0,.9), 0 2px 2px #000; animation: gorepop 1.5s cubic-bezier(.2,.9,.3,1) forwards; }
#gore-pops div b { color: var(--gold); margin-left: 8px; font-size: 17px; }
@keyframes gorepop { 0% { opacity: 0; transform: translate(-30px, 0) scale(1.3); } 12% { opacity: 1; transform: translate(0, 0) scale(1); }
  70% { opacity: 1; transform: translate(0, -26px); } 100% { opacity: 0; transform: translate(0, -44px); } }
#gore-callout { position: absolute; left: 0; right: 0; top: 34%; text-align: center; font-family: "Creepster", "Oswald", serif; font-size: 44px;
  color: var(--gold); text-shadow: 0 0 18px rgba(150,0,0,.95), 0 3px 0 #300; opacity: 0; pointer-events: none; }
#gore-callout small { display: block; font-family: "Oswald", sans-serif; font-size: 16px; letter-spacing: .3em; color: var(--chalk); }
#gore-callout.show { animation: gorecall 2.6s ease-out forwards; }
@keyframes gorecall { 0% { opacity: 0; transform: scale(1.6); } 10% { opacity: 1; transform: scale(1); } 80% { opacity: 1; } 100% { opacity: 0; transform: translateY(-20px); } }
`;
document.head.appendChild(css);

const splatImg = (() => {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const g = c.getContext('2d');
  const edge = (x, y, r) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(120,0,0,0.95)');
    gr.addColorStop(0.7, 'rgba(150,10,5,0.75)');
    gr.addColorStop(1, 'rgba(150,10,5,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, 7);
    g.fill();
  };
  for (let i = 0; i < 70; i++) {
    const side = i % 4, k = Math.random();
    const x = side === 0 ? k * 640 : side === 1 ? 640 - Math.random() * 90 : side === 2 ? Math.random() * 90 : k * 640;
    const y = side === 0 ? Math.random() * 80 : side === 3 ? 400 - Math.random() * 80 : k * 400;
    edge(x, y, 6 + Math.random() * (i < 16 ? 70 : 22));
  }
  return c.toDataURL();
})();

// ------------------------------------------------------------------ HUD
const ICONS = {
  head: '<svg viewBox="0 0 20 20"><path d="M10 1.5c-4.4 0-7.5 3-7.5 7 0 2.4 1.1 4.2 2.8 5.2V17h2v-1.6h1.6V17h2.2v-1.6h1.6V17h2v-3.3c1.7-1 2.8-2.8 2.8-5.2 0-4-3.1-7-7.5-7zM6.6 11.2a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8zm6.8 0a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z"/></svg>',
  arm: '<svg viewBox="0 0 20 20"><path d="M3 17.5l2.2-6.6c.5-1.5 1.8-2.5 3.3-2.6l2.6-.2.9-3.4c.3-1 1.3-1.6 2.3-1.3l1.8.5c1 .3 1.5 1.3 1.2 2.2l-1.6 4.6c-.4 1.2-1.6 2-2.9 1.9l-2.2-.2-1.6 5.1z"/></svg>',
  leg: '<svg viewBox="0 0 20 20"><path d="M7 1.5h5.2l-.6 9.2 1 4.3 4.1 1.3c.8.3 1.2 1 1 1.7H6.6l.6-3.4z"/></svg>',
  wool: '<svg viewBox="0 0 20 20"><path d="M5.5 16a3.5 3.5 0 0 1-.8-6.9 4.5 4.5 0 0 1 8.4-2.6 3.6 3.6 0 0 1 4.9 3.4A3 3 0 0 1 16 16z"/></svg>',
};
const KINDS = ['head', 'arm', 'leg', 'wool'];
const parts = { total: 0, head: 0, arm: 0, leg: 0, wool: 0 };
let ui = null;
function buildHud() {
  const hud = NZ.$('hud');
  const splatEl = document.createElement('div');
  splatEl.id = 'gore-splat';
  splatEl.style.backgroundImage = `url(${splatImg})`;
  const panel = document.createElement('div');
  panel.id = 'gore-parts';
  panel.innerHTML = `<div class="gp-top"><span class="gp-label">PARTS</span><span class="gp-total">0</span></div>
    <div class="gp-row">${KINDS.map((k) => `<span data-k="${k}">${ICONS[k]}<em>0</em></span>`).join('')}</div>
    <div class="gp-bar"><i></i></div>`;
  const pops = document.createElement('div');
  pops.id = 'gore-pops';
  const callout = document.createElement('div');
  callout.id = 'gore-callout';
  hud.append(splatEl, panel, pops, callout);
  ui = {
    splat: splatEl, panel, pops, callout, total: panel.querySelector('.gp-total'), bar: panel.querySelector('.gp-bar i'),
    kinds: Object.fromEntries(KINDS.map((k) => [k, panel.querySelector(`[data-k="${k}"]`)])),
  };
  for (const dd of document.querySelectorAll('.controls dd')) dd.innerHTML = dd.innerHTML.replace('V knife', 'V / F machete');
  renderHud();
}
function renderHud() {
  if (!ui) return;
  ui.total.textContent = parts.total;
  for (const k of KINDS) {
    ui.kinds[k].querySelector('em').textContent = parts[k];
    ui.kinds[k].classList.toggle('has', parts[k] > 0);
  }
  ui.bar.style.width = ((parts.total % 10) * 10) + '%';
}
function pop(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  ui.pops.appendChild(d);
  // Older popups step up out of the way.
  const kids = ui.pops.children;
  for (let i = 0; i < kids.length - 1; i++) kids[i].style.bottom = (kids.length - 1 - i) * 30 + 'px';
  setTimeout(() => d.remove(), 1500);
}
let splatT = 0;
function screenSplat(k) {
  if (!ui) return;
  ui.splat.style.transition = 'none';
  ui.splat.style.opacity = Math.min(0.95, k);
  ui.splat.style.transform = `scale(${1.05 + Math.random() * 0.1}) rotate(${(Math.random() - 0.5) * 6}deg)`;
  clearTimeout(splatT);
  splatT = setTimeout(() => {
    ui.splat.style.transition = 'opacity 1.4s ease-in';
    ui.splat.style.opacity = 0;
  }, 250);
}

function addPart(kind) {
  if (!(kind in parts) || kind === 'total') kind = 'arm';
  parts[kind]++;
  parts.total++;
  sfx.pickup(kind);
  if (kind === 'head') {
    NZ.addPoints(50, true);
    pop(`+1 HEAD<b>+50</b>`);
  } else pop(`+1 ${kind.toUpperCase()}`);
  renderHud();
  ui.panel.classList.remove('bump');
  void ui.panel.offsetWidth;
  ui.panel.classList.add('bump');
  setTimeout(() => ui.panel.classList.remove('bump'), 140);
  if (parts.total % 10 === 0) {
    NZ.giveGrenade?.(1);
    NZ.giveRocket?.(1);
    ui.callout.innerHTML = `Body Count ${parts.total}<small>+1 grenade &middot; +1 rocket</small>`;
    ui.callout.classList.remove('show');
    void ui.callout.offsetWidth;
    ui.callout.classList.add('show');
    sfx.reward();
  }
}

// ------------------------------------------------------------------ gibs (pooled physics limbs -> pickups)
const GIB_N = 60;
const GIB_GEO = {
  head: new THREE.BoxGeometry(0.25, 0.3, 0.27),
  arm: new THREE.BoxGeometry(0.12, 0.66, 0.12),
  leg: new THREE.BoxGeometry(0.15, 0.86, 0.16),
};
// Half the thickness when lying down, and where the cut end sits along local y.
const GIB_REST = { head: 0.125, arm: 0.06, leg: 0.08 };
const GIB_CUT = { head: -0.15, arm: 0.33, leg: 0.43 };
const goreMat = new THREE.MeshStandardMaterial({ color: 0x5a0808, roughness: 0.45, emissive: 0x1a0000 });
const boneMat = new THREE.MeshStandardMaterial({ color: 0xd8cfb8, roughness: 0.6 });
const capGeo = new THREE.BoxGeometry(1, 1, 1);
const boneGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.07, 6);
const eyeGeo = new THREE.BoxGeometry(0.055, 0.03, 0.02);
const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.2) });
const glowMat = new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,190,140,0.75)', 'rgba(220,40,20,0.22)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 });
const gibs = [];
const AIR = 1, SETTLE = 2, PICKUP = 3, MAGNET = 4;
function buildGibs() {
  for (let i = 0; i < GIB_N; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(GIB_GEO.arm, goreMat);
    body.castShadow = true;
    const cap = new THREE.Mesh(capGeo, goreMat);
    const bone = new THREE.Mesh(boneGeo, boneMat);
    const face = new THREE.Group();
    for (const sx of [-0.06, 0.06]) {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      e.position.set(sx, 0.04, 0.137);
      face.add(e);
    }
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.2), goreMat);
    jaw.position.set(0, -0.13, 0.04);
    face.add(jaw);
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(1.5);
    g.add(body, cap, bone, face, glow);
    g.visible = false;
    scene.add(g);
    gibs.push({
      g, body, cap, bone, face, glow, state: 0, kind: 'arm', vel: new V3(), axis: new V3(), w: 0, floorY: 0, floorT: 0,
      t: 0, born: 0, bounces: 0, fromQ: new THREE.Quaternion(), restQ: new THREE.Quaternion(), baseY: 0, phase: 0, magFrom: new V3(), scale: 1,
    });
  }
}

function takeGib() {
  let best = null;
  for (const b of gibs) {
    if (!b.state) return b;
    if (!best || b.born < best.born) best = b;
  }
  return best;
}

function spawnGib(kind, srcMesh, center, quat, scale, impulse) {
  const b = takeGib();
  b.state = AIR;
  b.kind = kind;
  b.t = 0;
  b.born = now();
  b.bounces = 0;
  b.scale = scale;
  b.body.geometry = GIB_GEO[kind];
  b.body.material = srcMesh ? srcMesh.material : goreMat;
  const cut = GIB_CUT[kind], w = kind === 'head' ? 0.2 : kind === 'arm' ? 0.125 : 0.155;
  b.cap.scale.set(w, 0.025, w);
  b.cap.position.set(0, cut + Math.sign(cut) * 0.008, 0);
  b.bone.visible = kind !== 'head';
  b.bone.position.set(0, cut + Math.sign(cut) * 0.035, 0);
  b.face.visible = kind === 'head';
  b.glow.visible = false;
  b.g.position.copy(center);
  b.g.quaternion.copy(quat);
  b.g.scale.setScalar(scale);
  b.g.visible = true;
  b.vel.copy(impulse);
  b.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  b.w = 7 + Math.random() * 10;
  b.floorY = floorAt(center.x, center.y, center.z);
  b.floorT = 0.12;
  b.phase = Math.random() * 6.28;
}

function freeGib(b) {
  b.state = 0;
  b.g.visible = false;
}

function updateGibs(dt, t) {
  const pp = player.collider.start;
  for (const b of gibs) {
    if (!b.state) continue;
    b.t += dt;
    const p = b.g.position;
    if (b.state === AIR) {
      b.vel.y -= 15 * dt;
      p.addScaledVector(b.vel, dt);
      _q.setFromAxisAngle(b.axis, b.w * dt);
      b.g.quaternion.premultiply(_q);
      if (b.t < 0.8) spray(p, 0, 0.2, 0, 0.6, 1.2, 1, b.floorY, 0.7); // trail
      b.floorT -= dt;
      if (b.floorT <= 0) {
        b.floorT = 0.12;
        b.floorY = floorAt(p.x, p.y, p.z);
      }
      // Walls: push out and bounce off.
      _sphere.center.copy(p);
      const hit = world.octree.sphereIntersect(_sphere);
      let ground = p.y - GIB_REST[b.kind] * b.scale <= b.floorY;
      if (hit) {
        if (hit.normal.y > 0.55) {
          ground = true;
          b.floorY = Math.max(b.floorY, p.y - GIB_REST[b.kind] * b.scale);
        } else {
          p.addScaledVector(hit.normal, hit.depth);
          const vn = b.vel.dot(hit.normal);
          if (vn < 0) b.vel.addScaledVector(hit.normal, -1.4 * vn);
          b.vel.multiplyScalar(0.7);
        }
      }
      if (ground && b.vel.y < 0) {
        const rest = GIB_REST[b.kind] * b.scale;
        p.y = b.floorY + rest;
        if (!b.bounces) {
          splat(p.x, b.floorY, p.z, b.kind === 'head' ? 0.9 : 1.1);
          spray(p, 0, 0.9, 0, 1.6, 2, 10, b.floorY - 0.01, 0.5);
          sfx.splatAt(p, 0.45);
        }
        if (b.vel.y < -2.2 && b.bounces < 2) {
          b.bounces++;
          b.vel.y = -b.vel.y * 0.3;
          b.vel.x *= 0.5;
          b.vel.z *= 0.5;
          b.w *= 0.5;
        } else {
          // Settle: tip over to lie flat on the ground.
          b.state = SETTLE;
          b.t = 0;
          b.fromQ.copy(b.g.quaternion);
          _e.set(b.kind === 'head' ? 0 : Math.PI / 2, Math.random() * 6.28, b.kind === 'head' ? (Math.random() < 0.5 ? 1.3 : -1.3) : 0);
          b.restQ.setFromEuler(_e);
          b.baseY = b.floorY + rest;
          b.vel.set(b.vel.x * 0.4, 0, b.vel.z * 0.4);
        }
      }
    } else if (b.state === SETTLE) {
      const k = Math.min(1, b.t / 0.22);
      b.g.quaternion.slerpQuaternions(b.fromQ, b.restQ, ease.outBack(k));
      p.x += b.vel.x * dt * (1 - k);
      p.z += b.vel.z * dt * (1 - k);
      p.y = b.baseY;
      if (k >= 1) {
        b.state = PICKUP;
        b.t = 0;
        b.glow.visible = true;
      }
    } else if (b.state === PICKUP) {
      p.y = b.baseY + 0.05 + Math.sin(t * 2.6 + b.phase) * 0.035;
      const left = 45 - b.t;
      b.g.visible = left > 6 || Math.sin(b.t * (left > 2.5 ? 14 : 30)) > -0.2;
      if (left <= 0) { freeGib(b); continue; }
      const dx = pp.x - p.x, dz = pp.z - p.z;
      if (dx * dx + dz * dz < 1.5 * 1.5 && Math.abs(pp.y - p.y) < 1.8 && playing()) {
        b.state = MAGNET;
        b.t = 0;
        b.magFrom.copy(p);
        b.g.visible = true;
      }
    } else if (b.state === MAGNET) {
      const k = Math.min(1, b.t / 0.16);
      _a.copy(camera.position).setY(camera.position.y - 0.55);
      p.lerpVectors(b.magFrom, _a, ease.inQuad(k));
      b.g.scale.setScalar(b.scale * (1 - 0.7 * k));
      if (k >= 1) {
        freeGib(b);
        addPart(b.kind);
      }
    }
  }
}

// ------------------------------------------------------------------ dismemberment
const STUMP_N = 32;
const stumps = []; // spurting stumps on living (or dying) bodies
for (let i = 0; i < STUMP_N; i++) stumps.push({ obj: null, z: null, t: 0 });
let stumpNext = 0;
const PART_KIND = { head: 'head', armL: 'arm', armR: 'arm', legL: 'leg', legR: 'leg' };
const _imp = new V3(), _ctr = new V3(), _wq = new THREE.Quaternion();

function dismember(z, part, impulse) {
  const kind = PART_KIND[part];
  if (!z || !kind || !z[part] || z.remove) return false;
  z.lost ||= {};
  if (z.lost[part]) return false;
  z.lost[part] = true;
  const grp = z[part], mesh = part === 'armL' || part === 'armR' ? grp.children[0] : grp;
  mesh.updateWorldMatrix(true, false);
  _ctr.set(0, kind === 'head' ? 0.16 : kind === 'arm' ? -0.3 : -0.43, kind === 'head' ? 0.02 : 0);
  mesh.localToWorld(_ctr);
  mesh.getWorldQuaternion(_wq);
  if (impulse) _imp.copy(impulse);
  else _imp.set(z.pos.x - camera.position.x, 0, z.pos.z - camera.position.z).normalize().multiplyScalar(2.5).setY(3);
  _imp.x += (Math.random() - 0.5) * 1.2;
  _imp.z += (Math.random() - 0.5) * 1.2;
  if (_imp.y < 1.2) _imp.y = 1.2 + Math.random();
  spawnGib(kind, mesh, _ctr, _wq, z.root.scale.x, _imp);
  // Hide it on the body and stop it catching bullets (array indices stay as they were for other modules).
  grp.visible = false;
  mesh.raycast = noRaycast;
  // Bloody stump at the joint.
  const stump = new THREE.Mesh(capGeo, goreMat);
  const parent = kind === 'head' ? z.neck : kind === 'arm' ? z.spine : z.hips;
  if (kind === 'head') stump.position.set(0, 0.02, 0.01);
  else stump.position.copy(grp.position).setY(grp.position.y + (kind === 'arm' ? -0.03 : -0.02));
  stump.scale.set(kind === 'head' ? 0.16 : 0.13, 0.04, kind === 'head' ? 0.16 : 0.14);
  parent.add(stump);
  // Burst + a spurting stump for a moment.
  _a.copy(_ctr).lerp(stump.getWorldPosition(_b), 0.6);
  spray(_a, _imp.x * 0.25, 0.9, _imp.z * 0.25, 3.4, 1.4, 40, z.pos.y);
  const s = stumps[stumpNext++ % STUMP_N];
  s.obj = stump;
  s.z = z;
  s.t = kind === 'head' ? 1.6 : 1.1;
  splat(z.pos.x + _imp.x * 0.15, z.pos.y, z.pos.z + _imp.z * 0.15, 1.3);
  sfx.crack();
  // Consequences.
  if (kind === 'head' && z.state !== 'dead') {
    NZ.killZombie(z, true, false);
  } else if (kind === 'leg' && z.state !== 'dead') becomeCrawler(z);
  return true;
}
function noRaycast() {}

function updateStumps(dt) {
  for (const s of stumps) {
    if (s.t <= 0) continue;
    s.t -= dt;
    if (s.z.remove) { s.t = 0; continue; }
    s.obj.getWorldPosition(_a);
    _b.set(0, 1, 0).applyQuaternion(s.obj.getWorldQuaternion(_q));
    spray(_a, _b.x, _b.y, _b.z, 1.6 + s.t * 1.2, 0.5, 2, s.z.pos.y, 0.8);
  }
}

// ------------------------------------------------------------------ crawlers
function becomeCrawler(z) {
  if (z.crawler) return;
  z.crawler = true;
  z.crawlSpeed = 0.55 + Math.random() * 0.3;
  z.root.rotation.order = 'YXZ';
}

// Before the default brain: a crawler never sprints and drags itself along slowly.
hooks.zombieUpdate.push((z) => {
  if (!z.crawler) return;
  z.sprinter = false;
  if (z.speed > z.crawlSpeed) z.speed = z.crawlSpeed;
});

// Runs after the default zombie brain has posed everyone: drag the legless along the ground.
function poseCrawlers() {
  for (const z of zombies) {
    if (!z.crawler) continue;
    if (z.state === 'dead') {
      z.root.rotation.x = 1.3 + Math.min(1, z.t / 0.4) * 0.22;
      continue;
    }
    if (z.state === 'rising') continue;
    const s = Math.sin(z.phase), h = z.heading;
    z.root.rotation.x = 1.3;
    z.root.position.set(z.pos.x - Math.sin(h) * 0.7, z.pos.y + 0.06 + Math.abs(s) * 0.03, z.pos.z - Math.cos(h) * 0.7);
    z.hips.position.y = 0.92;
    z.spine.rotation.x = -0.28 + s * 0.06;
    z.spine.rotation.z = s * 0.12;
    z.neck.rotation.x = -0.9;
    const claw = z.swing > 0 ? -2.0 + Math.sin(z.swing * Math.PI) * 0.8 : 0;
    z.armL.rotation.x = (claw || -1.15) + s * 0.55;
    z.armR.rotation.x = (claw || -1.15) - s * 0.55;
    z.armL.rotation.z = -0.25;
    z.armR.rotation.z = 0.25;
    z.legL.rotation.x = 0.12 + s * 0.12;
    z.legR.rotation.x = 0.12 - s * 0.12;
  }
}

// ------------------------------------------------------------------ hooks
// Remember the burst damage of each hit (pellets in the same frame add up) so big kills can gib.
hooks.zombieDamage.push((z, dmg, head, knife, point) => {
  const t = now();
  if (z.goreT !== t) z.goreAcc = 0;
  z.goreT = t;
  z.goreAcc += dmg;
  z.goreHead = head;
  if (point) (z.goreP ||= new V3()).copy(point);
});

hooks.kill.push((z, headshot) => {
  if (macheteActive || !z.head) return;
  const dmg = z.goreT === now() ? z.goreAcc : 0;
  if (!headshot && dmg < 300) return;
  // Blow parts away from the blast/shot.
  const p = z.goreP;
  if (p && Math.hypot(p.x - z.pos.x, p.z - z.pos.z) > 0.6) _c.set(z.pos.x - p.x, 0, z.pos.z - p.z);
  else _c.set(z.pos.x - camera.position.x, 0, z.pos.z - camera.position.z);
  const power = Math.min(7, 2.4 + dmg / 400);
  _c.normalize().multiplyScalar(power).setY(2.5 + Math.min(4, dmg / 500));
  if (headshot) {
    dismember(z, 'head', _c);
    return;
  }
  const insta = dmg >= 1e6; // insta-kill: one limb, not a blender
  const n = insta ? 1 : dmg >= 1500 ? 3 : dmg >= 700 ? 2 : 1;
  const pool = Math.random() < 0.6 ? ['armL', 'armR', 'legL', 'legR'] : ['legL', 'legR', 'armL', 'armR'];
  let taken = 0;
  for (let i = 0; i < 8 && taken < n; i++) {
    const part = pool[(i + ((Math.random() * 4) | 0)) % 4];
    if (dismember(z, part, _c)) taken++;
  }
  if (!insta && dmg >= 1500 && Math.random() < 0.5) dismember(z, 'head', _c);
});

hooks.ready.push(() => {
  buildMachete();
  buildGibs();
  buildHud();
});

hooks.update.push((dt, t) => {
  updateSwing(dt);
  updateStumps(dt);
  updateGibs(dt, t);
  poseCrawlers();
});

hooks.frame.push((dt) => updateDrops(dt));

hooks.reset.push(() => {
  for (const b of gibs) freeGib(b);
  for (const d of decals) d.visible = false;
  for (const s of stumps) s.t = 0;
  dropLife.fill(0);
  for (let i = 0; i < DROP_N; i++) dropPos[i * 3 + 1] = -999;
  dropGeo.attributes.position.needsUpdate = true;
  for (const k in parts) parts[k] = 0;
  swing.active = false;
  swing.freezeAt = -1;
  machete.hand.visible = machete.trail.visible = false;
  machete.bloodK = 0;
  renderHud();
});

// ------------------------------------------------------------------ public contracts
NZ.melee = startSwing;
NZ.dismember = dismember;
NZ.addPart = addPart;
NZ.gore = { parts, gibs };

// Debug hooks for the automated browser check.
const alive = () => zombies.filter((z) => z.state !== 'dead' && z.head);
const nearest = () => {
  const p = camera.position;
  return alive().sort((a, b) => a.pos.distanceToSquared(p) - b.pos.distanceToSquared(p))[0];
};
const pick = (i) => (i === 'last' ? alive().pop() : i < 0 ? nearest() : alive()[i]);
window.__game_gore = {
  swing: startSwing,
  freezeSwing(t = -1, side) {
    if (side) swing.side = side;
    swing.freezeAt = t;
    if (t >= 0) { swing.active = true; swing.hitDone = true; machete.hand.visible = true; }
  },
  dismember(part, i = -1) {
    const z = pick(i);
    return z ? dismember(z, part) : false;
  },
  crawler(i = -1) {
    const z = pick(i);
    return z ? dismember(z, 'legL') && dismember(z, 'legR') : false;
  },
  hold(on = true) { for (const z of zombies) { if (on) { z._sp ??= z.speed; z.speed = 0.0001; } else if (z._sp) { z.speed = z._sp; delete z._sp; } } },
  gibAt(kind, x, y) {
    const g = NZ.groundAt(x, -y);
    spawnGib(kind, null, _ctr.set(x, g + 1.2, -y), _q.identity(), 1, _imp.set(0.5, 2, 0));
  },
  addPart,
  get parts() { return { ...parts }; },
  get gibs() { return gibs.reduce((a, b) => { if (b.state) a[['', 'air', 'settle', 'pickup', 'magnet'][b.state]]++; return a; }, { air: 0, settle: 0, pickup: 0, magnet: 0 }); },
  get crawlers() { return zombies.filter((z) => z.crawler && z.state !== 'dead').length; },
  get nearestDist() { const z = nearest(); return z ? +z.pos.distanceTo(camera.position).toFixed(2) : null; },
};
