// The dune buggy: parked in the garage, E to get in/out. Arcade raycast-suspension physics against the
// level octree (and NZ.terrainAt when the world module provides it), chase/seat cameras, synth engine,
// headlights, dust, and zombies under the wheels. Sets NZ.vehicle while driving.
const NZ = window.NZ;
const { THREE, V3, P, hooks, player, weapon, keys } = NZ;

const PARK = { x: 43.5, y: 5.8, yaw: Math.PI / 2 }; // middle bay of the garage, nose to the doors
const T = {
  g: 18, k: 34, damp: 4.6, rest: 0.42, travel: 0.62, R: 0.42,
  top: 24, boostTop: 36, accel: 16, brake: 28, reverse: 9, grip: 10, driftGrip: 1.3, maxLat: 30, wheelbase: 2.3,
};
const WHEELS = [
  { x: -0.8, z: -1.15, front: true }, { x: 0.8, z: -1.15, front: true },
  { x: -0.8, z: 1.15, front: false }, { x: 0.8, z: 1.15, front: false },
];
const HULL = [
  [-0.4, 0.1, -1.2, 0.5], [0.4, 0.1, -1.2, 0.5], [-0.4, 0.1, 0, 0.5], [0.4, 0.1, 0, 0.5],
  [-0.4, 0.1, 1.15, 0.5], [0.4, 0.1, 1.15, 0.5], [0, 0.95, 0.15, 0.55],
];
const INV_I = new V3(1 / 1.5, 1 / 1.9, 1 / 0.9); // body-frame inverse inertia (pitch, yaw, roll), per unit mass
const SEAT = new V3(0.33, 0.8, 0.22); // right-hand drive: this is New Zealand

const UP = new V3(0, 1, 0);
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _n = new V3(), _r = new V3(), _q = new THREE.Quaternion();
const _ray = new THREE.Ray();
const _sphere = new THREE.Sphere();

const buggy = {
  kind: 'buggy', group: new THREE.Group(), pos: new V3(), vel: new V3(), quat: new THREE.Quaternion(), angVel: new V3(),
  steer: 0, throttle: 0, boost: 1, boosting: false, grounded: 0, airT: 0, speed: 0, slip: 0, rpm: 0,
  wheels: WHEELS.map((w) => ({ ...w, len: T.travel, contact: false, spin: 0, mesh: null, spinner: null, normal: new V3(0, 1, 0) })),
  lights: null, seatView: false, grabT: 0, flippedT: 0, shake: 0, combo: 0, comboT: 0,
};
let driving = false, settleT = 0, nearHintT = 0, camYaw = 0, orbit = 0, lastYaw = 0, orbitIdle = 0, flipCd = 0;
const camPos = new V3(), camLook = new V3();

// ------------------------------------------------------------------ ground + collision queries
// Distance along `dir` from `origin` to the ground, or Infinity; leaves the surface normal in _n.
function probe(origin, dir, maxLen) {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);
  const hit = NZ.world.octree.rayIntersect(_ray);
  let dist = Infinity;
  if (hit && hit.distance <= maxLen) {
    dist = hit.distance;
    hit.triangle.getNormal(_n);
  }
  if (NZ.terrainAt && dir.y < -0.3) {
    // Heightfield terrain from the world module: march down the ray a couple of times.
    let t = 0;
    for (let i = 0; i < 3; i++) {
      const h = NZ.terrainAt(origin.x + dir.x * t, origin.z + dir.z * t);
      t = (origin.y - h) / -dir.y;
    }
    if (t >= 0 && t < dist && t <= maxLen) {
      dist = t;
      const x = origin.x + dir.x * t, z = origin.z + dir.z * t, e = 0.5;
      _n.set(NZ.terrainAt(x - e, z) - NZ.terrainAt(x + e, z), 2 * e, NZ.terrainAt(x, z - e) - NZ.terrainAt(x, z + e)).normalize();
    }
  }
  return dist;
}

// World-space inverse inertia applied to a vector (in place).
function invI(v) {
  _q.copy(buggy.quat).invert();
  v.applyQuaternion(_q).multiply(INV_I).applyQuaternion(buggy.quat);
  return v;
}

// ------------------------------------------------------------------ the model
const M = {
  cage: new THREE.MeshStandardMaterial({ color: 0xff6a12, roughness: 0.42, metalness: 0.35 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x2e3524, roughness: 0.75, metalness: 0.2 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1d1e21, roughness: 0.6, metalness: 0.55 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.96 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xa4a7ad, roughness: 0.32, metalness: 0.85 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 }),
  trim: new THREE.MeshStandardMaterial({ color: 0xb3150c, roughness: 0.7 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.15, metalness: 1 }),
  lens: new THREE.MeshBasicMaterial({ color: 0x555048 }),
  bar: new THREE.MeshBasicMaterial({ color: 0x4a4c50 }),
  tail: new THREE.MeshBasicMaterial({ color: 0x400806 }),
};

function tube(parent, a, b, r = 0.04, mat = M.cage) {
  const va = new V3(...a), vb = new V3(...b), len = va.distanceTo(vb);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, vb.sub(va).normalize());
  m.castShadow = true;
  parent.add(m);
  return m;
}

function box(parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function tyreGeometry(R, W) {
  const parts = [new THREE.CylinderGeometry(R - 0.05, R - 0.05, W, 22).rotateZ(Math.PI / 2)];
  // Chunky knobbly tread: two staggered rows of blocks plus shoulder lugs.
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const off = side * W * 0.24, aa = a + (side > 0 ? Math.PI / 20 : 0);
      const k = new THREE.BoxGeometry(W * 0.44, 0.075, 0.13).translate(off, R - 0.04, 0);
      k.rotateX(aa);
      parts.push(k);
      const s = new THREE.BoxGeometry(0.05, 0.1, 0.09).translate(side * (W / 2 + 0.01), R - 0.09, 0);
      s.rotateX(aa + 0.08);
      parts.push(s);
    }
  }
  return NZ.mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function buildWheel(W) {
  const g = new THREE.Group(), spinner = new THREE.Group();
  g.add(spinner);
  const tyre = new THREE.Mesh(buildWheel.geo ||= tyreGeometry(T.R, 0.36), M.tyre);
  tyre.castShadow = true;
  spinner.add(tyre);
  const out = W ? 1 : -1;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.3, 14).rotateZ(Math.PI / 2), M.rim);
  spinner.add(rim);
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.36, 0.06), M.dark);
    s.position.x = out * 0.16;
    s.rotation.x = (i / 5) * Math.PI;
    spinner.add(s);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.36, 10).rotateZ(Math.PI / 2), M.chrome);
  hub.position.x = out * 0.02;
  spinner.add(hub);
  return { g, spinner };
}

