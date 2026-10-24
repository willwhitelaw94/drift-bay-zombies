// TEAM WEAPONS: the Queenstown Coach Gun (pump shotgun), the Lake Wakatipu RPG, keyframed reload /
// pump / bolt animations for every gun, ejected casings, a weapon-slot HUD and full screen.
// Contracts: implements NZ.giveRocket(n) and NZ.weaponFx {switched, reload, pose}; calls
// NZ.explode?.(pos, 6, 1400, {source:'rpg'}) and NZ.dismember?.(z, part, impulse).
import './weapons-audio.js';

const NZ = window.NZ;
const { THREE, V3, $, scene, camera, view, weapon, GUNS, AMMO, player, sound, hooks } = NZ;

// ------------------------------------------------------------------ helpers
const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const seg = (e, a, b) => ease((e - a) / (b - a));
// Eased keyframes: keys = [[time, x, y, z], ...] -> out (Vector3).
function track(out, keys, e) {
  if (e <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (e < b[0]) {
      const a = keys[i - 1], k = ease((e - a[0]) / (b[0] - a[0]));
      return out.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    }
  }
  const l = keys[keys.length - 1];
  return out.set(l[1], l[2], l[3]);
}
// Remember an object's rest transform so every frame starts from it.
const rest = (o) => ((o.userData.rp = o.position.clone()), (o.userData.rr = o.rotation.clone()), o);
const toRest = (o) => (o.position.copy(o.userData.rp), o.rotation.copy(o.userData.rr), o);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, len, n = 12) => new THREE.CylinderGeometry(r0, r1, len, n).rotateX(Math.PI / 2); // along z
function mesh(parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

const MAT = {
  metal: new THREE.MeshStandardMaterial({ color: 0x3a3d43, roughness: 0.45, metalness: 0.15 }),
  blued: new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.35, metalness: 0.3 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.55 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x23201d, roughness: 0.9 }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x3c4232, roughness: 1 }),
  olive: new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.75 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc9a046, roughness: 0.3, metalness: 0.8 }),
  hull: new THREE.MeshStandardMaterial({ color: 0xa3201a, roughness: 0.55 }),
  warhead: new THREE.MeshStandardMaterial({ color: 0x77825c, roughness: 0.5, metalness: 0.1 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.8 }),
};
const GEO = {
  shell: cyl(0.0105, 0.0105, 0.055, 10), shellBase: cyl(0.011, 0.011, 0.014, 10),
  round: cyl(0.006, 0.006, 0.05, 8), roundTip: new THREE.ConeGeometry(0.006, 0.022, 8).rotateX(-Math.PI / 2),
};
// A shotgun shell: red hull + brass head, along z with the head at +z.
function shellMesh(parent) {
  const g = new THREE.Group();
  mesh(g, GEO.shell, MAT.hull, 0, 0, 0);
  mesh(g, GEO.shellBase, MAT.brass, 0, 0, 0.032);
  parent.add(g);
  return g;
}

// ------------------------------------------------------------------ view models
const rig = { carbine: {}, sniper: {}, shotgun: {}, rpg: {} };

function rigCarbine() {
  const parts = NZ.gunModels.carbine, r = rig.carbine;
  r.mag = rest(parts.find((p) => p.name === 'mag'));
  r.charge = rest(parts.find((p) => p.name === 'charge'));
  r.hand = parts.filter((p) => p.name === 'offhand').map(rest);
  r.drop = new THREE.Mesh(r.mag.geometry, r.mag.material); // the empty mag that falls away
  r.drop.visible = false;
  view.add(r.drop);
  r.port = new V3(0.03, 0.04, 0.0);
}

function rigSniper() {
  const grp = NZ.gunModels.sniper[0], r = rig.sniper;
  // Re-parent the bolt handle onto a pivot on the bore axis so it can lift and slide.
  r.bolt = rest(new THREE.Group());
  r.bolt.position.set(0, 0.035, 0.07);
  rest(r.bolt);
  grp.add(r.bolt);
  for (const m of grp.children.filter((c) => c.name === 'bolt')) {
    m.position.sub(r.bolt.position);
    r.bolt.add(m);
  }
  mesh(r.bolt, cyl(0.012, 0.012, 0.11, 10), MAT.brass.clone(), 0, 0, 0).material.color.set(0x9a9ca0);
  r.hand = grp.children.filter((c) => c.name === 'offhand').map(rest);
  r.round = new THREE.Group();
  mesh(r.round, GEO.round, MAT.brass, 0, 0, 0);
  mesh(r.round, GEO.roundTip, MAT.brass, 0, 0, -0.035);
  r.round.visible = false;
  grp.add(r.round);
  r.port = new V3(0.04, 0.045, 0.04);
}

function buildShotgun() {
  const g = new THREE.Group(), r = rig.shotgun;
  g.position.set(0, 0.0, 0.0);
  view.add(g);
  NZ.gunModels.shotgun = [g];
  // Receiver, barrel, magazine tube, bead.
  mesh(g, box(0.05, 0.07, 0.22), MAT.blued, 0, 0.02, -0.01);
  mesh(g, box(0.052, 0.012, 0.2), MAT.metal, 0, 0.058, -0.01);
  mesh(g, cyl(0.015, 0.015, 0.52, 14), MAT.blued, 0, 0.038, -0.38);
  mesh(g, cyl(0.017, 0.017, 0.03, 14), MAT.metal, 0, 0.038, -0.625);
  mesh(g, cyl(0.0125, 0.0125, 0.42, 12), MAT.metal, 0, 0.008, -0.33);
  mesh(g, cyl(0.014, 0.014, 0.02, 12), MAT.metal, 0, 0.008, -0.54);
  mesh(g, new THREE.SphereGeometry(0.0055, 8, 6), MAT.brass, 0, 0.057, -0.62);
  mesh(g, box(0.004, 0.022, 0.07), MAT.dark, 0.026, 0.03, -0.02); // ejection port
  mesh(g, box(0.024, 0.006, 0.07), MAT.dark, 0, -0.016, 0.0); // loading port
  // Stock, wrist, trigger guard.
  mesh(g, box(0.046, 0.08, 0.16), MAT.wood, 0, -0.005, 0.15, 0.06);
  mesh(g, box(0.048, 0.13, 0.17), MAT.wood, 0, -0.05, 0.3, 0.16);
  mesh(g, box(0.05, 0.135, 0.02), MAT.dark, 0, -0.06, 0.39, 0.16);
  mesh(g, box(0.006, 0.03, 0.05), MAT.metal, 0, -0.03, 0.04);
  // Pump (slides) with the off hand riding on it.
  r.pump = rest(new THREE.Group());
  r.pump.position.set(0, 0, 0);
  rest(r.pump);
  g.add(r.pump);
  mesh(r.pump, box(0.054, 0.045, 0.15), MAT.wood, 0, 0.004, -0.27);
  for (let i = 0; i < 5; i++) mesh(r.pump, box(0.056, 0.004, 0.006), MAT.dark, 0, -0.012, -0.32 + i * 0.025);
  r.hand = rest(new THREE.Group());
  r.pump.add(r.hand);
  mesh(r.hand, box(0.07, 0.06, 0.1), MAT.glove, -0.012, -0.03, -0.27, 0.15, 0, 0.15);
  mesh(r.hand, box(0.08, 0.08, 0.34), MAT.sleeve, -0.07, -0.09, -0.11, 0.32, -0.45, 0);
  // Trigger hand.
  mesh(g, box(0.06, 0.07, 0.09), MAT.glove, 0.012, -0.065, 0.12, -0.3);
  mesh(g, box(0.085, 0.085, 0.3), MAT.sleeve, 0.05, -0.11, 0.28, -0.35, 0.15, 0);
  r.shell = shellMesh(g);
  r.shell.visible = false;
  r.port = new V3(0.03, 0.03, -0.02);
  g.visible = false;
}

