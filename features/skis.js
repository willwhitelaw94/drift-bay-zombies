// Skis power-up: a rare zombie drop, plus a pair leaning by the front entry that comes back every few
// rounds. 30 s of fast, slidey, carving momentum that builds downhill, big floaty jumps, snow spray,
// a whoosh, ski tips in view and a countdown ring. Drives updatePlayer through player.speedMul /
// friction / jumpMul / gravityMul and the camera through player.roll.
const NZ = window.NZ;
const { THREE, V3, P, hooks, player, keys } = NZ;

const DURATION = 30, WARN = 5, DROP_CHANCE = 0.015, RACK = { x: 29.5, y: 9.6 }, RACK_EVERY = 3;
const MODS = { speedMul: 0.68, friction: 1.15, jumpMul: 1.45, gravityMul: 0.72 };

let until = 0, active = false, rackTakenRound = -1, roll = 0, carve = 0;
const pickups = [];
const _a = new V3(), _b = new V3(), _ray = new THREE.Ray(new V3(), new V3(0, -1, 0));

// ------------------------------------------------------------------ meshes
const M = {
  ski: new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.35, metalness: 0.1 }),
  stripe: new THREE.MeshStandardMaterial({ color: 0xd8261a, roughness: 0.4 }),
  binding: new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.5, metalness: 0.5 }),
  pole: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.9 }),
};

// One ski along -z: flat body, red stripe, binding, and a curled tip.
function skiMesh(len = 1.7) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, len), M.ski);
  g.add(body);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, len * 0.92), M.stripe);
  g.add(stripe);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.2), M.ski);
  tip.position.set(0, 0.045, -len / 2 - 0.08);
  tip.rotation.x = 0.55;
  g.add(tip);
  const tipStripe = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.2), M.stripe);
  tipStripe.position.copy(tip.position).y += 0.002;
  tipStripe.rotation.x = 0.55;
  g.add(tipStripe);
  const binding = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.3), M.binding);
  binding.position.set(0, 0.04, 0.05);
  g.add(binding);
  for (const m of g.children) m.castShadow = true;
  return g;
}

const glowMat = new THREE.SpriteMaterial({
  map: NZ.glowTexture('rgba(220,240,255,0.95)', 'rgba(90,170,255,0.3)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});

function pickupMesh(rack) {
  const g = new THREE.Group(), pair = new THREE.Group();
  g.add(pair);
  for (const s of [-1, 1]) {
    const ski = skiMesh(rack ? 1.7 : 1.1);
    ski.position.x = s * 0.07;
    ski.rotation.z = s * 0.04;
    pair.add(ski);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, rack ? 1.2 : 0.8, 6), M.pole);
    pole.position.set(s * 0.22, 0, 0.1);
    pole.rotation.x = Math.PI / 2;
    pole.rotation.y = s * 0.25;
    pair.add(pole);
  }
  if (rack) {
    // Leaning tips-up against the front wall.
    pair.rotation.x = -Math.PI / 2 + 0.22;
    pair.position.y = 0.85;
  } else {
    pair.rotation.x = -0.6;
    pair.position.y = 0.2;
  }
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(rack ? 2.2 : 1.9);
  glow.position.y = rack ? 0.9 : 0.25;
  g.add(glow);
  g.userData = { pair, glow };
  return g;
}

function addPickup(x, z, rack) {
  const mesh = pickupMesh(rack);
  mesh.position.set(x, NZ.groundAt(x, z), z);
  if (!rack) mesh.position.y += 0.6;
  NZ.scene.add(mesh);
  pickups.push({ mesh, rack, t: 0 });
}

function clearPickups(rackToo) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    if (pickups[i].rack && !rackToo) continue;
    NZ.scene.remove(pickups[i].mesh);
    pickups.splice(i, 1);
  }
}

function placeRack() {
  if (pickups.some((p) => p.rack)) return;
  const at = P(RACK.x, RACK.y);
  addPickup(at.x, at.z, true);
}

// Ski tips in the first-person view (weapon scene).
const tips = new THREE.Group();
for (const s of [-1, 1]) {
  const ski = skiMesh(1.25);
  ski.position.set(s * 0.17, 0, -1.15);
  ski.scale.set(0.8, 1, 1);
  ski.userData.side = s;
  tips.add(ski);
}
tips.position.set(0, -0.72, 0);
tips.rotation.x = 0.06;
tips.visible = false;

