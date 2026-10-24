// Zombie sheep: packs of fast, erratic, headbutting undead sheep out of the tussock from
// round 2, and every 5th round is a SHEEP ROUND (only sheep, faster, Max Ammo at the end).
// Each sheep lives in NZ.zombies with its own brain (z.update) so hit testing, kills,
// points and round accounting all go through the normal game paths.
import { baa, hoofs, headbutt } from './enemies-audio.js';

const NZ = window.NZ;
const { THREE, V3 } = NZ;

// ------------------------------------------------------------------ geometry + materials (shared)
const G = {}, M = {};
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function lumpy(blobs, seed) {
  // Wool: overlapping icosahedra, each vertex pushed by a position hash so seams stay closed.
  const r = NZ.rng(seed), geos = [];
  for (const [x, y, z, rad] of blobs) {
    const g = new THREE.IcosahedronGeometry(rad * (0.9 + r() * 0.2), 1);
    g.translate(x, y, z);
    geos.push(g);
  }
  const g = NZ.mergeGeometries(geos);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (hash3(x * 9, y * 9, z * 9) - 0.5) * 0.12;
    p.setXYZ(i, x * k, (y - 0.62) * k + 0.62, z * k);
    // Dirty grey-white, browner underneath, with the odd blood clot.
    const dirt = hash3(Math.round(x * 6), Math.round(y * 6), Math.round(z * 6));
    const under = Math.max(0, 0.6 - y) * 0.9;
    let cr = 0.78 - dirt * 0.22 - under, cg = 0.75 - dirt * 0.22 - under * 1.05, cb = 0.68 - dirt * 0.24 - under * 1.2;
    if (dirt > 0.93) { cr = 0.42; cg = 0.03; cb = 0.03; }
    col.set([cr, cg, cb], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function build() {
  const fleece = (seed) => {
    // A core plus a coat of small curls scattered over an egg-shaped body.
    const r = NZ.rng(seed), out = [[0, 0.66, -0.2, 0.22], [0, 0.68, 0.05, 0.24], [0, 0.68, 0.28, 0.2]];
    for (let i = 0; i < 26; i++) {
      const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const x = s * Math.cos(a), y = u, z = s * Math.sin(a);
      if (y < -0.45) continue;
      out.push([x * 0.25, 0.68 + y * 0.2, z * 0.42, 0.08 + r() * 0.06]);
    }
    return out;
  };
  G.body = [lumpy(fleece(3), 3), lumpy(fleece(9), 9)];
  G.tuft = lumpy([[0, 0.62, 0, 0.09], [0.05, 0.6, -0.03, 0.07], [-0.05, 0.6, -0.03, 0.07]], 5).translate(0, -0.62, 0);
  // Long black face: a stretched icosahedron, nose forward (+z).
  G.face = new THREE.IcosahedronGeometry(0.12, 1).scale(0.85, 0.95, 1.7).translate(0, -0.03, 0.12);
  G.ear = new THREE.BoxGeometry(0.16, 0.035, 0.07).translate(0.08, 0, 0);
  G.horn = new THREE.TorusGeometry(0.06, 0.018, 5, 10, Math.PI * 1.4);
  G.eye = new THREE.SphereGeometry(0.024, 8, 6);
  G.leg = new THREE.CylinderGeometry(0.045, 0.034, 0.44, 6).translate(0, -0.22, 0);
  G.hoof = new THREE.CylinderGeometry(0.04, 0.046, 0.06, 6).translate(0, -0.44, 0);
  G.legs = NZ.mergeGeometries([G.leg, G.hoof]);
  M.wool = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, emissive: 0x16140f, flatShading: true });
  M.face = new THREE.MeshStandardMaterial({ color: 0x141113, roughness: 0.7, emissive: 0x050304 });
  M.horn = new THREE.MeshStandardMaterial({ color: 0x3b3128, roughness: 0.6 });
  M.eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.35, 0.15) });
  M.glow = new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,70,40,1)', 'rgba(255,0,0,0.25)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: 0xff3020 });
}