function buildRpg() {
  const g = new THREE.Group(), r = rig.rpg;
  g.position.set(0.0, 0.0, 0.08);
  g.scale.setScalar(0.85);
  view.add(g);
  NZ.gunModels.rpg = [g];
  // Tube, wooden heat guard, flared venturi, grips, iron sights.
  mesh(g, cyl(0.04, 0.04, 0.92, 16), MAT.olive, 0, 0, -0.1);
  mesh(g, cyl(0.046, 0.046, 0.26, 16), MAT.wood, 0, 0, -0.04);
  mesh(g, cyl(0.044, 0.044, 0.03, 16), MAT.metal, 0, 0, -0.555);
  mesh(g, cyl(0.045, 0.065, 0.16, 16), MAT.olive, 0, 0, 0.43);
  mesh(g, cyl(0.066, 0.066, 0.015, 16), MAT.dark, 0, 0, 0.51);
  mesh(g, box(0.035, 0.11, 0.045), MAT.dark, 0, -0.085, 0.02, -0.25);
  mesh(g, box(0.032, 0.1, 0.04), MAT.dark, 0, -0.08, -0.25, -0.1);
  mesh(g, box(0.006, 0.028, 0.006), MAT.metal, 0, 0.05, -0.43);
  mesh(g, box(0.03, 0.022, 0.01), MAT.metal, 0, 0.048, -0.08);
  mesh(g, box(0.06, 0.05, 0.08), MAT.dark, -0.06, 0.03, -0.06); // optic body on the left
  mesh(g, cyl(0.016, 0.02, 0.1, 10), MAT.dark, -0.06, 0.06, -0.06);
  // The rocket sitting in the muzzle (body inside, warhead out front).
  r.rocket = rest(new THREE.Group());
  r.rocket.position.set(0, 0, -0.56);
  rest(r.rocket);
  g.add(r.rocket);
  mesh(r.rocket, cyl(0.034, 0.034, 0.18, 12), MAT.olive, 0, 0, 0.08);
  mesh(r.rocket, cyl(0.04, 0.072, 0.06, 16), MAT.warhead, 0, 0, -0.03);
  mesh(r.rocket, cyl(0.072, 0.072, 0.1, 16), MAT.warhead, 0, 0, -0.11);
  mesh(r.rocket, cyl(0.073, 0.073, 0.012, 16), MAT.brass, 0, 0, -0.165);
  mesh(r.rocket, new THREE.ConeGeometry(0.072, 0.2, 16).rotateX(-Math.PI / 2), MAT.warhead, 0, 0, -0.27);
  mesh(r.rocket, cyl(0.009, 0.009, 0.05, 6), MAT.metal, 0, 0, -0.39);
  // Hands: trigger hand on the rear grip, off hand on the front grip.
  mesh(g, box(0.06, 0.07, 0.09), MAT.glove, 0.012, -0.1, 0.03, -0.3);
  mesh(g, box(0.085, 0.085, 0.3), MAT.sleeve, 0.05, -0.15, 0.2, -0.35, 0.15, 0);
  r.hand = rest(new THREE.Group());
  g.add(r.hand);
  mesh(r.hand, box(0.065, 0.07, 0.09), MAT.glove, -0.01, -0.11, -0.25, 0.1, 0, 0.15);
  mesh(r.hand, box(0.08, 0.08, 0.34), MAT.sleeve, -0.07, -0.16, -0.08, 0.32, -0.45, 0);
  g.visible = false;
}

// ------------------------------------------------------------------ reload choreography
// Each gun: a fixed timeline (seconds) of eased keyframes, with sounds fired at their marks.
const RL = { gun: '', events: null, ei: 0, n: 0, inserted: 0, wasEmpty: false };
const SG = { OPEN: 0.3, SHELL: 0.42, CLOSE: 0.3, PUMP: 0.5 };
const SN = { OPEN: 0.62, ROUND: 0.36, CLOSE: 0.8 };

GUNS.shotgun.reloadFor = () => {
  RL.n = Math.min(weapon.magSize - weapon.mag, weapon.reserve);
  RL.wasEmpty = weapon.mag === 0;
  return SG.OPEN + RL.n * SG.SHELL + SG.CLOSE + (RL.wasEmpty ? SG.PUMP : 0);
};
GUNS.shotgun.reloadTick = (e) => {
  // Shell i goes home 62% of the way through its stroke.
  const due = Math.min(RL.n, Math.max(0, Math.floor((e - SG.OPEN - SG.SHELL * 0.62) / SG.SHELL) + 1));
  while (RL.inserted < due && weapon.mag < weapon.magSize && weapon.reserve > 0) {
    RL.inserted++;
    weapon.mag++;
    weapon.reserve--;
    NZ.updateAmmoHud();
  }
};
GUNS.sniper.reloadFor = () => {
  RL.n = Math.min(weapon.magSize - weapon.mag, weapon.reserve);
  return SN.OPEN + RL.n * SN.ROUND + SN.CLOSE;
};