function buildBuggy() {
  const b = buggy.group, body = new THREE.Group();
  b.add(body);
  buggy.body = body;
  // Floor pan, nose, side pods.
  box(body, 1.3, 0.1, 2.9, M.dark, 0, -0.32, 0);
  box(body, 1.1, 0.36, 0.55, M.panel, 0, -0.12, -1.42);
  box(body, 1.0, 0.12, 0.55, M.panel, 0, 0.1, -1.3, 0.25);
  for (const s of [-1, 1]) box(body, 0.12, 0.3, 1.6, M.panel, s * 0.66, -0.15, 0.05);
  // Frame rails and the tube roll cage.
  for (const s of [-1, 1]) {
    tube(body, [s * 0.66, -0.26, -1.55], [s * 0.66, -0.26, 1.55], 0.045);
    tube(body, [s * 0.64, -0.24, 0.66], [s * 0.56, 1.06, 0.6], 0.05); // main hoop legs
    tube(body, [s * 0.64, -0.1, -1.2], [s * 0.5, 1.0, -0.36], 0.045); // A-pillars
    tube(body, [s * 0.5, 1.0, -0.36], [s * 0.56, 1.06, 0.6], 0.045); // roof rails
    tube(body, [s * 0.56, 1.06, 0.6], [s * 0.5, -0.02, 1.58], 0.04); // rear braces
    tube(body, [s * 0.68, 0.25, -0.95], [s * 0.68, 0.25, 0.64], 0.04); // side bars
    tube(body, [s * 0.68, 0.25, -0.95], [s * 0.64, -0.1, -1.2], 0.04);
    tube(body, [s * 0.66, -0.26, 1.55], [s * 0.5, -0.02, 1.58], 0.04);
  }
  tube(body, [-0.56, 1.06, 0.6], [0.56, 1.06, 0.6], 0.05);
  tube(body, [-0.5, 1.0, -0.36], [0.5, 1.0, -0.36], 0.045);
  tube(body, [-0.56, 1.06, 0.6], [0.64, -0.2, 0.66], 0.04);
  tube(body, [-0.53, 1.03, 0.12], [0.53, 1.03, 0.12], 0.035);
  tube(body, [-0.66, 0.22, -0.62], [0.66, 0.22, -0.62], 0.04, M.dark); // dash bar
  // Bull bar.
  tube(body, [-0.72, -0.12, -1.78], [0.72, -0.12, -1.78], 0.05);
  tube(body, [-0.72, 0.2, -1.74], [0.72, 0.2, -1.74], 0.04);
  for (const s of [-1, 1]) {
    tube(body, [s * 0.72, -0.12, -1.78], [s * 0.72, 0.2, -1.74], 0.04);
    tube(body, [s * 0.3, -0.12, -1.78], [s * 0.4, -0.15, -1.6], 0.04);
  }
  // Seats with red trim.
  for (const sx of [-0.33, 0.33]) {
    box(body, 0.5, 0.14, 0.5, M.seat, sx, -0.2, 0.18);
    box(body, 0.5, 0.72, 0.13, M.seat, sx, 0.2, 0.46, -0.14);
    box(body, 0.52, 0.06, 0.14, M.trim, sx, 0.57, 0.5, -0.14);
    for (const e of [-1, 1]) box(body, 0.06, 0.24, 0.48, M.seat, sx + e * 0.25, -0.06, 0.2);
  }
  // Steering wheel (driver's side, right).
  tube(body, [0.33, 0.12, -0.62], [0.33, 0.33, -0.42], 0.025, M.dark);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.026, 8, 22), M.seat);
  wheel.position.set(0.33, 0.35, -0.4);
  wheel.rotation.x = -0.75;
  const spokeBar = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.02), M.dark);
  wheel.add(spokeBar);
  body.add(wheel);
  buggy.steeringWheel = wheel;
  // Rear engine, exhausts and spare tyre.
  box(body, 0.9, 0.46, 0.62, M.dark, 0, -0.02, 1.28);
  box(body, 0.7, 0.08, 0.5, M.chrome, 0, 0.24, 1.26);
  const spare = new THREE.Mesh(buildWheel.geo ||= tyreGeometry(T.R, 0.36), M.tyre);
  spare.scale.setScalar(0.85);
  spare.rotation.z = Math.PI / 2;
  spare.position.set(0, 0.42, 1.28);
  spare.castShadow = true;
  body.add(spare);
  buggy.flames = [];
  const flameMat = new THREE.SpriteMaterial({ map: NZ.flashTexture(), color: 0x88aaff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  for (const s of [-1, 1]) {
    tube(body, [s * 0.28, -0.05, 1.5], [s * 0.34, 0.12, 1.86], 0.05, M.chrome);
    const f = new THREE.Sprite(flameMat);
    f.position.set(s * 0.35, 0.14, 1.98);
    f.visible = false;
    body.add(f);
    buggy.flames.push(f);
  }
  // Lamps: round headlights, a roll-bar light bar, taillights.
  buggy.lensMeshes = [];
  for (const s of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.14, 14).rotateX(Math.PI / 2), M.dark);
    pod.position.set(s * 0.44, 0.06, -1.72);
    body.add(pod);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 16), M.lens);
    lens.position.set(s * 0.44, 0.06, -1.795);
    lens.rotation.y = Math.PI;
    body.add(lens);
  }
  box(body, 1.02, 0.1, 0.12, M.dark, 0, 1.1, -0.38);
  for (let i = 0; i < 4; i++) {
    const x = -0.36 + i * 0.24;
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.065, 0.12, 12).rotateX(Math.PI / 2), M.dark);
    pod.position.set(x, 1.2, -0.44);
    body.add(pod);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.065, 12), M.bar);
    lens.position.set(x, 1.2, -0.505);
    lens.rotation.y = Math.PI;
    body.add(lens);
  }
  for (const s of [-1, 1]) box(body, 0.2, 0.09, 0.04, M.tail, s * 0.36, 0.12, 1.6);
  // A whip antenna with a flag.
  tube(body, [0.56, 1.06, 0.6], [0.6, 1.62, 0.66], 0.008, M.dark);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.16), new THREE.MeshStandardMaterial({ color: 0xff6a12, side: THREE.DoubleSide, roughness: 0.8 }));
  flag.position.set(0.6, 1.54, 0.8);
  flag.rotation.y = Math.PI / 2;
  body.add(flag);
  buggy.flag = flag;
  // Wheels.
  for (const w of buggy.wheels) {
    const { g, spinner } = buildWheel(w.x > 0);
    g.position.set(w.x, -w.len, w.z);
    b.add(g);
    w.mesh = g;
    w.spinner = spinner;
  }
  // Light sources: always in the scene (intensity 0 when off) so materials never recompile mid-game.
  const beamTex = beamTexture();
  const lights = { head: [], beams: [] };
  for (const s of [-1, 1]) {
    const l = new THREE.SpotLight(0xfff0d8, 0, 60, 0.42, 0.5, 1.2);
    l.position.set(s * 0.44, 0.06, -1.8);
    l.target.position.set(s * 0.9, -1.6, -14);
    b.add(l, l.target);
    lights.head.push(l);
  }
  lights.bar = new THREE.SpotLight(0xe6eeff, 0, 75, 0.62, 0.65, 1.2);
  lights.bar.position.set(0, 1.2, -0.5);
  lights.bar.target.position.set(0, -2, -16);
  b.add(lights.bar, lights.bar.target);
  lights.tail = new THREE.PointLight(0xff1a0a, 0, 7, 1.6);
  lights.tail.position.set(0, 0.15, 1.85);
  b.add(lights.tail);
  for (const s of [-1, 1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 11, 20, 1, true).translate(0, -5.5, 0).rotateX(Math.PI / 2).rotateX(-0.08),
      new THREE.MeshBasicMaterial({ color: 0xfff2d0, alphaMap: beamTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    cone.position.set(s * 0.44, 0.06, -1.82); // tip at the lamp, opening forward (-z)
    b.add(cone);
    lights.beams.push(cone);
  }
  buggy.lights = lights;
  NZ.scene.add(b);
}

function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgb(255,255,255)');
  grad.addColorStop(0.3, 'rgb(90,90,90)');
  grad.addColorStop(1, 'rgb(0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

function setLamps(on, brake) {
  const L = buggy.lights;
  for (const l of L.head) l.intensity = on ? 160 : 0;
  L.bar.intensity = on ? 110 : 0;
  for (const c of L.beams) c.material.opacity = on ? 0.09 : 0;
  L.tail.intensity = on ? (brake ? 6 : 2) : 0;
  M.lens.color.setRGB(on ? 4 : 0.33, on ? 3.8 : 0.31, on ? 3.2 : 0.28);
  M.bar.color.setRGB(on ? 3.4 : 0.29, on ? 3.6 : 0.3, on ? 4 : 0.31);
  M.tail.color.setRGB(on ? (brake ? 5 : 1.6) : 0.25, on ? 0.12 : 0.03, on ? 0.06 : 0.02);
}

// ------------------------------------------------------------------ the garage doors roll up
// The level bakes the three garage doors shut. Drop their triangles from the collider and the render
// meshes, hang rolled-up drums under the lintel, and let the walk grid through.
function openGarage() {
  const inDoor = (x, y, z) => x > 39.355 && x < 39.465 && y > -0.01 && y < 2.41 && -z > 1.57 && -z < 9.7;
  const strip = (node) => {
    node.triangles = node.triangles.filter((t) => !(inDoor(t.a.x, t.a.y, t.a.z) && inDoor(t.b.x, t.b.y, t.b.z) && inDoor(t.c.x, t.c.y, t.c.z)));
    for (const s of node.subTrees) strip(s);
  };
  strip(NZ.world.octree);
  NZ.scene.traverse((m) => {
    if (!m.isMesh || !m.geometry.index || m.parent !== NZ.scene) return;
    const p = m.geometry.attributes.position, idx = m.geometry.index;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    if (bb.min.x > 39.5 || bb.max.x < 39.3 || bb.min.z > -1.5 || bb.max.z < -9.8) return;
    let changed = false;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
      if (inDoor(p.getX(a), p.getY(a), p.getZ(a)) && inDoor(p.getX(b), p.getY(b), p.getZ(b)) && inDoor(p.getX(c), p.getY(c), p.getZ(c))) {
        idx.setX(i + 1, a);
        idx.setX(i + 2, a);
        changed = true;
      }
    }
    if (changed) idx.needsUpdate = true;
  });
  const drumMat = new THREE.MeshStandardMaterial({ color: 0x6f5d4c, roughness: 0.8 });
  for (const [y0, y1] of [[1.58, 3.92], [4.55, 7.06], [7.18, 9.69]]) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, y1 - y0, 16).rotateX(Math.PI / 2), drumMat);
    drum.position.copy(P(39.62, (y0 + y1) / 2, 2.22));
    drum.castShadow = true;
    NZ.scene.add(drum);
  }
  // Re-test the walk grid across the doorway so zombies can follow you in.
  const G = NZ.grid, walk = NZ.walk, cap = new NZ.Capsule(new V3(), new V3(), 0.28);
  for (let py = 1.5; py < 9.8; py += G.cs) {
    for (let px = 38.6; px < 40.4; px += G.cs) {
      const c = NZ.cellOf(px, -py);
      if (c < 0) continue;
      const h = NZ.groundAt(px, -py);
      cap.start.set(px, h + 0.62, -py);
      cap.end.set(px, h + 1.55, -py);
      walk[c] = NZ.world.octree.capsuleIntersect(cap) ? 0 : 1;
    }
  }
}