function makeSheep() {
  if (!G.body) build();
  const root = new THREE.Group();
  const bodyG = new THREE.Group();
  root.add(bodyG);
  const body = new THREE.Mesh(G.body[(Math.random() * 2) | 0], M.wool);
  bodyG.add(body);
  const neck = new THREE.Group();
  neck.position.set(0, 0.8, 0.5);
  bodyG.add(neck);
  const head = new THREE.Mesh(G.face, M.face);
  head.rotation.x = 0.5;
  neck.add(head);
  const tuft = new THREE.Mesh(G.tuft, M.wool);
  tuft.position.set(0, 0.08, 0.02);
  head.add(tuft);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(G.ear, M.face);
    ear.position.set(s * 0.07, 0.04, 0.0);
    ear.rotation.set(0, s < 0 ? Math.PI : 0, -0.35);
    head.add(ear);
    const horn = new THREE.Mesh(G.horn, M.horn);
    horn.position.set(s * 0.08, 0.07, 0.0);
    horn.rotation.set(0, s * 1.4, 0.4 * s);
    head.add(horn);
    const eye = new THREE.Mesh(G.eye, M.eye);
    eye.position.set(s * 0.085, 0.015, 0.1);
    head.add(eye);
    const glow = new THREE.Sprite(M.glow);
    glow.scale.setScalar(0.22);
    glow.position.copy(eye.position);
    head.add(glow);
  }
  const legs = [];
  for (const [x, z] of [[-0.15, 0.26], [0.15, 0.26], [-0.15, -0.3], [0.15, -0.3]]) {
    const g = new THREE.Group();
    g.position.set(x, 0.46, z);
    const m = new THREE.Mesh(G.legs, M.face);
    g.add(m);
    root.add(g);
    legs.push(g);
  }
  const parts = [body, head, legs[0].children[0], legs[1].children[0], legs[2].children[0], legs[3].children[0]];
  for (const m of parts) {
    m.castShadow = true;
    m.userData.head = m === head;
  }
  // Humanoid-shaped aliases so other modules' generic code (gore, fire…) finds something.
  return {
    kind: 'sheep', root, body: bodyG, hips: bodyG, spine: bodyG, neck, head, legs,
    armL: legs[0], armR: legs[1], legL: legs[2], legR: legs[3], parts,
  };
}

// ------------------------------------------------------------------ spawning
let candidates = [];
const sheep = { packs: [], round: false, toSpawn: 0, spawnT: 0, lastDeath: new V3(), hadDeath: false };

function prepare() {
  const { walk, indoor } = window.__game.grid;
  candidates = NZ.META.tussock
    .map(([x, y, z]) => ({ x, y, z, c: NZ.cellOf(x, -y) }))
    .filter((p) => p.c >= 0 && walk[p.c] && !indoor[p.c] && (p.x < -2 || p.x > 64 || p.y < -6 || p.y > 38));
}

function pickSpawn(min = 12, max = 34) {
  const px = NZ.camera.position.x, py = -NZ.camera.position.z, flow = NZ.flow;
  let c = null;
  for (let tries = 0; tries < 40; tries++) {
    c = candidates[(Math.random() * candidates.length) | 0];
    const d = Math.hypot(c.x - px, c.y - py);
    if (d > min && d < max && flow[c.c] >= 0) return c;
  }
  return c;
}

function healthFor(r) {
  const h = r < 10 ? 150 + 100 * (r - 1) : Math.round(950 * Math.pow(1.1, r - 9));
  return Math.max(60, Math.round(h * 0.3));
}

const _sp = new V3();
function spawnSheep(at, opts = {}) {
  const z = makeSheep();
  const n = Math.max(1, NZ.ROUND.n);
  const fast = sheep.round || opts.fast;
  Object.assign(z, {
    pos: new V3(at.x, at.y, at.z),
    hp: healthFor(n),
    speed: (4.6 + Math.random() * 1.0 + Math.min(1, n * 0.08)) * (fast ? 1.22 : 1),
    state: 'walk', t: 0, phase: Math.random() * 6, heading: 0, jitter: 0, jitterT: 0, hopY: 0, hopV: 3 + Math.random() * 2,
    buttT: 0, buttCd: 0.6, stuckT: 0, lastPos: new V3(at.x, at.y, at.z), baaT: 0.5 + Math.random() * 3, flinch: 0,
    vel: new V3(), spin: new V3(), stepT: 0, sprinter: true, update: updateSheep,
  });
  const s = 0.95 + Math.random() * 0.2;
  z.root.scale.setScalar(s);
  const pp = NZ.player.collider.start;
  z.heading = Math.atan2(pp.x - z.pos.x, pp.z - z.pos.z);
  z.root.position.copy(z.pos);
  z.root.rotation.y = z.heading;
  for (const m of z.parts) m.userData.z = z;
  for (const f of NZ.hooks.zombieSpawn) f(z);
  NZ.scene.add(z.root);
  NZ.zombies.push(z);
  NZ.refreshHitMeshes();
  NZ.dust(z.pos, 10);
  return z;
}