function reloadEvents(gun) {
  const ev = [];
  if (gun === 'carbine') ev.push([0.3, () => sound.magOut()], [0.62, () => sound.pouch()], [1.08, () => sound.magIn()],
    [1.5, () => sound.chargeBack()], [1.63, () => sound.chargeHome()]);
  if (gun === 'sniper') {
    ev.push([0.25, () => sound.boltUp()], [0.45, () => sound.boltBack()]);
    for (let i = 0; i < RL.n; i++) ev.push([SN.OPEN + i * SN.ROUND + 0.24, () => sound.roundIn()]);
    const c = SN.OPEN + RL.n * SN.ROUND;
    ev.push([c + 0.08, () => sound.boltHome()], [c + 0.28, () => sound.boltDown()]);
  }
  if (gun === 'shotgun') {
    ev.push([0.05, () => sound.pouch()]);
    for (let i = 0; i < RL.n; i++) ev.push([SG.OPEN + i * SG.SHELL + SG.SHELL * 0.6, () => sound.shellIn()]);
    if (RL.wasEmpty) ev.push([SG.OPEN + RL.n * SG.SHELL + SG.CLOSE + 0.02, () => sound.pump()]);
  }
  if (gun === 'rpg') ev.push([0.15, () => sound.pouch()], [0.85, () => sound.pouch()], [1.4, () => sound.rpgSlide()],
    [1.83, () => sound.rpgSeat()], [2.75, () => metalClick()]);
  return ev;
}
const metalClick = () => sound.click(1500, 0, 0.3);

const _a = new V3(), _b = new V3(), _c = new V3();

// Carbine 2.2 s: tilt, mag drops away, off hand fetches + seats a new one, racks the charging handle.
const CB = {
  // Off-hand offsets from its rest on the handguard.
  hand: [[0, 0, 0, 0], [0.22, 0, 0, 0], [0.55, -0.05, -0.42, 0.27], [0.9, 0.007, -0.18, 0.21], [1.1, 0.007, -0.11, 0.21],
    [1.18, 0.007, -0.11, 0.21], [1.42, 0.057, 0.1, 0.27], [1.56, 0.057, 0.1, 0.32], [1.64, 0.057, 0.1, 0.27], [2.0, 0, 0, 0]],
};
function animCarbine(e) {
  const r = rig.carbine, tilt = seg(e, 0, 0.3) - seg(e, 1.8, 2.2);
  // Lift the gun into view and roll the mag well toward the off hand.
  view.rotation.z -= 0.65 * tilt;
  view.rotation.x += 0.28 * tilt - 0.06 * Math.sin(Math.min(1, Math.max(0, (e - 1.08) / 0.15)) * Math.PI);
  view.rotation.y += 0.18 * tilt;
  view.position.x -= 0.08 * tilt;
  view.position.y += 0.1 * tilt;
  view.position.z -= 0.06 * tilt;
  track(_a, CB.hand, e);
  for (const h of r.hand) h.position.add(_a);
  // The old mag falls away under gravity, tumbling.
  const ft = e - 0.3;
  r.drop.visible = ft > 0 && ft < 0.6;
  if (r.drop.visible) {
    r.drop.position.copy(r.mag.userData.rp);
    r.drop.position.y += -0.08 * ft - 2.2 * ft * ft;
    r.drop.position.x -= 0.06 * ft;
    r.drop.rotation.set(0.08 + 2.5 * ft, 0, 1.6 * ft);
  }
  // The new mag rides in the off hand from below and is pushed home.
  r.mag.visible = e < 0.3 || e > 0.55;
  if (e > 0.55 && e < 1.1) r.mag.position.add(_b.set(_a.x - 0.007, _a.y + 0.11, _a.z - 0.21));
  // Charging handle: back, then slam home.
  r.charge.position.z += 0.05 * (seg(e, 1.42, 1.56) - (e > 1.56 ? Math.min(1, (e - 1.56) / 0.05) : 0));
}

// Sniper: tilt, bolt up + back, thumb rounds in one by one, bolt forward + down.
function animSniper(e) {
  const r = rig.sniper, close = SN.OPEN + RL.n * SN.ROUND;
  const tilt = seg(e, 0, 0.3) - seg(e, close + 0.4, close + SN.CLOSE);
  view.rotation.z += 0.4 * tilt;
  view.rotation.y += 0.16 * tilt;
  view.rotation.x += 0.2 * tilt;
  view.position.x -= 0.07 * tilt;
  view.position.y += 0.06 * tilt;
  view.position.z -= 0.05 * tilt;
  boltPose(seg(e, 0.18, 0.34) - seg(e, close + 0.2, close + 0.32), seg(e, 0.36, 0.54) - seg(e, close, close + 0.15));
  // Off hand: off the forend, then a stroke per round from below to the port.
  let hx = 0, hy = 0, hz = 0;
  const off = seg(e, 0.3, 0.6) - seg(e, close + 0.25, close + 0.6);
  r.round.visible = false;
  if (e > SN.OPEN && e < close) {
    const i = Math.floor((e - SN.OPEN) / SN.ROUND), u = (e - SN.OPEN - i * SN.ROUND) / SN.ROUND;
    const up = seg(u, 0, 0.45) - seg(u, 0.7, 1), push = seg(u, 0.45, 0.65);
    _a.set(r.port.x, r.port.y - 0.05 * push, r.port.z);
    _b.set(0.02, -0.25, 0.12).lerp(_a, up);
    r.round.visible = u < 0.66;
    r.round.position.copy(_b);
    hx = _b.x + 0.012;
    hy = _b.y - 0.02;
    hz = _b.z + 0.04;
  } else {
    hx = 0.02;
    hy = -0.25;
    hz = 0.12;
  }
  // Blend between the forend grip (rest) and the loading stroke.
  for (const h of r.hand) {
    const rp = h.userData.rp;
    h.position.set(rp.x + (hx - -0.012) * off, rp.y + (hy - -0.05) * off, rp.z + (hz - -0.26) * off);
  }
}
function boltPose(lift, back) {
  const b = rig.sniper.bolt;
  b.rotation.z = 1.1 * lift;
  b.position.z = b.userData.rp.z + 0.1 * back;
}