// ------------------------------------------------------------------ audio
let A = null;
function buildAudio() {
  const s = NZ.sound;
  if (A || !s.ctx) return;
  const ctx = s.ctx;
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(s.master);
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 3);
  shaper.curve = curve;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  lp.Q.value = 3;
  const eng = ctx.createGain();
  eng.gain.value = 0.32;
  const oscs = [['sawtooth', 1, 0.5], ['square', 0.5, 0.35], ['sawtooth', 2.01, 0.12]].map(([type, mul, gain]) => {
    const o = ctx.createOscillator();
    o.type = type;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(shaper);
    o.start();
    return { o, mul };
  });
  // Lumpy idle: an LFO wobbling the amplitude at the firing rate.
  const putt = ctx.createOscillator();
  putt.type = 'square';
  const puttG = ctx.createGain();
  puttG.gain.value = 0.12;
  putt.connect(puttG).connect(eng.gain);
  putt.start();
  shaper.connect(lp).connect(eng).connect(out);
  const noiseBus = (type, freq, q) => {
    const n = s.noiseSrc(true);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    n.connect(f).connect(g).connect(out);
    n.start(0, Math.random());
    return { f, g };
  };
  const roar = noiseBus('lowpass', 380, 0.7);
  const skid = noiseBus('bandpass', 1500, 2.5);
  const whine = ctx.createOscillator();
  whine.type = 'triangle';
  const whineG = ctx.createGain();
  whineG.gain.value = 0;
  whine.connect(whineG).connect(out);
  whine.start();
  A = { ctx, out, lp, eng, oscs, putt, roar, skid, whine, whineG };
}