function spawnPack(size) {
  if (!candidates.length) return [];
  const c = pickSpawn();
  const { walk } = window.__game.grid;
  const out = [];
  for (let i = 0; i < size; i++) {
    let x = c.x, y = c.y, z = c.z;
    for (let k = 0; k < 8; k++) {
      const a = Math.random() * 6.28, r = 0.8 + Math.random() * 2.2;
      const cx = c.x + Math.cos(a) * r, cy = c.y + Math.sin(a) * r, cell = NZ.cellOf(cx, -cy);
      if (cell >= 0 && walk[cell]) {
        x = cx;
        y = cy;
        z = window.__game.grid.heights[cell];
        break;
      }
    }
    out.push(spawnSheep(_sp.set(x, z, -y)));
  }
  // A ragged chorus as they burst out of the tussock.
  out.forEach((s, i) => setTimeout(() => baa(s.pos, 0.85 + Math.random() * 0.4), 80 + i * 170));
  return out;
}

// ------------------------------------------------------------------ brain
const _to = new V3(), _push = new V3();
const cellX = (i) => NZ.grid.x0 + ((i % NZ.grid.nx) + 0.5) * NZ.grid.cs;
const cellZ = (i) => -(NZ.grid.y0 + (Math.floor(i / NZ.grid.nx) + 0.5) * NZ.grid.cs);

function groundY(x, z) {
  const c = NZ.cellOf(x, z), g = window.__game.grid;
  return c >= 0 && g.walk[c] ? g.heights[c] : NZ.terrainHeight(x, z);
}