// Shotgun: roll, off hand leaves the pump and feeds shells into the loading port one at a time.
function animShotgun(e) {
  const r = rig.shotgun, close = SG.OPEN + RL.n * SG.SHELL;
  const tilt = seg(e, 0, SG.OPEN) - seg(e, close, close + SG.CLOSE);
  view.rotation.z -= 0.65 * tilt;
  view.rotation.x += 0.28 * tilt;
  view.rotation.y += 0.16 * tilt;
  view.position.x -= 0.08 * tilt;
  view.position.y += 0.1 * tilt;
  view.position.z -= 0.06 * tilt;
  // Hand offset (relative to its spot on the pump): parked below the gun, or a feeding stroke.
  const below = _b.set(0.0, -0.24, 0.3);
  const port = _c.set(0.012, -0.075, 0.28);
  r.shell.visible = false;
  if (e > SG.OPEN && e < close) {
    const i = Math.floor((e - SG.OPEN) / SG.SHELL), u = (e - SG.OPEN - i * SG.SHELL) / SG.SHELL;
    const up = seg(u, 0, 0.42) - seg(u, 0.72, 1), push = seg(u, 0.42, 0.62);
    _a.copy(below).lerp(port, up);
    _a.z -= 0.05 * push;
    _a.y += 0.025 * push;
    r.hand.position.copy(_a);
    // Shell sits on the fingertips, then is thumbed up and forward into the tube.
    r.shell.visible = u < 0.64;
    r.shell.position.set(_a.x - 0.01, _a.y + 0.03 + 0.03 * push, _a.z - 0.27 - 0.04 * push);
  } else {
    const k = seg(e, 0, SG.OPEN) - seg(e, close, close + SG.CLOSE);
    r.hand.position.copy(below).multiplyScalar(k);
  }
  if (RL.wasEmpty) pumpPose(Math.max(0, e - close - SG.CLOSE) / SG.PUMP, false);
}

// RPG 3.0 s: off the shoulder nose-up, a fresh rocket slid into the front, back on the shoulder.
const RP = {
  hand: [[0, 0, 0, 0], [0.4, 0, 0, 0], [0.8, 0.05, -0.4, 0.05], [1.35, 0.01, 0.05, -0.33], [1.83, 0.01, 0.05, -0.05],
    [1.9, 0.01, 0.05, -0.05], [2.3, 0, 0, 0]],
};
function animRpg(e) {
  const r = rig.rpg, low = seg(e, 0, 0.5) - seg(e, 2.25, 2.9);
  view.rotation.x += 0.45 * low;
  view.rotation.z += 0.22 * low;
  view.position.x -= 0.1 * low;
  view.position.y -= 0.05 * low;
  view.position.z += 0.1 * low;
  view.position.y -= 0.012 * Math.sin(Math.min(1, Math.max(0, (e - 1.83) / 0.12)) * Math.PI);
  track(_a, RP.hand, e);
  r.hand.position.add(_a);
  r.rocket.visible = e > 0.8;
  // Rocket carried in the hand, aligned with the bore, then pushed home.
  if (e < 1.83) r.rocket.position.add(_b.set(_a.x - 0.01, _a.y - 0.05, _a.z + 0.03));
}

// Pump: forend back then home; k in 0..1 over the stroke. Ejects a hull at the back stop.
const PUMP = { t: 9, ejected: true };
function pumpPose(k, eject = true) {
  const r = rig.shotgun;
  const back = seg(k, 0.0, 0.4) - seg(k, 0.5, 0.9);
  r.pump.position.z = 0.085 * back;
  view.rotation.z -= 0.08 * back;
  view.rotation.x += 0.03 * back;
  if (eject && k > 0.42 && !PUMP.ejected) {
    PUMP.ejected = true;
    ejectCasing('hull', r.port, NZ.gunModels.shotgun[0]);
  }
}

const BOLT = { ejected: true };

// ------------------------------------------------------------------ casings (pooled, world space)
const CAS_N = 36;
const casings = [];
function buildCasings() {
  const brass = cyl(0.0045, 0.0045, 0.026, 6);
  for (let i = 0; i < CAS_N; i++) {
    const hull = i >= CAS_N - 10;
    let m;
    if (hull) {
      m = new THREE.Group();
      mesh(m, GEO.shell, MAT.hull, 0, 0, 0);
      mesh(m, GEO.shellBase, MAT.brass, 0, 0, 0.032);
    } else m = new THREE.Mesh(brass, MAT.brass);
    m.visible = false;
    scene.add(m);
    casings.push({ m, hull, vel: new V3(), spin: new V3(), life: 0, floor: 0, bounces: 0, rest: false });
  }
}
let casNext = 0, hullNext = 0;
const _ej = new V3(), _right = new V3(), _up = new V3();
function ejectCasing(kind, port, frame) {
  const hull = kind === 'hull';
  const c = hull ? casings[CAS_N - 10 + (hullNext++ % 10)] : casings[casNext++ % (CAS_N - 10)];
  // View-model port -> camera space (wcam sits at the origin) -> world.
  frame.updateWorldMatrix(true, false);
  _ej.copy(port).applyMatrix4(frame.matrixWorld);
  camera.updateMatrixWorld();
  _ej.applyMatrix4(camera.matrixWorld);
  c.m.position.copy(_ej);
  c.m.scale.setScalar(kind === 'big' ? 1.6 : 1);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  c.vel.copy(_right).multiplyScalar((hull ? 2.2 : 1.8) + Math.random() * 1.2)
    .addScaledVector(_up, 1.6 + Math.random() * 1.0).add(player.vel);
  c.vel.y += 0.4;
  c.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
  c.m.rotation.set(Math.random() * 6, Math.random() * 6, 0);
  c.life = 7;
  c.bounces = 0;
  c.rest = false;
  c.floor = player.collider.start.y - 0.34;
  c.kind = hull ? 'hull' : 'brass';
  c.m.visible = true;
}
function updateCasings(dt) {
  for (const c of casings) {
    if (c.life <= 0) continue;
    c.life -= dt;
    if (c.life <= 0) {
      c.m.visible = false;
      continue;
    }
    if (c.rest) continue;
    c.vel.y -= 9.8 * dt;
    c.m.position.addScaledVector(c.vel, dt);
    c.m.rotation.x += c.spin.x * dt;
    c.m.rotation.y += c.spin.y * dt;
    c.m.rotation.z += c.spin.z * dt;
    if (c.m.position.y < c.floor) {
      c.m.position.y = c.floor;
      if (c.bounces++ < 2 && c.vel.y < -1) sound.casing(c.kind, c.kind === 'hull' ? 0.12 : 0.08);
      c.vel.y *= -0.35;
      c.vel.x *= 0.55;
      c.vel.z *= 0.55;
      c.spin.multiplyScalar(0.5);
      if (Math.abs(c.vel.y) < 0.35) {
        c.rest = true;
        c.m.rotation.x = c.m.rotation.z = 0; // lying on its side
      }
    }
  }
}