// ------------------------------------------------------------------ snow spray
const SNOW = [];
let snowNext = 0;
function buildSnow() {
  const map = NZ.glowTexture('rgba(255,255,255,0.8)', 'rgba(230,240,255,0.25)', 64);
  for (let i = 0; i < 50; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: 0xeef4ff, transparent: true, depthWrite: false, opacity: 0 }));
    s.visible = false;
    NZ.scene.add(s);
    SNOW.push({ s, vel: new V3(), life: 0, max: 1, size: 1 });
  }
}
function spray(pos, vel, size, life) {
  const p = SNOW[snowNext++ % SNOW.length];
  p.s.position.copy(pos);
  p.vel.copy(vel);
  p.life = p.max = life;
  p.size = size;
  p.s.visible = true;
}
function updateSnow(dt) {
  for (const p of SNOW) {
    if (p.life <= 0) continue;
    p.life -= dt;
    const k = 1 - p.life / p.max;
    p.vel.y -= 4 * dt;
    p.vel.multiplyScalar(Math.exp(-dt * 2));
    p.s.position.addScaledVector(p.vel, dt);
    p.s.scale.setScalar(p.size * (0.4 + k * 1.3));
    p.s.material.opacity = 0.7 * (1 - k);
    if (p.life <= 0) p.s.visible = false;
  }
}

// ------------------------------------------------------------------ audio: wind whoosh + edge scrape
let A = null;
function buildAudio() {
  const s = NZ.sound;
  if (A || !s.ctx) return;
  const ctx = s.ctx;
  const bus = (type, freq, q) => {
    const n = s.noiseSrc(true);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    n.connect(f).connect(g).connect(s.master);
    n.start(0, Math.random());
    return { f, g };
  };
  A = { ctx, wind: bus('bandpass', 500, 0.8), scrape: bus('highpass', 2600, 0.7) };
}
function updateAudio(speed, onFloor) {
  if (!A) buildAudio();
  if (!A) return;
  const t = A.ctx.currentTime, on = active && !NZ.vehicle && NZ.state === 'playing';
  A.wind.g.gain.setTargetAtTime(on ? Math.min(0.45, speed / 40) : 0, t, 0.1);
  A.wind.f.frequency.setTargetAtTime(350 + speed * 55, t, 0.1);
  A.scrape.g.gain.setTargetAtTime(on && onFloor ? Math.min(0.16, Math.abs(carve) * speed * 0.012 + speed * 0.002) : 0, t, 0.06);
}

// ------------------------------------------------------------------ HUD ring
let hud = null;
const RING = 2 * Math.PI * 27;
function buildHud() {
  const css = document.createElement('style');
  css.textContent = `
    #nzs-ring { position: absolute; left: calc(50% - 200px); bottom: 34px; width: 76px; height: 76px; display: none;
      filter: drop-shadow(0 0 8px rgba(80,160,255,.6)); }
    #nzs-ring.on { display: block; }
    #nzs-ring svg { width: 100%; height: 100%; }
    #nzs-ring .track { fill: rgba(8,12,20,.55); stroke: rgba(255,255,255,.14); stroke-width: 5; }
    #nzs-ring .arc { fill: none; stroke: #8fd0ff; stroke-width: 5; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 38px 38px; }
    #nzs-ring .icon { stroke: #eaf6ff; stroke-width: 3.2; stroke-linecap: round; fill: none; }
    #nzs-ring .icon .tip { stroke: #d8261a; }
    #nzs-ring b { position: absolute; left: 0; right: 0; bottom: -18px; text-align: center; font-size: 12px; letter-spacing: .2em; color: #cfe9ff; text-shadow: 0 0 6px #000; }
    #nzs-ring.warn { animation: nzs-warn .5s steps(2, jump-none) infinite; }
    #nzs-ring.warn .arc { stroke: #ff5a3c; }
    #nzs-ring.warn b { color: #ff8a6c; }
    @keyframes nzs-warn { 0% { opacity: 1; transform: scale(1.08); } 100% { opacity: .45; transform: scale(1); } }`;
  document.head.appendChild(css);
  const el = document.createElement('div');
  el.id = 'nzs-ring';
  el.innerHTML = `<svg viewBox="0 0 76 76" aria-label="skis">
      <circle class="track" cx="38" cy="38" r="27"/>
      <circle class="arc" cx="38" cy="38" r="27" stroke-dasharray="${RING}" stroke-dashoffset="0"/>
      <g class="icon"><path d="M25 51 L49 23"/><path class="tip" d="M49 23 L52 21"/><path d="M31 54 L55 26"/><path class="tip" d="M55 26 L58 24"/>
        <path d="M24 30 L46 55" stroke-width="1.6"/><path d="M48 30 L28 55" stroke-width="1.6"/></g></svg><b>30</b>`;
  NZ.$('hud').appendChild(el);
  hud = { el, arc: el.querySelector('.arc'), num: el.querySelector('b'), last: -1 };
}