function updateAudio(dt) {
  if (!A) buildAudio();
  if (!A) return;
  const t = A.ctx.currentTime, b = buggy;
  A.out.gain.setTargetAtTime(driving ? 0.85 : 0, t, driving ? 0.05 : 0.4);
  if (!driving) return;
  // Fake gearbox: rpm climbs through each gear and drops on the shift.
  const sp = Math.abs(b.speed), gearW = 8.5;
  const inGear = sp < 1 ? 0 : ((sp % gearW) / gearW) * 0.75 + 0.25 * Math.min(1, sp / 30);
  const targetRpm = b.grounded ? Math.max(b.throttle * 0.45, inGear) : 0.25 + b.throttle * 0.75;
  b.rpm += (targetRpm - b.rpm) * Math.min(1, dt * (targetRpm > b.rpm ? 9 : 5));
  const f = 34 + b.rpm * 120 + (b.boosting ? 18 : 0);
  for (const { o, mul } of A.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.03);
  A.putt.frequency.setTargetAtTime(f * 0.5, t, 0.03);
  A.lp.frequency.setTargetAtTime(380 + b.rpm * 1900 + b.throttle * 500, t, 0.05);
  A.eng.gain.setTargetAtTime(0.22 + b.throttle * 0.16 + b.rpm * 0.1, t, 0.05);
  A.roar.g.gain.setTargetAtTime(b.grounded ? Math.min(0.5, sp / 40) : 0, t, 0.08);
  A.roar.f.frequency.setTargetAtTime(220 + sp * 18, t, 0.1);
  A.skid.g.gain.setTargetAtTime(b.grounded ? Math.min(0.4, Math.max(0, b.slip - 2.5) * 0.06) : 0, t, 0.05);
  A.skid.f.frequency.setTargetAtTime(1100 + Math.random() * 900, t, 0.05);
  A.whine.frequency.setTargetAtTime(500 + sp * 40, t, 0.05);
  A.whineG.gain.setTargetAtTime(b.boosting ? 0.07 : 0, t, 0.1);
}

function splat(vol = 0.6) {
  const s = NZ.sound;
  if (!s.ctx) return;
  const ctx = s.ctx, t = s.t, n = s.noiseSrc();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(1800, t);
  f.frequency.exponentialRampToValueAtTime(200, t + 0.25);
  const g = ctx.createGain();
  s.env(g, t, 0.003, vol, 0.3);
  n.connect(f).connect(g).connect(s.master);
  n.start(t, Math.random());
  n.stop(t + 0.35);
  s.thud(vol);
}

function horn() {
  const s = NZ.sound;
  if (!s.ctx) return;
  const t = s.t;
  for (const fr of [392, 494]) {
    const o = s.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = fr;
    const g = s.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.setValueAtTime(0.09, t + 0.38);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(s.master);
    o.start(t);
    o.stop(t + 0.5);
  }
}

// ------------------------------------------------------------------ dust puffs
const PUFFS = [];
let puffNext = 0;
function buildPuffs() {
  const map = NZ.glowTexture('rgba(255,255,255,0.55)', 'rgba(255,255,255,0.18)', 64);
  for (let i = 0; i < 70; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: 0x8a7a66, transparent: true, depthWrite: false, opacity: 0 }));
    s.visible = false;
    NZ.scene.add(s);
    PUFFS.push({ s, vel: new V3(), life: 0, max: 1, size: 1 });
  }
}
function puff(pos, vel, size, life, color = 0x8a7a66) {
  const p = PUFFS[puffNext++ % PUFFS.length];
  p.s.position.copy(pos);
  p.vel.copy(vel);
  p.life = p.max = life;
  p.size = size;
  p.s.material.color.setHex(color);
  p.s.visible = true;
}
function updatePuffs(dt) {
  for (const p of PUFFS) {
    if (p.life <= 0) continue;
    p.life -= dt;
    const k = 1 - p.life / p.max;
    p.vel.multiplyScalar(Math.exp(-dt * 2.5));
    p.vel.y += dt * 0.6;
    p.s.position.addScaledVector(p.vel, dt);
    p.s.scale.setScalar(p.size * (0.5 + k * 1.6));
    p.s.material.opacity = 0.55 * (1 - k) * Math.min(1, k * 8);
    if (p.life <= 0) p.s.visible = false;
  }
}

// ------------------------------------------------------------------ HUD
let hud = null;
function buildHud() {
  const css = document.createElement('style');
  css.textContent = `
    #nzv-speedo { position: absolute; left: 50%; bottom: 58px; transform: translateX(-50%); text-align: center; display: none;
      text-shadow: 0 0 10px #000; }
    #nzv-speedo.on { display: block; }
    #nzv-speedo b { display: block; font-size: 54px; line-height: 1; font-weight: 600; letter-spacing: .02em; }
    #nzv-speedo small { font-size: 11px; letter-spacing: .3em; opacity: .7; }
    #nzv-boost { width: 150px; height: 6px; margin: 6px auto 0; background: rgba(255,255,255,.12); border-radius: 3px; overflow: hidden; }
    #nzv-boost i { display: block; height: 100%; width: 100%; background: linear-gradient(90deg, #4a8cff, #b8e0ff); box-shadow: 0 0 8px #6af; }
    #nzv-speedo.boost b { color: #b8e0ff; text-shadow: 0 0 18px #3a7cff; }
    #nzv-grab { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .15s;
      box-shadow: inset 0 0 160px 40px rgba(180,10,5,.85); }
    body.nzv-chase #crosshair { opacity: 0; }`;
  document.head.appendChild(css);
  const el = document.createElement('div');
  el.id = 'nzv-speedo';
  el.innerHTML = '<b>0</b><small>KM/H</small><div id="nzv-boost"><i></i></div>';
  NZ.$('hud').appendChild(el);
  const grab = document.createElement('div');
  grab.id = 'nzv-grab';
  NZ.$('hud').appendChild(grab);
  hud = { el, num: el.querySelector('b'), boost: el.querySelector('i'), grab, last: -1 };
}

function updateHud() {
  hud.el.classList.toggle('on', driving);
  document.body.classList.toggle('nzv-chase', driving && !buggy.seatView);
  hud.grab.style.opacity = driving ? Math.min(1, buggy.grabT / 2).toFixed(2) : 0;
  if (!driving) return;
  const kmh = Math.round(Math.abs(buggy.speed) * 3.6);
  if (kmh !== hud.last) hud.num.textContent = hud.last = kmh;
  hud.boost.style.width = (buggy.boost * 100).toFixed(0) + '%';
  hud.el.classList.toggle('boost', buggy.boosting);
}