function updateSheep(z, dt, t) {
  z.t += dt;
  if (z.state === 'dead') return deadSheep(z, dt);
  const pp = NZ.player.collider.start, walk = NZ.walk, flow = NZ.flow;
  const dx = pp.x - z.pos.x, dz = pp.z - z.pos.z, dist = Math.hypot(dx, dz);
  const sameFloor = Math.abs(pp.y - 0.36 - z.pos.y) < 1.4;
  // Steering: flow field toward the player, with jumpy direction changes when far.
  let tx = pp.x, tz = pp.z;
  const c = NZ.nearestWalkable(NZ.cellOf(z.pos.x, z.pos.z));
  if (c >= 0 && flow[c] > 2) {
    const n = NZ.nextStep(c);
    tx = cellX(n);
    tz = cellZ(n);
  }
  z.jitterT -= dt;
  if (z.jitterT <= 0) {
    z.jitterT = 0.35 + Math.random() * 0.6;
    const wild = dist > 5 ? 1 : 0.25;
    z.jitter = (Math.random() - 0.5) * 1.5 * wild;
    if (z.hopY <= 0 && Math.random() < 0.45) z.hopV = 2.2 + Math.random() * 1.6; // a skittish hop on the turn
  }
  const want = Math.atan2(tx - z.pos.x, tz - z.pos.z) + z.jitter;
  let dh = want - z.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  z.heading += dh * Math.min(1, dt * 9);
  z.buttCd -= dt;
  z.flinch = Math.max(0, z.flinch - dt);
  let speed = z.speed * (z.flinch > 0 ? 0.3 : 1);
  // Headbutt: rear up, then lunge.
  if (z.buttT > 0) {
    z.buttT += dt;
    z.heading += Math.atan2(Math.sin(Math.atan2(dx, dz) - z.heading), Math.cos(Math.atan2(dx, dz) - z.heading)) * Math.min(1, dt * 12);
    speed = z.buttT < 0.28 ? -0.8 : z.buttT < 0.45 ? 9 : 0.5;
    if (z.buttT >= 0.36 && !z.butted) {
      z.butted = true;
      if (dist < 1.25 && sameFloor && !NZ.god) {
        NZ.damagePlayer(sheep.round ? 18 : 14, 'sheep');
        headbutt();
        const k = 6 / Math.max(0.3, dist);
        NZ.player.vel.x += dx * k;
        NZ.player.vel.z += dz * k;
        NZ.player.vel.y += 2.5;
        NZ.player.pitch -= 0.04;
        NZ.player.yaw += (Math.random() - 0.5) * 0.08;
      }
    }
    if (z.buttT > 0.75) {
      z.buttT = 0;
      z.butted = false;
      z.buttCd = 0.9 + Math.random() * 0.6;
    }
  } else if (dist < 1.6 && sameFloor && z.buttCd <= 0) {
    z.buttT = 0.0001;
    baa(z.pos, 1.1, true);
  }
  if (dist < 0.75 && z.buttT <= 0) speed = 0;
  // Move with the same wall-sliding rule as the zombies.
  const sp = speed * dt, nx = z.pos.x + Math.sin(z.heading) * sp, nz = z.pos.z + Math.cos(z.heading) * sp;
  const cur = NZ.cellOf(z.pos.x, z.pos.z), nxt = NZ.cellOf(nx, nz);
  if (nxt < 0 || walk[nxt] || cur < 0 || !walk[cur]) {
    z.pos.x = nx;
    z.pos.z = nz;
  } else {
    const ax = NZ.cellOf(nx, z.pos.z), az = NZ.cellOf(z.pos.x, nz);
    if (ax >= 0 && walk[ax]) z.pos.x = nx;
    else if (az >= 0 && walk[az]) z.pos.z = nz;
  }
  // Separation.
  for (const o of NZ.zombies) {
    if (o === z || o.state === 'dead' || o.state === 'rising') continue;
    const ox = z.pos.x - o.pos.x, oz = z.pos.z - o.pos.z, d2 = ox * ox + oz * oz;
    if (d2 < 0.3 && d2 > 1e-6) {
      const d = Math.sqrt(d2), push = ((0.55 - d) / d) * 0.5, cx = z.pos.x + ox * push, cz = z.pos.z + oz * push, nc = NZ.cellOf(cx, cz);
      if (nc < 0 || walk[nc]) {
        z.pos.x = cx;
        z.pos.z = cz;
      }
    }
  }
  const gy = groundY(z.pos.x, z.pos.z);
  z.pos.y += (gy - z.pos.y) * Math.min(1, dt * 12);
  // Hop.
  if (z.hopV > 0 || z.hopY > 0) {
    z.hopY += z.hopV * dt;
    z.hopV -= 16 * dt;
    if (z.hopY <= 0) {
      z.hopY = 0;
      z.hopV = 0;
      NZ.dust(z.pos, 3);
    }
  }
  // Stuck behind something? Pop back out of the tussock elsewhere.
  z.stuckT += dt;
  if (z.stuckT > 4) {
    if (z.lastPos.distanceTo(z.pos) < 0.6 && dist > 2) {
      const s = pickSpawn(15, 40);
      if (s) z.pos.set(s.x, s.z, -s.y);
      z.hopV = 4;
    }
    z.lastPos.copy(z.pos);
    z.stuckT = 0;
  }
  // Trot: diagonal leg pairs, body bob and roll, head bob; charge with the head down.
  const moving = Math.abs(speed) > 0.1;
  z.phase += dt * (moving ? 3.2 + Math.abs(speed) * 2.2 : 2);
  const s = Math.sin(z.phase), amp = moving ? 0.75 : 0.06, air = z.hopY > 0.02;
  z.legs[0].rotation.x = z.legs[3].rotation.x = air ? -0.6 : s * amp;
  z.legs[1].rotation.x = z.legs[2].rotation.x = air ? 0.6 : -s * amp;
  z.body.position.y = z.hopY + Math.abs(Math.cos(z.phase)) * (moving ? 0.07 : 0.01);
  z.body.rotation.z = Math.sin(z.phase) * 0.06;
  z.body.rotation.x = air ? -z.hopV * 0.05 : 0;
  const rear = z.buttT > 0 && z.buttT < 0.28 ? -0.9 * Math.sin((z.buttT / 0.28) * Math.PI * 0.5) : 0;
  const lunge = z.buttT >= 0.28 ? 0.6 : 0;
  z.neck.rotation.x = (dist < 6 ? 0.35 : 0.1) + Math.sin(z.phase * 2) * 0.12 + rear + lunge;
  z.neck.rotation.y = Math.sin(t * 7 + z.phase) * (z.flinch > 0 ? 0.5 : 0.08);
  z.root.position.copy(z.pos);
  z.root.rotation.y = z.heading;
  if (moving && z.hopY <= 0) {
    z.stepT -= dt;
    if (z.stepT <= 0) {
      z.stepT = 0.16;
      if (dist < 12) hoofs(z.pos);
    }
  }
  z.baaT -= dt;
  if (z.baaT <= 0) {
    z.baaT = 1.5 + Math.random() * 4;
    if (dist < 35) baa(z.pos, 0.8 + Math.random() * 0.45);
  }
}