// ------------------------------------------------------------------ shotgun fire
const PELLETS = 8;
const raycaster = new THREE.Raycaster();
const _fwd = new V3(), _dir = new V3(), _ray = new THREE.Ray(), _wall = new V3();
const hitZ = [];
const PART_NAMES = ['legL', 'legL', 'legR', 'armR', 'head', 'armL', 'armR'];
const falloff = (d) => (d <= 7 ? 1 : d <= 12 ? 1 - ((d - 7) / 5) * 0.45 : 0.55 * Math.exp(-(d - 12) / 3.5));

GUNS.shotgun.fire = () => {
  sound.shotgun();
  PUMP.t = 0;
  PUMP.ejected = false;
  PUMP.sounded = false;
  KICK.v = 1;
  const moving = Math.hypot(player.vel.x, player.vel.z) > 1;
  const cone = weapon.ads ? weapon.spread[2] : moving ? weapon.spread[1] : weapon.spread[0];
  camera.getWorldDirection(_fwd);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  hitZ.length = 0;
  for (let p = 0; p < PELLETS; p++) {
    // Even-ish spread: one pellet near the centre, the rest in a jittered ring pattern.
    const a = (p / PELLETS) * Math.PI * 2 + Math.random() * 0.6, rr = p === 0 ? 0.15 * Math.random() : Math.sqrt(0.25 + 0.75 * Math.random());
    _dir.copy(_fwd).addScaledVector(_right, Math.cos(a) * rr * cone).addScaledVector(_up, Math.sin(a) * rr * cone).normalize();
    _ray.origin.copy(camera.position);
    _ray.direction.copy(_dir);
    const wall = NZ.world.octree.rayIntersect(_ray);
    raycaster.set(camera.position, _dir);
    raycaster.far = wall ? wall.distance : 80;
    const hits = raycaster.intersectObjects(NZ.hitMeshes, false);
    if (hits.length) {
      const h = hits[0], z = h.object.userData.z, head = !!h.object.userData.head;
      if (!z || z.state === 'dead') continue;
      if (!z.sg) z.sg = { dmg: 0, head: false, part: 0, point: new V3(), dist: 0 };
      if (!hitZ.includes(z)) {
        hitZ.push(z);
        z.sg.dmg = 0;
        z.sg.head = false;
        z.sg.dist = h.distance;
        z.sg.point.copy(h.point);
        z.sg.part = z.parts.indexOf(h.object);
      }
      z.sg.dmg += weapon.dmg * falloff(h.distance) * (head ? 2 : 1);
      if (head) {
        z.sg.head = true;
        z.sg.part = 4;
      }
    } else if (wall && wall.distance < 40) {
      _wall.copy(wall.position);
      if (p % 2 === 0) NZ.sparks(_wall);
      NZ.dust(_wall, 2);
    }
  }
  for (const z of hitZ) {
    const s = z.sg, close = Math.max(0, 1 - s.dist / 12);
    NZ.damageZombie(z, s.dmg, s.head, false, s.point);
    _dir.set(z.pos.x - camera.position.x, 0, z.pos.z - camera.position.z).normalize();
    if (z.state === 'dead') {
      z.deathDir = 1;
      if (s.dist < 7) {
        // Point-blank: blow a limb (or the head) clean off.
        NZ.dismember?.(z, PART_NAMES[s.part] || 'armR', new V3().copy(_dir).multiplyScalar(4 + 6 * close).setY(1.5 + 2 * close));
        NZ.blood(s.point, 30, 3.2);
      }
      shove(z, 0.9 * close);
    } else {
      z.stagger = Math.max(z.stagger, 0.35 + 0.9 * close);
      shove(z, 0.55 * close);
    }
  }
  player.pitch = Math.min(1.45, player.pitch + weapon.kick * (weapon.ads ? 0.6 : 1));
  player.yaw += (Math.random() - 0.5) * 0.02;
};

// Knock a zombie back along the shot, but never into a wall cell.
function shove(z, d) {
  if (d <= 0.01) return;
  const nx = z.pos.x + _dir.x * d, nz = z.pos.z + _dir.z * d, c = NZ.cellOf(nx, nz);
  if (c < 0 || NZ.walk[c]) {
    z.pos.x = nx;
    z.pos.z = nz;
  }
}

// ------------------------------------------------------------------ RPG: rockets, smoke, fallback blast
const ROCKETS = [];
const rocketLight = new THREE.PointLight(0xff8a3a, 0, 14, 1.6);
scene.add(rocketLight);
const flashMat = new THREE.SpriteMaterial({ map: NZ.flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
function buildRockets() {
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    mesh(g, cyl(0.03, 0.03, 0.3, 10), MAT.olive, 0, 0, -0.15);
    mesh(g, cyl(0.045, 0.045, 0.12, 12), MAT.warhead, 0, 0, 0.06);
    mesh(g, new THREE.ConeGeometry(0.045, 0.16, 12).rotateX(Math.PI / 2), MAT.warhead, 0, 0, 0.2);
    for (let f = 0; f < 4; f++) mesh(g, box(0.004, 0.06, 0.08), MAT.metal, 0, 0, -0.27, 0, 0, (f * Math.PI) / 2).translateY(0.04);
    const flame = new THREE.Sprite(flashMat);
    flame.scale.setScalar(0.55);
    flame.position.z = -0.38;
    g.add(flame);
    g.visible = false;
    scene.add(g);
    ROCKETS.push({ g, flame, pos: new V3(), prev: new V3(), vel: new V3(), age: 0, smokeT: 0, live: false });
  }
}

// Smoke puffs: pooled sprites, each with its own material for fading.
const SMOKE_N = 280;
const smoke = [];
function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function buildSmoke() {
  const tex = smokeTexture();
  for (let i = 0; i < SMOKE_N; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xaba59f, transparent: true, depthWrite: false, opacity: 0 }));
    s.visible = false;
    scene.add(s);
    smoke.push({ s, vel: new V3(), life: 0, max: 1, s0: 0.2, s1: 1, o: 0.5 });
  }
}
let smokeNext = 0;
function puff(p, vx, vy, vz, life, s0, s1, o, warm = false) {
  const q = smoke[smokeNext++ % SMOKE_N];
  q.s.position.copy(p);
  q.vel.set(vx, vy, vz);
  q.life = q.max = life;
  q.s0 = s0;
  q.s1 = s1;
  q.o = o;
  q.s.material.color.setHex(warm ? 0xffa060 : 0xaba59f);
  q.s.material.rotation = Math.random() * 6.28;
  q.s.visible = true;
}
function updateSmoke(dt) {
  for (const q of smoke) {
    if (q.life <= 0) continue;
    q.life -= dt;
    if (q.life <= 0) {
      q.s.visible = false;
      continue;
    }
    const k = 1 - q.life / q.max;
    q.s.position.addScaledVector(q.vel, dt);
    q.vel.multiplyScalar(1 - 1.8 * dt);
    q.vel.y += 0.25 * dt;
    q.s.scale.setScalar(q.s0 + (q.s1 - q.s0) * Math.sqrt(k));
    q.s.material.opacity = q.o * (1 - k) * Math.min(1, k * 30);
    if (k > 0.15) q.s.material.color.lerp(_greyC, 0.2);
  }
}
const _greyC = new THREE.Color(0xaba59f);