// ------------------------------------------------------------------ placing, entering, leaving
function park(x = PARK.x, y = PARK.y, yaw = PARK.yaw) {
  const b = buggy;
  b.quat.setFromAxisAngle(UP, yaw);
  b.pos.copy(P(x, y, 0));
  b.pos.y = NZ.groundAt(b.pos.x, b.pos.z) + 0.72;
  b.vel.set(0, 0, 0);
  b.angVel.set(0, 0, 0);
  b.steer = b.throttle = 0;
  b.boost = 1;
  for (const w of b.wheels) w.len = T.rest - 0.13;
  syncModel(0);
}

function headingOf() {
  _a.set(0, 0, -1).applyQuaternion(buggy.quat);
  return Math.atan2(-_a.x, -_a.z);
}

function enter() {
  if (driving || NZ.state !== 'playing') return;
  driving = true;
  buggy.seatView = false;
  buggy.grabT = 0;
  player.control = control;
  NZ.vehicle = buggy;
  player.vel.set(0, 0, 0);
  weapon.firing = weapon.ads = false;
  camYaw = headingOf();
  lastYaw = player.yaw = camYaw;
  player.pitch = -0.12;
  orbit = 0;
  camPos.copy(NZ.camera.position);
  camLook.copy(buggy.pos);
  buildAudio();
  buggy.rpm = 0.9; // a rev on the way in
  setLamps(true, false);
  NZ.hint('W/S drive · A/D steer · Space handbrake · Shift boost · V view · R flip · H horn · E get out', 6);
}

const _cap = new NZ.Capsule(new V3(), new V3(), 0.35);
function exit(dragged = false) {
  if (!driving) return;
  const yaw = headingOf();
  // First clear spot beside the buggy: driver's side, passenger's side, behind, in front, on top.
  const spots = [[1.6, 0], [-1.6, 0], [0, 2.7], [0, -2.8], [2.6, 0], [-2.6, 0], [0, 0]];
  let at = null;
  for (const [lx, lz] of spots) {
    _a.set(lx, 0, lz).applyAxisAngle(UP, yaw).add(buggy.pos);
    const g = NZ.groundAt(_a.x, _a.z, buggy.pos.y + 1);
    _cap.start.set(_a.x, g + 0.37, _a.z);
    _cap.end.set(_a.x, g + 1.63, _a.z);
    if (!NZ.world.octree.capsuleIntersect(_cap) || !(lx || lz)) {
      at = { x: _a.x, y: -_a.z, top: !(lx || lz) };
      break;
    }
  }
  driving = false;
  player.control = null;
  NZ.vehicle = null;
  player.roll = 0;
  NZ.placePlayer(at.x, at.y, buggy.seatView ? player.yaw : yaw);
  if (at.top) player.collider.translate(_b.set(0, buggy.pos.y + 1.6 - player.collider.start.y, 0)); // boxed in: out the top
  settleT = 3;
  player.pitch = 0;
  NZ.view.visible = true;
  buggy.throttle = 0;
  buggy.boosting = false;
  setLamps(false, false);
  if (dragged) {
    NZ.message('DRAGGED OUT', false, 2);
    NZ.damagePlayer(30, 'vehicle');
    player.vel.set((Math.random() - 0.5) * 4, 3, (Math.random() - 0.5) * 4);
  }
}

// ------------------------------------------------------------------ physics
function step(dt, input) {
  const b = buggy;
  const up = _a.set(0, 1, 0).applyQuaternion(b.quat);
  const down = _b.copy(up).negate();
  const torque = _c.set(0, 0, 0);
  const nAvg = _d.set(0, 0, 0);
  let contacts = 0;
  for (const w of b.wheels) {
    const mount = _r.set(w.x, 0, w.z).applyQuaternion(b.quat).add(b.pos);
    const origin = mount.addScaledVector(up, 0.5);
    const d = probe(origin, down, 0.5 + T.travel + T.R);
    if (d === Infinity) {
      w.contact = false;
      w.len += (T.travel - w.len) * Math.min(1, dt * 12);
      continue;
    }
    w.normal.copy(_n);
    if (w.normal.dot(up) < 0) w.normal.negate();
    const len = d - 0.5 - T.R;
    w.contact = true;
    w.len = Math.max(0, len);
    const lever = _r.set(w.x, 0, w.z).applyQuaternion(b.quat);
    const vPt = new V3().crossVectors(b.angVel, lever).add(b.vel);
    const compVel = -vPt.dot(up);
    let F = T.k * (T.rest - len) + T.damp * compVel;
    if (len < 0.06) F += (0.06 - len) * 700 + Math.max(0, compVel) * 6; // bump stop
    F = Math.max(0, F);
    w.load = F;
    const f = new V3().copy(up).multiplyScalar(F);
    b.vel.addScaledVector(f, dt);
    torque.add(new V3().crossVectors(lever, f));
    nAvg.add(w.normal);
    contacts++;
  }
  b.grounded = contacts / 4;
  b.vel.y -= T.g * dt;
  b.angVel.addScaledVector(invI(torque), dt);

  const fwd = new V3(0, 0, -1).applyQuaternion(b.quat);
  if (contacts) {
    nAvg.normalize();
    fwd.addScaledVector(nAvg, -fwd.dot(nAvg)).normalize();
    const right = new V3().crossVectors(fwd, nAvg);
    const vf = b.vel.dot(fwd), vl = b.vel.dot(right), gf = b.grounded;
    const top = b.boosting ? T.boostTop : T.top;
    let acc = 0;
    if (input.throttle > 0) acc = vf < -1 ? T.brake : T.accel * (b.boosting ? 1.8 : 1) * Math.max(0, 1 - vf / top) + (vf < 6 ? 4 : 0);
    else if (input.throttle < 0) acc = vf > 1 ? -T.brake : -T.accel * 0.75 * Math.max(0, 1 + vf / T.reverse);
    else acc = -Math.sign(vf) * Math.min(Math.abs(vf) / dt, 2.5 + Math.abs(vf) * 0.04);
    if (input.handbrake) acc -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 6);
    b.vel.addScaledVector(fwd, acc * dt * gf);
    let dv = -vl * Math.min(1, (input.handbrake ? T.driftGrip : T.grip) * dt);
    const lim = T.maxLat * dt;
    dv = Math.max(-lim, Math.min(lim, dv));
    b.vel.addScaledVector(right, dv * gf);
    // Arcade steering: pull the yaw rate toward what the front wheels ask for.
    const want = (vf * Math.tan(b.steer)) / T.wheelbase * (input.handbrake ? 1.45 : 1);
    const cur = b.angVel.dot(nAvg);
    b.angVel.addScaledVector(nAvg, (want - cur) * Math.min(1, dt * 9) * gf);
    b.slip = Math.abs(vl) + (input.handbrake && Math.abs(vf) > 3 ? Math.abs(vf) * 0.35 : 0) + (input.throttle > 0 && vf < 5 && vf > -1 ? 3.5 : 0);
    b.angVel.multiplyScalar(Math.exp(-dt * 1.6));
  } else {
    // A little air control: pitch with W/S, spin with A/D.
    const right = new V3(1, 0, 0).applyQuaternion(b.quat);
    b.angVel.addScaledVector(right, -input.throttle * 2.2 * dt);
    b.angVel.addScaledVector(up, -input.steer * 2.2 * dt);
    b.angVel.multiplyScalar(Math.exp(-dt * 0.4));
    b.slip = 0;
  }
  b.speed = b.vel.dot(fwd);

  b.pos.addScaledVector(b.vel, dt);
  const w = b.angVel;
  const dq = new THREE.Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(b.quat);
  b.quat.set(b.quat.x + dq.x, b.quat.y + dq.y, b.quat.z + dq.z, b.quat.w + dq.w).normalize();
  hullCollide();
}