function deadSheep(z, dt) {
  if (!z.tumbling) {
    // Death tumble: thrown away from the player, rolling end over end.
    z.tumbling = true;
    const pp = NZ.player.collider.start;
    _to.set(z.pos.x - pp.x, 0, z.pos.z - pp.z).normalize();
    z.vel.set(_to.x * (2.5 + Math.random() * 2), 3.2 + Math.random() * 1.5, _to.z * (2.5 + Math.random() * 2));
    z.spin.set((Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 5), 0, (Math.random() - 0.5) * 8);
    z.hopY = Math.max(z.hopY, 0.05);
    sheep.lastDeath.copy(z.pos);
    sheep.hadDeath = true;
    baa(z.pos, 0.6, true);
  }
  if (z.t < 2.6) {
    z.pos.x += z.vel.x * dt;
    z.pos.z += z.vel.z * dt;
    z.hopY += z.vel.y * dt;
    z.vel.y -= 16 * dt;
    if (z.hopY <= 0) {
      z.hopY = 0;
      if (z.vel.y < -2) {
        z.vel.y *= -0.35;
        z.vel.x *= 0.5;
        z.vel.z *= 0.5;
        z.spin.multiplyScalar(0.45);
        NZ.dust(z.pos, 6);
      } else {
        z.vel.set(0, 0, 0);
        z.spin.multiplyScalar(Math.max(0, 1 - dt * 6));
      }
    }
    z.root.rotation.x += z.spin.x * dt;
    z.root.rotation.z += z.spin.z * dt;
    // Settle on its side once the tumble is spent.
    if (z.spin.lengthSq() < 0.5) {
      z.root.rotation.x += (Math.round(z.root.rotation.x / Math.PI) * Math.PI - z.root.rotation.x) * Math.min(1, dt * 5);
      z.root.rotation.z += (Math.PI / 2 * Math.sign(z.root.rotation.z || 1) - z.root.rotation.z) * Math.min(1, dt * 5);
    }
    z.legs.forEach((l, i) => (l.rotation.x = Math.sin(z.t * 30 + i) * Math.max(0, 1.2 - z.t) * 0.8));
  }
  z.root.position.set(z.pos.x, z.pos.y + z.hopY + 0.25 * Math.min(1, z.t * 4) - (z.t > 2.8 ? (z.t - 2.8) * 0.6 : 0), z.pos.z);
  if (z.t > 4) {
    NZ.scene.remove(z.root);
    z.remove = true;
  }
}

// ------------------------------------------------------------------ callout
const style = document.createElement('style');
style.textContent = `
#sheep-callout { position: absolute; left: 0; right: 0; top: 33%; text-align: center; pointer-events: none; opacity: 0;
  font-family: "Creepster", "Oswald", serif; color: #f1ece2; font-size: 112px; letter-spacing: .06em; line-height: 1;
  text-shadow: 0 0 6px #000, 0 0 30px #ff2a12, 0 6px 0 #5a0503; transform: scale(.6); transition: opacity .25s, transform .25s; }
#sheep-callout small { display: block; font: 600 18px "Oswald", sans-serif; letter-spacing: .5em; color: #ff5a3c; text-shadow: 0 0 10px #000; margin-top: 10px; }
#sheep-callout.show { opacity: 1; transform: scale(1); animation: sheepshake .12s steps(2) 14; }
@keyframes sheepshake { 0% { translate: -4px 2px; } 50% { translate: 4px -3px; } 100% { translate: 0 0; } }`;
document.head.appendChild(style);
const callout = document.createElement('div');
callout.id = 'sheep-callout';
callout.innerHTML = 'SHEEP ROUND<small>the flock has turned</small>';
NZ.$('hud').appendChild(callout);
let calloutTimer = 0;
function showCallout() {
  callout.classList.remove('show');
  void callout.offsetWidth;
  callout.classList.add('show');
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => callout.classList.remove('show'), 3800);
  for (let i = 0; i < 5; i++) setTimeout(() => baa(null, 0.55 + i * 0.12, i % 2 === 1), i * 260);
}