// ------------------------------------------------------------------ on/off
function equip() {
  const t = NZ.clock.elapsedTime;
  if (!active) NZ.message('SKIS!', true, 2);
  else NZ.message('MORE SKI TIME', true, 1.5);
  active = true;
  until = t + DURATION;
  NZ.sound.powerup();
  NZ.sound.say('Skis');
  NZ.hint('Carve with A/D · downhill builds speed · Space to jump', 4);
}

function unequip(quiet) {
  if (!active) return;
  active = false;
  for (const k in MODS) delete player[k];
  player.roll = 0;
  roll = carve = 0;
  tips.visible = false;
  if (!quiet) {
    NZ.hint('Skis worn out', 2);
    NZ.sound.click(700, 0, 0.4);
  }
}

// ------------------------------------------------------------------ per frame
// Surface under the skis: returns its normal (or null) and leaves the feet-to-snow gap in groundGap.
let groundGap = Infinity;
function groundNormal() {
  const p = player.collider.start;
  _ray.origin.copy(p).y += 0.2;
  const hit = NZ.world.octree.rayIntersect(_ray);
  let gy = hit && hit.distance < 2.5 ? hit.position.y : -Infinity;
  if (gy > -Infinity) {
    hit.triangle.getNormal(_b);
    if (_b.y < 0) _b.negate();
  }
  const h = NZ.terrainAt?.(p.x, p.z);
  if (h !== undefined && h >= gy - 0.05) {
    // The world module's heightfield is the higher surface here.
    const e = 0.5;
    gy = h;
    _b.set(NZ.terrainAt(p.x - e, p.z) - NZ.terrainAt(p.x + e, p.z), 2 * e, NZ.terrainAt(p.x, p.z - e) - NZ.terrainAt(p.x, p.z + e)).normalize();
  }
  groundGap = p.y - 0.36 - gy;
  return gy > -Infinity ? _b : null;
}

function skiPhysics(dt) {
  const v = player.vel, speed = Math.hypot(v.x, v.z);
  Object.assign(player, MODS);
  const turn = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
  carve += (turn - carve) * Math.min(1, dt * 6);
  let n = groundNormal();
  if (!player.onFloor && n && v.y < 1.5 && groundGap > 0 && groundGap < 0.55 && n.y > 0.6) {
    // Hug the slope instead of hopping down it: only real crests and jumps give air.
    player.collider.translate(_a.set(0, -groundGap, 0));
    player.onFloor = true;
    const into = v.x * n.x + v.y * n.y + v.z * n.z;
    if (into > 0) v.addScaledVector(n, -into);
  }
  if (player.onFloor) {
    if (v.y < -0.5 && (!n || n.y > 0.97)) v.y = -0.5; // don't carry landing speed into flat snow
    // Downhill pull: the horizontal part of the ground normal is sin(slope).
    if (n) {
      v.x += n.x * 26 * dt;
      v.z += n.z * 26 * dt;
    }
    // Carve: turn the view and swing the momentum around with it.
    const dYaw = carve * 1.9 * dt * Math.min(1, 0.35 + speed / 6);
    player.yaw += dYaw;
    const c = Math.cos(dYaw), s = Math.sin(dYaw), vx = v.x, vz = v.z;
    v.x = vx * c + vz * s;
    v.z = -vx * s + vz * c;
    // Edges bite: sideways slide bleeds off, skis go where they point.
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    const along = v.x * fx + v.z * fz, lx = v.x - fx * along, lz = v.z - fz * along;
    const bite = Math.exp(-dt * (keys.KeyS ? 0.6 : 2.6));
    v.x = fx * along + lx * bite;
    v.z = fz * along + lz * bite;
  }
  const sp = Math.hypot(v.x, v.z);
  if (sp > 26) {
    v.x *= 26 / sp;
    v.z *= 26 / sp;
  }
  roll += (carve * 0.16 * Math.min(1, sp / 7) - roll) * Math.min(1, dt * 5);
  player.roll = roll;
  // Snow spray off the tails, more when carving hard.
  if (player.onFloor && sp > 3.5) {
    const n = (sp / 10 + Math.abs(carve) * 1.5) * dt * 30;
    const feet = player.collider.start;
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1, rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
      _a.set(feet.x + rx * side * 0.3 - v.x * 0.03, feet.y - 0.3, feet.z + rz * side * 0.3 - v.z * 0.03);
      if (Math.random() < 0.35) spray(_a, _b.set(-v.x * 0.25 + rx * side * (1.5 + Math.abs(carve) * 3), 1.4 + Math.random() * 1.5, -v.z * 0.25 + rz * side * (1.5 + Math.abs(carve) * 3)), 0.35 + sp * 0.02, 0.6 + Math.random() * 0.4);
      else NZ.emit(_a, 2, [0.95, 0.97, 1.0], 2.5 + Math.abs(carve) * 2, 2.5, 0.6);
    }
  }
  // Carving hard throws a fan of spray off the downhill edge, out in front where you can see it.
  if (player.onFloor && sp > 5 && Math.abs(carve) > 0.3 && Math.random() < dt * 40 * Math.abs(carve)) {
    const out = Math.sign(carve), rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), feet = player.collider.start;
    _a.set(feet.x + fx * 3.2 + rx * out * 0.9, feet.y + 0.1, feet.z + fz * 3.2 + rz * out * 0.9);
    spray(_a, _b.set(v.x * 0.85 + rx * out * (3 + Math.random() * 3), 2.5 + Math.random() * 2, v.z * 0.85 + rz * out * (3 + Math.random() * 3)), 0.5 + sp * 0.025, 0.7);
  }
  // A touch of FOV kick with speed (updateWeapon resets it every frame).
  NZ.camera.fov += Math.min(10, Math.max(0, sp - 6) * 0.6);
  NZ.camera.updateProjectionMatrix();
  updateAudio(sp, player.onFloor);
  // Ski tips in view: follow the carve, chatter with speed.
  tips.visible = true;
  const t = NZ.clock.elapsedTime, ch = Math.min(1, sp / 20) * 0.006;
  tips.rotation.y = carve * 0.22;
  tips.rotation.z = -roll * 1.5;
  tips.position.y = -0.72 + (player.onFloor ? Math.sin(t * 31) * ch : -0.05);
  for (const ski of tips.children) {
    ski.position.z = -1.15 + ski.userData.side * carve * 0.05;
    ski.rotation.x = player.onFloor ? 0 : 0.18;
  }
}