let lastImpact = 0;
function hullCollide() {
  const b = buggy;
  for (const [x, y, z, r] of HULL) {
    _sphere.center.set(x, y, z).applyQuaternion(b.quat).add(b.pos);
    _sphere.radius = r;
    const hit = NZ.world.octree.sphereIntersect(_sphere);
    if (!hit) continue;
    const n = hit.normal;
    b.pos.addScaledVector(n, hit.depth);
    const lever = _r.copy(_sphere.center).addScaledVector(n, -r).sub(b.pos);
    const vPt = new V3().crossVectors(b.angVel, lever).add(b.vel);
    const vn = vPt.dot(n);
    if (vn >= 0) continue;
    const rn = new V3().crossVectors(lever, n);
    const k = 1 + n.dot(new V3().crossVectors(invI(rn.clone()), lever));
    const j = (-(1 + 0.25) * vn) / k;
    b.vel.addScaledVector(n, j);
    b.angVel.addScaledVector(invI(rn), j * 0.6); // a bit less spin off walls than a true rigid body
    // Scrub some tangential speed on the wall.
    const vt = vPt.addScaledVector(n, -vn);
    b.vel.addScaledVector(vt, -0.15);
    if (-vn > 4 && NZ.clock.elapsedTime - lastImpact > 0.25) {
      lastImpact = NZ.clock.elapsedTime;
      NZ.sound.thud(Math.min(1, -vn / 14));
      NZ.sparks(_sphere.center.clone().addScaledVector(n, -r));
      b.shake = Math.min(0.5, b.shake + -vn * 0.025);
    }
  }
}

// ------------------------------------------------------------------ zombies vs buggy
function hitZombies(dt) {
  const b = buggy, t = NZ.clock.elapsedTime;
  _q.copy(b.quat).invert();
  const speed = b.vel.length();
  let near = 0;
  for (const z of NZ.zombies) {
    if (z.state === 'dead' || z.state === 'rising' || z.flung || !z.pos) continue;
    const local = _a.copy(z.pos).sub(b.pos).applyQuaternion(_q);
    const flat = Math.hypot(z.pos.x - b.pos.x, z.pos.z - b.pos.z);
    if (flat < 2.3 && Math.abs(z.pos.y - b.pos.y) < 2) near++;
    if (Math.abs(local.x) > 1.12 || Math.abs(local.z) > 1.95 || local.y < -1.9 || local.y > 0.9) continue;
    // Relative speed along the line to the zombie: brushing past at speed shouldn't splatter.
    const dir = _b.set(z.pos.x - b.pos.x, 0, z.pos.z - b.pos.z).normalize();
    const impact = Math.max(Math.abs(b.vel.dot(dir)), speed * 0.6);
    if (impact > 4.5 && (z.vHitT ?? -9) < t - 0.35) {
      z.vHitT = t;
      const dmg = impact * impact * 6;
      const point = _c.copy(z.pos).setY(z.pos.y + 1.1);
      const hpBefore = z.hp;
      NZ.damageZombie(z, dmg, false, false, point.clone());
      NZ.blood(point, 30, 4);
      splat(Math.min(1, 0.35 + impact / 25));
      b.shake = Math.min(0.5, b.shake + 0.08 + impact * 0.01);
      b.vel.multiplyScalar(0.94);
      if (z.state === 'dead' || z.hp <= 0) {
        const impulse = b.vel.clone().multiplyScalar(0.7).add(_d.set(0, 3 + impact * 0.3, 0));
        if (impact > 14) {
          const parts = ['head', 'armL', 'armR', 'legL', 'legR'];
          for (let i = 0; i < 2; i++) NZ.dismember?.(z, parts[(Math.random() * parts.length) | 0], impulse.clone().multiplyScalar(1.2));
        }
        if (!z.update) fling(z, impulse, impact);
        NZ.addPoints(50, true);
        b.combo = b.comboT > t ? b.combo + 1 : 1;
        b.comboT = t + 1.6;
        if (b.combo >= 2) NZ.message(`ROADKILL x${b.combo}`, true, 1.4);
      } else if (hpBefore > 0) {
        z.stagger = 1.2;
        shove(z, local);
      }
    } else shove(z, local);
  }
  // Stopped with zombies at the doors: they'll drag you out.
  if (speed < 2.2 && near) {
    if (b.grabT === 0) NZ.hint("They're grabbing you! Drive!", 2);
    b.grabT += dt * Math.min(3, near) * 0.8;
    if (b.grabT > 2.4) {
      b.grabT = 0;
      exit(true);
    }
  } else b.grabT = Math.max(0, b.grabT - dt * 2);
}

function shove(z, local) {
  // Push the zombie out of the hull along the shallowest axis (in body space).
  const px = 1.15 - Math.abs(local.x), pz = 1.98 - Math.abs(local.z);
  if (px < pz) local.x = Math.sign(local.x || 1) * 1.15;
  else local.z = Math.sign(local.z || 1) * 1.98;
  _d.copy(local).applyQuaternion(buggy.quat).add(buggy.pos);
  z.pos.x = _d.x;
  z.pos.z = _d.z;
}