GUNS.rpg.fire = () => {
  sound.rpgLaunch();
  KICK.v = 1;
  const r = ROCKETS.find((x) => !x.live) || ROCKETS[0];
  camera.getWorldDirection(_fwd);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const sp = weapon.ads ? weapon.spread[2] : weapon.spread[0];
  _fwd.x += (Math.random() - 0.5) * sp;
  _fwd.y += (Math.random() - 0.5) * sp;
  _fwd.normalize();
  r.pos.copy(camera.position).addScaledVector(_fwd, 0.9).addScaledVector(_right, weapon.ads ? 0.02 : 0.12).addScaledVector(_up, -0.08);
  r.prev.copy(r.pos);
  r.vel.copy(_fwd).multiplyScalar(26);
  r.age = 0;
  r.smokeT = 0;
  r.live = true;
  r.g.visible = true;
  r.g.position.copy(r.pos);
  // Backblast behind the shooter and a launch cloud at the muzzle.
  for (let i = 0; i < 10; i++) {
    _a.copy(camera.position).addScaledVector(_fwd, -0.8).addScaledVector(_right, 0.15);
    puff(_a, -_fwd.x * 6 + (Math.random() - 0.5) * 3, (Math.random() - 0.2) * 1.5, -_fwd.z * 6 + (Math.random() - 0.5) * 3, 1.4 + Math.random(), 0.3, 2.2, 0.45, i < 4);
  }
  for (let i = 0; i < 2; i++) {
    _a.copy(r.pos).addScaledVector(_fwd, 2.2);
    puff(_a, (Math.random() - 0.5) * 2.5, Math.random() * 0.8, (Math.random() - 0.5) * 2.5, 0.7 + Math.random() * 0.4, 0.2, 1.0, 0.22, i < 2);
  }
  player.pitch = Math.min(1.45, player.pitch + weapon.kick);
  weapon.cd = 0.45;
};

const _seg = new V3(), _zc = new V3(), _hit = new V3();
function updateRockets(dt, t) {
  let lit = null;
  for (const r of ROCKETS) {
    if (!r.live) continue;
    r.age += dt;
    const speed = Math.min(64, r.vel.length() + 70 * dt);
    r.vel.setLength(speed);
    r.vel.y -= 1.2 * dt;
    r.prev.copy(r.pos);
    _seg.copy(r.vel).multiplyScalar(dt);
    const len = _seg.length();
    _ray.origin.copy(r.prev);
    _ray.direction.copy(_seg).divideScalar(len);
    const wall = NZ.world.octree.rayIntersect(_ray);
    let boom = null;
    if (wall && wall.distance <= len + 0.05) boom = _hit.copy(wall.position).addScaledVector(_ray.direction, -0.15);
    if (!boom) {
      for (const z of NZ.zombies) {
        if (z.state === 'dead' || z.state === 'rising') continue;
        _zc.set(z.pos.x, z.pos.y + 1.0, z.pos.z);
        _ray.closestPointToPoint(_zc, _a);
        if (_a.distanceTo(r.prev) > len + 0.3) continue;
        if (Math.hypot(_a.x - _zc.x, _a.z - _zc.z) < 0.45 && Math.abs(_a.y - _zc.y) < 0.95) {
          boom = _hit.copy(_a);
          break;
        }
      }
    }
    if (!boom && r.age > 6) boom = _hit.copy(r.pos);
    if (boom) {
      r.live = false;
      r.g.visible = false;
      detonate(boom);
      continue;
    }
    r.pos.add(_seg);
    r.g.position.copy(r.pos);
    r.g.lookAt(_a.copy(r.pos).add(r.vel));
    r.flame.scale.setScalar(0.7 + Math.random() * 0.4);
    r.flame.material.rotation = Math.random() * 6.28;
    // Smoke trail: denser near the tube, a warm puff every so often from the motor.
    r.smokeT -= r.age > 0.07 ? dt : 0; // no trail right in the player's face
    while (r.smokeT <= 0) {
      r.smokeT += 0.012;
      _a.copy(r.pos).addScaledVector(_ray.direction, -0.35 - Math.random() * len);
      puff(_a, (Math.random() - 0.5) * 0.5, (Math.random() - 0.3) * 0.3, (Math.random() - 0.5) * 0.5, 1.5 + Math.random() * 1.0, 0.25, 1.5, 0.7, Math.random() < 0.3);
    }
    lit = r;
  }
  if (lit) {
    rocketLight.position.copy(lit.pos);
    rocketLight.intensity = 30 + Math.random() * 14;
  } else rocketLight.intensity = Math.max(0, rocketLight.intensity - dt * 900);
  updateBlast(dt);
}

function detonate(pos) {
  if (NZ.explode) NZ.explode(pos, 6, 1400, { source: 'rpg' });
  else fallbackExplode(pos, 6, 1400);
}