// ------------------------------------------------------------------ round wiring
const isSheepRound = (n) => n > 0 && n % 5 === 0;

NZ.hooks.ready.push(prepare);
NZ.hooks.reset.push(() => {
  sheep.packs.length = 0;
  sheep.round = false;
  sheep.toSpawn = 0;
  sheep.hadDeath = false;
});

NZ.hooks.round.push((n) => {
  sheep.packs.length = 0;
  sheep.round = isSheepRound(n);
  if (sheep.round) {
    sheep.toSpawn = 10 + n * 2;
    NZ.ROUND.toSpawn = sheep.toSpawn; // the round now waits on our sheep, not zombies
    sheep.spawnT = 2.2;
    sheep.hadDeath = false;
    showCallout();
    return;
  }
  if (n < 2) return;
  const packs = 1 + Math.floor((n - 2) / 3);
  for (let i = 0; i < packs; i++) sheep.packs.push({ t: 4 + Math.random() * 14 + i * 6, size: Math.min(6, 3 + ((Math.random() * (2 + n / 4)) | 0)) });
});

NZ.hooks.update.push((dt) => {
  if (!NZ.ROUND.active) return;
  if (sheep.round) {
    NZ.ROUND.spawnT = 1e9; // keep the zombie spawner idle
    sheep.spawnT -= dt;
    const alive = NZ.zombies.reduce((a, z) => a + (z.kind === 'sheep' && z.state !== 'dead' ? 1 : 0), 0);
    if (sheep.toSpawn > 0 && sheep.spawnT <= 0 && alive < 16) {
      const size = Math.min(sheep.toSpawn, 3 + ((Math.random() * 4) | 0));
      spawnPack(size);
      sheep.toSpawn -= size;
      NZ.ROUND.toSpawn = sheep.toSpawn;
      sheep.spawnT = 2.5 + Math.random() * 1.5;
    }
    return;
  }
  for (let i = sheep.packs.length - 1; i >= 0; i--) {
    const p = sheep.packs[i];
    p.t -= dt;
    if (p.t <= 0) {
      spawnPack(p.size);
      sheep.packs.splice(i, 1);
    }
  }
});

NZ.hooks.roundEnd.push(() => {
  sheep.packs.length = 0;
  if (!sheep.round) return;
  sheep.round = false;
  // Max Ammo where the last sheep fell (or just ahead of the player).
  const at = sheep.hadDeath ? sheep.lastDeath : _to.copy(NZ.player.collider.start).setY(NZ.player.collider.start.y - 0.36);
  NZ.spawnDrop(at, 'ammo');
});

NZ.hooks.zombieDamage.push((z, dmg, head, knife, point) => {
  if (z.kind !== 'sheep' || !point) return;
  NZ.emit(point, head ? 6 : 12, [0.85, 0.82, 0.76], 2.4, 1.8, 0.9);
  z.flinch = 0.18;
});

NZ.hooks.kill.push((z) => {
  if (z.kind !== 'sheep') return;
  NZ.emit(_push.copy(z.pos).setY(z.pos.y + 0.7), 30, [0.85, 0.82, 0.76], 3.2, 2.6, 1.2);
  if (Math.random() < 0.5) NZ.addPart?.('wool');
});

window.__game_enemies = Object.defineProperties(window.__game_enemies || {}, Object.getOwnPropertyDescriptors({
  spawnSheep(n = 4) { return spawnPack(n).length; },
  spawnSheepAt(x, y, n = 1) {
    const c = NZ.cellOf(x, -y), h = c >= 0 ? window.__game.grid.heights[c] : 0;
    for (let i = 0; i < n; i++) spawnSheep(_sp.set(x + (Math.random() - 0.5) * 1.5, h, -(y + (Math.random() - 0.5) * 1.5)));
  },
  // Jump straight to round n (starts on the next frame).
  forceRound(n) { Object.assign(NZ.ROUND, { n: n - 1, active: false, between: 0, toSpawn: 0 }); },
  sheepRound(n = 5) { window.__game_enemies.forceRound(n); },
  get sheep() { return NZ.zombies.filter((z) => z.kind === 'sheep' && z.state !== 'dead').map((z) => ({ x: +z.pos.x.toFixed(1), y: +(-z.pos.z).toFixed(1), hp: z.hp })); },
  get sheepState() { return { round: sheep.round, toSpawn: sheep.toSpawn, packs: sheep.packs.length }; },
}));