// A zombie the buggy kills goes flying, tumbles, lands and sinks away.
function fling(z, vel, impact) {
  z.flung = { vel: vel.clone().add(_d.set((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)), spin: new V3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14).multiplyScalar(0.5 + impact / 20), landed: false };
  z.update = flingUpdate;
}
function flingUpdate(z, dt) {
  const f = z.flung;
  z.t += dt;
  if (!f.landed) {
    f.vel.y -= 20 * dt;
    _a.copy(f.vel).multiplyScalar(dt);
    _ray.origin.copy(z.pos).setY(z.pos.y + 0.6);
    const len = _a.length();
    if (len > 1e-4) {
      _ray.direction.copy(_a).normalize();
      const wall = NZ.world.octree.rayIntersect(_ray);
      if (wall && wall.distance < len + 0.3) f.vel.reflect(wall.triangle.getNormal(_b)).multiplyScalar(0.35);
    }
    z.pos.addScaledVector(f.vel, dt);
    z.root.rotation.x += f.spin.x * dt;
    z.root.rotation.y += f.spin.y * dt;
    z.root.rotation.z += f.spin.z * dt;
    const g = NZ.groundAt(z.pos.x, z.pos.z, z.pos.y + 1);
    if (z.pos.y <= g && f.vel.y < 0) {
      z.pos.y = g;
      if (Math.abs(f.vel.y) > 4) {
        NZ.dust(z.pos, 8);
        NZ.blood(z.pos, 8, 2);
        f.vel.y *= -0.3;
        f.vel.x *= 0.5;
        f.vel.z *= 0.5;
        f.spin.multiplyScalar(0.4);
      } else {
        f.landed = true;
        f.t0 = z.t;
      }
    }
  } else {
    // Settle flat on the back.
    const k = Math.min(1, dt * 6);
    z.root.rotation.x += (-Math.PI / 2 - z.root.rotation.x) * k;
    z.root.rotation.z += (0 - z.root.rotation.z) * k;
    if (z.t - f.t0 > 2.5) z.pos.y -= dt * 0.5;
    if (z.t - f.t0 > 4.5) {
      NZ.scene.remove(z.root);
      z.remove = true;
    }
  }
  z.root.position.copy(z.pos);
}

// ------------------------------------------------------------------ driving: owns movement + camera
function control(dt, t) {
  const b = buggy;
  const input = {
    throttle: (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0),
    steer: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0),
    handbrake: !!keys.Space,
  };
  b.throttle = Math.abs(input.throttle);
  const wantBoost = !!(keys.ShiftLeft || keys.ShiftRight) && input.throttle > 0 && b.boost > 0.02;
  b.boosting = wantBoost;
  b.boost = Math.max(0, Math.min(1, b.boost + (wantBoost ? -dt / 3.2 : dt / 7)));
  const maxSteer = 0.62 / (1 + Math.abs(b.speed) / 14);
  b.steer += (-input.steer * maxSteer - b.steer) * Math.min(1, dt * 7);
  const n = 3;
  for (let i = 0; i < n; i++) step(dt / n, input);
  if (b.pos.y < -80) park();
  hitZombies(dt);
  syncModel(dt);
  // Dust, gravel and boost flames.
  const sp = Math.abs(b.speed);
  for (const w of b.wheels) {
    if (!w.contact || (!w.front && sp < 2 && b.slip < 3) || (w.front && sp < 6)) continue;
    const chance = Math.min(1, sp / 25 + b.slip / 12) * dt * 18;
    if (Math.random() < chance) {
      const p = w.mesh.getWorldPosition(_a).addScaledVector(UP, -T.R + 0.1);
      puff(p, _b.copy(b.vel).multiplyScalar(-0.15).add(_c.set((Math.random() - 0.5) * 2, 0.6 + Math.random(), (Math.random() - 0.5) * 2)), 0.8 + sp * 0.04 + b.slip * 0.05, 1.2 + Math.random());
      if (b.slip > 4 || sp > 12) NZ.emit(p, 3, [0.3, 0.26, 0.2], 3, 2.5, 0.6);
    }
  }
  for (const f of b.flames) {
    f.visible = b.boosting;
    if (f.visible) {
      f.scale.setScalar(0.35 + Math.random() * 0.3);
      f.material.rotation = Math.random() * 6.28;
    }
  }
  setLamps(true, input.throttle < 0 && b.speed > 0.5 || input.handbrake);
  // Air time + landing.
  if (b.grounded === 0) b.airT += dt;
  else {
    if (b.airT > 0.35) {
      NZ.sound.thud(Math.min(1, 0.4 + b.airT * 0.5));
      b.shake = Math.min(0.6, b.shake + b.airT * 0.3);
      for (let i = 0; i < 6; i++) puff(_a.copy(b.pos).add(_b.set((Math.random() - 0.5) * 2.5, -0.6, (Math.random() - 0.5) * 3)), _c.set((Math.random() - 0.5) * 4, 1, (Math.random() - 0.5) * 4), 1.4, 1.5);
      if (b.airT > 0.9) NZ.message(`${b.airT.toFixed(1)}s AIR`, true, 1.2);
    }
    b.airT = 0;
  }
  // Upside down and stuck? Offer the flip.
  _a.set(0, 1, 0).applyQuaternion(b.quat);
  if (_a.y < 0.3 && sp < 2) {
    b.flippedT += dt;
    if (b.flippedT > 1 && b.flippedT - dt <= 1) NZ.hint('Press R to flip the buggy', 3);
  } else b.flippedT = 0;
  flipCd -= dt;
  // Keep the player (and so the zombies' flow field and pickups) with the buggy.
  const g = b.pos.y - 0.72;
  player.collider.start.set(b.pos.x, g + 0.36, b.pos.z);
  player.collider.end.set(b.pos.x, g + 1.62, b.pos.z);
  player.vel.copy(b.vel);
  player.onFloor = b.grounded > 0;
  // Weapons only from the seat, at a standstill.
  const canShoot = b.seatView && sp < 1.5;
  if (!canShoot) weapon.firing = weapon.ads = false;
  updateCamera(dt, t);
}

function syncModel(dt) {
  const b = buggy;
  b.group.position.copy(b.pos);
  b.group.quaternion.copy(b.quat);
  for (const w of b.wheels) {
    w.mesh.position.set(w.x, -w.len, w.z);
    if (w.front) w.mesh.rotation.y = b.steer;
    w.spin -= (b.speed / T.R) * dt * (b.grounded || !b.throttle ? 1 : 3);
    w.spinner.rotation.x = w.spin;
  }
  b.steeringWheel.rotation.z = -b.steer * 2.2;
  if (b.flag) b.flag.rotation.x = Math.sin(NZ.clock.elapsedTime * (6 + Math.abs(b.speed))) * 0.25;
}