function updateRing(t) {
  const left = Math.max(0, until - t);
  hud.el.classList.toggle('on', active);
  if (!active) return;
  hud.arc.setAttribute('stroke-dashoffset', (RING * (1 - left / DURATION)).toFixed(1));
  hud.el.classList.toggle('warn', left <= WARN);
  const s = Math.ceil(left);
  if (s !== hud.last) hud.num.textContent = hud.last = s;
}

// ------------------------------------------------------------------ hooks
hooks.ready.push(() => {
  NZ.wcam.add(tips);
  buildSnow();
  buildHud();
  placeRack();
});

hooks.reset.push(() => {
  unequip(true);
  clearPickups(true);
  rackTakenRound = -1;
  placeRack();
});

hooks.kill.push((z) => {
  if (pickups.filter((p) => !p.rack).length || Math.random() >= DROP_CHANCE) return;
  addPickup(z.pos.x, z.pos.z, false);
});

hooks.round.push((n) => {
  if (rackTakenRound >= 0 && n - rackTakenRound >= RACK_EVERY) {
    rackTakenRound = -1;
    placeRack();
  }
});

hooks.update.push((dt, t) => {
  updateSnow(dt);
  // Pickups: spin, bob, blink before vanishing, collect on contact.
  const pp = player.collider.start;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i], u = p.mesh.userData;
    p.t += dt;
    u.glow.material.opacity = 0.6 + 0.3 * Math.sin(t * 4);
    if (!p.rack) {
      u.pair.rotation.y += dt * 1.6;
      p.mesh.position.y += Math.sin(t * 3) * 0.003;
      p.mesh.visible = p.t < 22 || Math.sin(p.t * 18) > 0;
    }
    const close = Math.hypot(pp.x - p.mesh.position.x, pp.z - p.mesh.position.z) < (p.rack ? 1.3 : 1.4) && Math.abs(pp.y - p.mesh.position.y) < 2;
    if ((close && !NZ.vehicle) || (!p.rack && p.t > 28)) {
      NZ.scene.remove(p.mesh);
      pickups.splice(i, 1);
      if (!close) continue;
      if (p.rack) rackTakenRound = NZ.ROUND.n;
      equip();
    }
  }
  if (active && t >= until) unequip(false);
  if (active && !NZ.vehicle) skiPhysics(dt);
  else {
    if (active) tips.visible = false;
    updateAudio(0, false);
  }
  if (hud) updateRing(t);
});

hooks.frame.push((dt, t, state) => {
  if (state !== 'playing' && A) updateAudio(0, false);
});

window.__game_vehicles = Object.defineProperties(window.__game_vehicles || {}, Object.getOwnPropertyDescriptors({
  giveSkis() {
    equip();
  },
  get skis() {
    return { spray: SNOW.filter((p) => p.life > 0).length, roll: +roll.toFixed(3), carve: +carve.toFixed(2), active, left: active ? +(until - NZ.clock.elapsedTime).toFixed(1) : 0, pickups: pickups.map((p) => ({ rack: p.rack, x: +p.mesh.position.x.toFixed(1), y: +(-p.mesh.position.z).toFixed(1) })) };
  },
}));