// Minimal stand-in for the explosives module: damage in a radius, a flash, smoke and a boom.
const blast = new THREE.Sprite(new THREE.SpriteMaterial({ map: NZ.flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
blast.visible = false;
scene.add(blast);
let blastT = 0;
const _bp = new V3();
function fallbackExplode(pos, radius, dmg) {
  for (const z of NZ.zombies) {
    if (z.state === 'dead') continue;
    _zc.set(z.pos.x, z.pos.y + 0.9, z.pos.z);
    const d = _zc.distanceTo(pos);
    if (d > radius) continue;
    _bp.copy(_zc);
    NZ.damageZombie(z, dmg * (1 - 0.7 * (d / radius)), false, false, _bp);
    if (z.state === 'dead') z.deathDir = 1;
  }
  blast.position.copy(pos);
  blast.visible = true;
  blastT = 0.4;
  rocketLight.position.copy(pos);
  rocketLight.intensity = 260;
  NZ.emit(pos, 70, [1.0, 0.62, 0.25], 10, 8, 0.7);
  NZ.dust(pos, 40);
  for (let i = 0; i < 18; i++) puff(pos, (Math.random() - 0.5) * 7, Math.random() * 4, (Math.random() - 0.5) * 7, 2 + Math.random() * 1.5, 0.8, 4.5, 0.6, i < 7);
  const far = pos.distanceTo(camera.position);
  sound.rpgBoom(Math.max(0.25, 1 - far / 60));
  player.pitch += 0.03 * Math.max(0, 1 - far / 25);
}
function updateBlast(dt) {
  if (blastT <= 0) return;
  blastT -= dt;
  const k = 1 - blastT / 0.4;
  blast.scale.setScalar(3 + 9 * k);
  blast.material.opacity = 1 - k;
  blast.material.rotation += dt;
  if (blastT <= 0) blast.visible = false;
}

NZ.giveRocket = (n = 1) => {
  const a = weapon.gun === 'rpg' ? weapon : AMMO.rpg;
  const before = a.reserve;
  a.reserve = Math.min(GUNS.rpg.reserveMax, a.reserve + n);
  NZ.updateAmmoHud();
  return a.reserve - before;
};

// ------------------------------------------------------------------ per-frame pose
const KICK = { v: 0 };
const KICK_BY = { carbine: [0, 0], sniper: [0.04, 0.12], shotgun: [0.07, 0.24], rpg: [0.09, 0.1] };

function pose(dt) {
  const shown = weapon.shown, r = rig[shown];
  if (!r.hand) return;
  // Every animated part starts from rest each frame.
  if (shown === 'carbine') {
    toRest(r.mag).visible = true;
    toRest(r.charge);
    for (const h of r.hand) toRest(h);
    r.drop.visible = false;
  } else if (shown === 'sniper') {
    for (const h of r.hand) toRest(h);
    toRest(r.bolt);
    r.round.visible = false;
  } else if (shown === 'shotgun') {
    toRest(r.pump);
    toRest(r.hand);
    r.shell.visible = false;
  } else if (shown === 'rpg') {
    toRest(r.hand);
    toRest(r.rocket).visible = (shown === weapon.gun ? weapon.mag : AMMO.rpg.mag) > 0;
  }
  // Heavier guns kick harder and settle slower than the base recoil.
  KICK.v = Math.max(0, KICK.v - dt * 3.2);
  const kb = KICK_BY[shown], kv = KICK.v * KICK.v;
  view.position.z += kb[0] * kv;
  view.rotation.x += kb[1] * kv;
  const reloading = weapon.reloading > 0 && shown === weapon.gun && RL.gun === shown;
  if (reloading) {
    const e = weapon.reloadTime - weapon.reloading;
    while (RL.ei < RL.events.length && RL.events[RL.ei][0] <= e) RL.events[RL.ei++][1]();
    if (shown === 'carbine') animCarbine(e);
    else if (shown === 'sniper') animSniper(e);
    else if (shown === 'shotgun') animShotgun(e);
    else animRpg(e);
    return;
  }
  if (shown === 'shotgun' && shown === weapon.gun) {
    PUMP.t += dt;
    const k = (PUMP.t - 0.16) / 0.42;
    if (k > 0 && !PUMP.sounded) {
      PUMP.sounded = true;
      sound.pump();
    }
    if (k > 0 && k < 1) pumpPose(k);
  }
  if (shown === 'sniper' && shown === weapon.gun && weapon.cd > 0 && weapon.mag > 0 && weapon.cd < weapon.rate) {
    // Work the bolt between shots: up, back (casing flies), forward, down.
    const k = (weapon.rate - weapon.cd) / weapon.rate;
    const lift = seg(k, 0.22, 0.36) - seg(k, 0.66, 0.78), back = seg(k, 0.36, 0.5) - seg(k, 0.54, 0.66);
    boltPose(lift, back);
    const b = Math.sin(Math.min(1, Math.max(0, (k - 0.15) / 0.75)) * Math.PI);
    view.rotation.z += 0.22 * b;
    view.position.y -= 0.03 * b;
    if (k < 0.3) BOLT.ejected = false;
    if (k > 0.5 && !BOLT.ejected) {
      BOLT.ejected = true;
      ejectCasing('big', r.port, NZ.gunModels.sniper[0]);
    }
  }
}

NZ.weaponFx = {
  switched() {
    sound.swapGun();
    RL.gun = '';
    PUMP.t = 9;
    PUMP.sounded = true;
  },
  reload(gun) {
    RL.gun = gun;
    RL.inserted = 0;
    if (gun === 'carbine' || gun === 'rpg') RL.n = 0;
    RL.events = reloadEvents(gun);
    RL.ei = 0;
  },
  pose,
};

// ------------------------------------------------------------------ HUD: weapon slots + reload prompt
const SLOT_NAMES = { carbine: 'Carbine', sniper: 'Sniper', shotgun: 'Shotgun', rpg: 'RPG' };
let slotsEl, promptEl, barEl, lastSlots = -1, lastPrompt = '';
function buildHud() {
  const css = document.createElement('style');
  css.textContent = `
#nz-slots { position: absolute; right: 30px; bottom: 162px; display: flex; gap: 6px; font-size: 11px; letter-spacing: .14em;
  text-transform: uppercase; text-shadow: 0 0 6px #000; }
#nz-slots span { padding: 3px 7px; border: 1px solid rgba(232,220,203,.18); opacity: .45; background: rgba(0,0,0,.25); }
#nz-slots span b { color: var(--gold); margin-right: 5px; }
#nz-slots span.on { opacity: 1; border-color: var(--gold); background: rgba(40,20,10,.55); }
#nz-slots span.empty { color: #ff5a3c; }
#nz-reload { position: absolute; left: 50%; top: calc(50% + 46px); transform: translateX(-50%); text-align: center;
  font-size: 13px; letter-spacing: .3em; text-transform: uppercase; text-shadow: 0 0 6px #000; color: var(--chalk); opacity: 0;
  transition: opacity .12s; pointer-events: none; }
#nz-reload.show { opacity: .95; }
#nz-reload.warn { color: #ffcf5a; }
#nz-reload.out { color: #ff5a3c; }
#nz-reload i { display: block; width: 120px; height: 3px; margin: 6px auto 0; background: rgba(232,220,203,.18); }
#nz-reload i u { display: block; height: 100%; width: 0; background: var(--gold); }
#nz-fs { font: 600 14px "Oswald", sans-serif; letter-spacing: .2em; text-transform: uppercase; color: var(--chalk);
  background: transparent; border: 1px solid rgba(232,220,203,.4); padding: 9px 20px; margin: 12px auto 0; cursor: pointer; display: block; }
#nz-fs:hover { border-color: var(--gold); color: var(--gold); }
#nz-fs-hint { font-size: 13px; margin: 8px 0 0; opacity: .85; }
#nz-fs-hint a { color: var(--gold); }
#nz-fs-hint[hidden] { display: none; }`;
  document.head.appendChild(css);
  slotsEl = document.createElement('div');
  slotsEl.id = 'nz-slots';
  promptEl = document.createElement('div');
  promptEl.id = 'nz-reload';
  promptEl.innerHTML = '<span></span><i><u></u></i>';
  barEl = promptEl.querySelector('u');
  $('hud').append(slotsEl, promptEl);
}
function updateHud() {
  // Rebuild the slot strip only when the selection or an empty flag changes.
  let sig = 0, bit = 1;
  for (const k in GUNS) {
    const a = k === weapon.gun ? weapon : AMMO[k];
    if (k === weapon.gun) sig += bit;
    if (a && a.mag + a.reserve === 0) sig += bit * 2;
    bit *= 4;
  }
  if (sig !== lastSlots) {
    lastSlots = sig;
    let html = '', i = 1;
    for (const k in GUNS) {
      const a = k === weapon.gun ? weapon : AMMO[k];
      html += `<span class="${k === weapon.gun ? 'on' : ''}${a && a.mag + a.reserve === 0 ? ' empty' : ''}"><b>${i++}</b>${SLOT_NAMES[k] || k}</span>`;
    }
    slotsEl.innerHTML = html;
  }
  let text = '', cls = '';
  if (weapon.reloading > 0) text = 'Reloading';
  else if (weapon.mag === 0 && weapon.reserve === 0) (text = 'No ammo'), (cls = 'out');
  else if (weapon.mag <= Math.floor(weapon.magSize / 5) && weapon.reserve > 0 && weapon.swap <= 0) (text = 'R  Reload'), (cls = 'warn');
  const key = text + cls;
  if (key !== lastPrompt) {
    lastPrompt = key;
    promptEl.className = text ? 'show ' + cls : cls;
    promptEl.firstChild.textContent = text;
    promptEl.lastChild.style.display = weapon.reloading > 0 ? '' : 'none';
  }
  if (weapon.reloading > 0) barEl.style.width = `${Math.round((1 - weapon.reloading / weapon.reloadTime) * 100)}%`;
}

// ------------------------------------------------------------------ full screen
let fsBtn, fsHint;
function buildFullscreen() {
  fsBtn = document.createElement('button');
  fsBtn.id = 'nz-fs';
  fsBtn.type = 'button';
  fsBtn.textContent = 'Full screen';
  fsHint = document.createElement('p');
  fsHint.id = 'nz-fs-hint';
  fsHint.hidden = true;
  const a = document.createElement('a');
  a.href = location.href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Open in its own tab for full screen + mouse lock';
  fsHint.append('Full screen is blocked in this frame. ', a);
  $('play').after(fsBtn, fsHint);
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    fsBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    if (document.fullscreenElement) relock();
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(BUTTON|A|INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.code === 'KeyO' || ((e.code === 'Enter' || e.code === 'NumpadEnter') && !typing)) toggleFullscreen();
  });
  if (!document.fullscreenEnabled && window.top !== window) fsHint.hidden = false;
}
function toggleFullscreen() {
  if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
  const el = document.documentElement;
  if (!document.fullscreenEnabled || !el.requestFullscreen) return fullscreenBlocked();
  el.requestFullscreen({ navigationUI: 'hide' }).catch(fullscreenBlocked);
}
function relock() {
  const c = NZ.renderer.domElement;
  if (NZ.state !== 'playing' || document.pointerLockElement === c) return;
  try {
    const p = c.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch {
    // The pause overlay's "Click to resume" re-locks instead.
  }
}
function fullscreenBlocked() {
  fsHint.hidden = false;
  if (NZ.state === 'playing') NZ.hint('Full screen is blocked here. Press Esc and use the link to open the game in its own tab.', 6);
}

// ------------------------------------------------------------------ wiring
hooks.ready.push(() => {
  rigCarbine();
  rigSniper();
  buildShotgun();
  buildRpg();
  buildCasings();
  buildRockets();
  buildSmoke();
  buildHud();
  NZ.showGun(weapon.gun);
});
buildFullscreen();

hooks.shot.push((gun) => {
  NZ.muzzle.scale.setScalar(gun === 'shotgun' ? 0.42 : gun === 'rpg' ? 0.7 : gun === 'sniper' ? 0.32 : 0.2);
  if (gun === 'carbine') ejectCasing('brass', rig.carbine.port, view);
  if (gun === 'sniper') KICK.v = 1;
});

const HOLD = { e: -1 };
hooks.frame.push((dt) => {
  if (HOLD.e >= 0 && weapon.reloading > 0) weapon.reloading = weapon.reloadTime - HOLD.e + dt;
});

hooks.update.push((dt, t) => {
  updateCasings(dt);
  updateRockets(dt, t);
  updateSmoke(dt);
  updateHud();
});

hooks.reset.push(() => {
  AMMO.shotgun = { mag: GUNS.shotgun.magSize, reserve: 30 };
  AMMO.rpg = { mag: 1, reserve: 5 };
  RL.gun = '';
  KICK.v = 0;
  PUMP.t = 9;
  for (const r of ROCKETS) r.live = r.g.visible = false;
  for (const c of casings) (c.life = 0), (c.m.visible = false);
  for (const q of smoke) (q.life = 0), (q.s.visible = false);
});

// Test hooks.
window.__weapons = {
  rig, RL, ROCKETS, casings, smoke,
  give(gun) { NZ.switchGun(gun); },
  liveRockets: () => ROCKETS.filter((r) => r.live).length,
  activeCasings: () => casings.filter((c) => c.life > 0).length,
  toggleFullscreen,
  hold(e) { HOLD.e = e; }, // freeze the current reload at e seconds (-1 releases)
};