function updateCamera(dt) {
  const b = buggy, cam = NZ.camera;
  // Mouse (and Q/E) moves player.yaw: treat that as an orbit offset that eases back behind the buggy.
  const dy = player.yaw - lastYaw;
  orbit += dy;
  orbitIdle = Math.abs(dy) > 1e-4 ? 0 : orbitIdle + dt;
  const heading = headingOf();
  b.shake *= Math.exp(-dt * 6);
  const sh = b.shake;
  if (b.seatView) {
    orbit = Math.max(-2.2, Math.min(2.2, orbit));
    cam.position.copy(SEAT).applyQuaternion(b.quat).add(b.pos);
    _q.setFromEuler(new THREE.Euler(player.pitch, orbit, 0, 'YXZ'));
    cam.quaternion.copy(b.quat).multiply(_q);
    cam.position.x += (Math.random() - 0.5) * sh * 0.1;
    cam.position.y += (Math.random() - 0.5) * sh * 0.1;
    player.yaw = lastYaw = heading + orbit;
    return;
  }
  if (orbitIdle > 1.2) orbit *= Math.exp(-dt * 2.5);
  let dh = heading - camYaw;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  camYaw += dh * Math.min(1, dt * (b.grounded ? 4.5 : 1.5));
  const yaw = camYaw + orbit;
  const sp = Math.abs(b.speed);
  const dist = 6 + sp * 0.06, height = 1.95 + sp * 0.015 - player.pitch * 3;
  const look = _a.copy(b.pos).setY(b.pos.y + 1.0);
  const want = _b.set(look.x + Math.sin(yaw) * dist, look.y + Math.max(0.4, height) - 0.9, look.z + Math.cos(yaw) * dist);
  // Don't put the camera inside a wall.
  _ray.origin.copy(look);
  _ray.direction.copy(want).sub(look);
  const full = _ray.direction.length();
  _ray.direction.normalize();
  const hit = NZ.world.octree.rayIntersect(_ray);
  if (hit && hit.distance < full) want.copy(look).addScaledVector(_ray.direction, Math.max(1.2, hit.distance - 0.35));
  camPos.addScaledVector(b.vel, dt); // feed-forward so the camera doesn't trail at speed
  camPos.lerp(want, Math.min(1, dt * 7));
  if (camPos.distanceTo(want) > 12) camPos.copy(want);
  // Rays miss back faces, so also push the camera out of any beam or eave it ended up inside.
  _sphere.center.copy(camPos);
  _sphere.radius = 0.3;
  const inside = NZ.world.octree.sphereIntersect(_sphere);
  if (inside) camPos.addScaledVector(inside.normal, inside.depth);
  _c.set(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(5).add(look);
  camLook.lerp(_c, Math.min(1, dt * 10));
  cam.position.copy(camPos);
  cam.position.x += (Math.random() - 0.5) * sh * 0.3;
  cam.position.y += (Math.random() - 0.5) * sh * 0.3;
  cam.lookAt(camLook);
  player.yaw = lastYaw = yaw;
}

// ------------------------------------------------------------------ hooks
hooks.ready.push(() => {
  buildBuggy();
  buildPuffs();
  buildHud();
  openGarage();
  park();
  setLamps(false, false);
});

hooks.reset.push(() => {
  if (driving) exit();
  settleT = 0;
  park();
  setLamps(false, false);
});

hooks.key.push((code) => {
  if (code === 'KeyE') {
    if (driving) {
      if (Math.abs(buggy.speed) < 6) exit();
      else NZ.hint('Slow down to get out', 1.5);
    } else if (player.collider.start.distanceTo(buggy.pos) < 3.2) enter();
  }
  if (!driving) return;
  if (code === 'KeyH') horn();
});

// V (view), R (flip) and F would knife/reload in the base game: take them first while driving.
window.addEventListener('keydown', (e) => {
  if (!driving || NZ.state !== 'playing' || e.repeat) return;
  if (e.code === 'KeyV') {
    buggy.seatView = !buggy.seatView;
    orbit = 0;
    player.pitch = buggy.seatView ? 0 : -0.12;
  } else if (e.code === 'KeyR') {
    if (flipCd > 0) return e.stopImmediatePropagation();
    flipCd = 1;
    const yaw = headingOf();
    buggy.quat.setFromAxisAngle(UP, yaw);
    buggy.pos.y += 1.2;
    buggy.vel.set(0, 2, 0);
    buggy.angVel.set(0, 0, 0);
    NZ.sound.thud(0.4);
  } else if (e.code !== 'KeyF') return;
  e.stopImmediatePropagation();
}, true);

hooks.update.push((dt) => {
  updatePuffs(dt);
  updateAudio(dt);
  updateHud();
  if (driving) {
    // updateWeapon has run: hide the gun outside the seat view, and widen the lens with speed.
    if (!buggy.seatView) NZ.view.visible = false;
    else NZ.view.visible = Math.abs(buggy.speed) < 1.5;
    const k = Math.min(1, Math.abs(buggy.speed) / 30);
    NZ.camera.fov = 74 + k * 10 + (buggy.boosting ? 6 : 0);
    NZ.camera.updateProjectionMatrix();
    return;
  }
  // Let it come to rest after you hop out, then freeze it.
  if (settleT > 0) {
    settleT -= dt;
    for (let i = 0; i < 3; i++) step(dt / 3, { throttle: 0, steer: 0, handbrake: true });
    syncModel(dt);
  }
  // Prompt when close.
  nearHintT -= dt;
  if (nearHintT <= 0 && player.collider.start.distanceTo(buggy.pos) < 3.2) {
    NZ.hint('Press E to drive the buggy', 2);
    nearHintT = 2;
  }
});

hooks.frame.push((dt, t, state) => {
  if (state !== 'playing' && A) A.out.gain.setTargetAtTime(0, A.ctx.currentTime, 0.1);
});

window.__game_vehicles = Object.defineProperties(window.__game_vehicles || {}, Object.getOwnPropertyDescriptors({
  enterBuggy() {
    if (driving) return;
    player.collider.start.copy(buggy.pos);
    enter();
  },
  exitBuggy: () => exit(),
  park: (x, y, yaw) => park(x, y, yaw),
  get driving() { return driving; },
  get buggy() {
    const b = buggy;
    return { x: +b.pos.x.toFixed(2), y: +(-b.pos.z).toFixed(2), h: +b.pos.y.toFixed(2), speed: +b.speed.toFixed(2), grounded: b.grounded, air: +b.airT.toFixed(2), up: +_a.set(0, 1, 0).applyQuaternion(b.quat).y.toFixed(2), heading: +headingOf().toFixed(2), grab: +b.grabT.toFixed(2), seat: b.seatView };
  },
  set seatView(v) { buggy.seatView = v; },
}));
