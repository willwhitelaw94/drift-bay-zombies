import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/addons/GLTFLoader.js';
import { Octree } from './vendor/addons/Octree.js';
import { Capsule } from './vendor/addons/Capsule.js';
import { mergeGeometries } from './vendor/addons/BufferGeometryUtils.js';
import { LEVEL_GZ_B64 } from './level.js';
import META from './meta.js';
import { Sound } from './audio.js';
import { detailTexture, glowTexture, flashTexture, rng } from './textures.js';

const $ = (id) => document.getElementById(id);
const V3 = THREE.Vector3;
// Plan metres (x right, y up the drawing, z height) -> three.js (y up, -z = plan north-ish up).
const P = (x, y, z = 0) => new V3(x, z, -y);
const CENTRE = P(30, 17);
const SPAWN = { x: 30.9, y: 4.6, yaw: 0 };
const ROOMS = META.rooms;

// ------------------------------------------------------------------ plugin API
// Feature modules (features/*.js, loaded after this file) register on these hooks and
// reach the game through window.NZ. Shared cross-feature calls (NZ.explode, NZ.dismember,
// NZ.ignite, …) are defined by whichever module owns them; callers use optional chaining.
const hooks = {
  ready: [], frame: [], update: [], key: [], keyup: [], reset: [], round: [], roundEnd: [],
  zombieSpawn: [], zombieUpdate: [], zombieDamage: [], kill: [], playerDamage: [], shot: [],
};
const call = (list, ...a) => { for (const f of list) f(...a); };
const NZ = (window.NZ = { hooks });

// ------------------------------------------------------------------ renderer + scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;
$('game').appendChild(renderer.domElement);
const ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
const FOG = new THREE.Color(0x1b0e16);
scene.fog = new THREE.FogExp2(FOG, 0.02);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 60000);
camera.rotation.order = 'YXZ';
scene.add(camera);

// Weapon view model lives in its own scene so it never clips into walls.
const wscene = new THREE.Scene();
const wcam = new THREE.PerspectiveCamera(58, camera.aspect, 0.01, 10);
wscene.add(wcam);

const MOON_DIR = new V3(-0.5, 0.42, -1).normalize();

function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: { moonDir: { value: MOON_DIR }, horizon: { value: FOG }, time: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 moonDir; uniform vec3 horizon; uniform float time; varying vec3 vDir;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zen = vec3(0.004, 0.005, 0.016);
        vec3 col = mix(horizon, zen, pow(clamp(h * 1.6 + 0.02, 0.0, 1.0), 0.55));
        if (h < 0.0) col = horizon * 0.8;
        float m = max(dot(d, moonDir), 0.0);
        col += vec3(0.6, 0.12, 0.05) * pow(m, 60.0) * 0.8 + vec3(0.25, 0.05, 0.03) * pow(m, 5.0) * 0.18;
        vec3 sp = floor(d * 700.0);
        float s = hash(sp);
        float star = step(0.9975, s) * smoothstep(0.02, 0.25, h) * (0.5 + 0.5 * sin(time * 2.0 + s * 300.0));
        col += vec3(0.9, 0.85, 1.0) * star * 0.7;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50000, 32, 16), mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255,214,190,1)', 'rgba(220,60,30,0.35)', 256),
    color: 0xffb8a0, fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
  }));
  moon.scale.setScalar(5200);
  moon.renderOrder = -9;
  scene.add(moon);
  return { sky, moon };
}
const SKY = buildSky();

scene.add(new THREE.HemisphereLight(0x4a5584, 0x140a08, 1.1));
scene.add(new THREE.AmbientLight(0x2a2030, 0.6));
const moonLight = new THREE.DirectionalLight(0xff9b84, 1.1);
moonLight.position.copy(CENTRE).addScaledVector(MOON_DIR, 120);
moonLight.target.position.copy(CENTRE);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048);
Object.assign(moonLight.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 10, far: 300 });
moonLight.shadow.bias = -0.0004;
moonLight.shadow.normalBias = 0.04;
scene.add(moonLight, moonLight.target);

// ------------------------------------------------------------------ level loading
async function decodeLevel() {
  const bin = atob(LEVEL_GZ_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return new Promise((resolve, reject) => new GLTFLoader().parse(out.buffer, '', resolve, reject));
}

const TEXTURED = {
  // material: [pattern, metres per tile, colour boost]
  cedar: ['boards', 1.2], louvre: ['boards', 0.7], ceiling: ['boards', 1.2], deck: ['planks', 1.2],
  oak: ['planks', 1.4], oak_natural: ['planks', 1.4], walnut_dark: ['planks', 1.0],
  board_formed: ['concrete', 2.4, 1.35], schist: ['stone', 2.2], courtyard: ['stone', 2.6], travertine: ['stone', 1.5],
  gravel: ['gravel', 1.1], terrain: ['grass', 5], limewash: ['lime', 3], roof_seam_x: ['metal', 1.6], roof_seam_y: ['metal', 1.6],
};

function categoryOf(o) {
  for (let p = o; p; p = p.parent) {
    const m = /^([STFGXWEP])_/.exec(p.name);
    if (m) return m[1];
  }
  return 'S';
}

function cleanGeometry(src, matrix) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
  g.setIndex(src.index ? src.index.clone() : [...Array(src.attributes.position.count).keys()]);
  g.applyMatrix4(matrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function addBoxUV(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) { uv[i * 2] = p.getX(i); uv[i * 2 + 1] = p.getZ(i); }
    else if (ax >= az) { uv[i * 2] = p.getZ(i); uv[i * 2 + 1] = p.getY(i); }
    else { uv[i * 2] = p.getX(i); uv[i * 2 + 1] = p.getY(i); }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

let texSeed = 3;
function makeMaterial(name, src, cat) {
  const base = src.color ? src.color.clone() : new THREE.Color(0.5, 0.5, 0.5);
  if (cat === 'X') return new THREE.MeshLambertMaterial({ color: new THREE.Color(0.05, 0.04, 0.035) });
  if (name === 'glass') return new THREE.MeshStandardMaterial({ color: 0x8fb4c4, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide });
  if (name === 'sheer_linen') return new THREE.MeshStandardMaterial({ color: base, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  if (name === 'water') return new THREE.MeshStandardMaterial({ color: 0x0a2a33, roughness: 0.08, metalness: 0.4 });
  if (name === 'flame') return new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 1.15, 0.3) });
  const t = TEXTURED[name];
  const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.9, metalness: 0 });
  if (t) {
    m.map = detailTexture(t[0], texSeed++, ANISO);
    m.map.repeat.set(1 / t[1], 1 / t[1]);
    m.color.multiplyScalar(t[2] || 1.8);
  }
  return m;
}

const world = { octree: new Octree(), flames: [], boulderGeo: null, ready: false };

function buildLevel(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const buckets = new Map();
  const collide = [];
  const furnitureBoxes = [];
  const centreXZ = new THREE.Vector2(CENTRE.x, CENTRE.z);
  gltf.scene.traverse((o) => {
    if (o.name.startsWith('F_') && !o.isMesh) furnitureBoxes.push(o);
    if (o.name.startsWith('F_') && o.isMesh && !o.parent.name.startsWith('F_')) furnitureBoxes.push(o);
    if (!o.isMesh) return;
    const cat = categoryOf(o);
    const g = cleanGeometry(o.geometry, o.matrixWorld);
    const mname = (o.material.name || 'grey').replace(/^z_/, '');
    if (cat === 'P') {
      g.computeBoundingBox();
      const bb = g.boundingBox, c = bb.getCenter(new V3());
      g.translate(-c.x, -bb.min.y, -c.z);
      const s = 1.3 / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
      g.scale(s, s, s);
      world.boulderGeo = g;
      return;
    }
    if (cat === 'S' || cat === 'E') collide.push(g);
    if (cat === 'T') collide.push(cropTriangles(g, centreXZ, 165));
    const key = mname + (cat === 'X' ? '|far' : '');
    if (!buckets.has(key)) buckets.set(key, { name: mname, cat, src: o.material, geos: [] });
    buckets.get(key).geos.push(g);
  });

  for (const b of buckets.values()) {
    const tex = TEXTURED[b.name] && b.cat !== 'X';
    for (const g of b.geos) if (tex) addBoxUV(g);
    const merged = mergeGeometries(b.geos, false);
    const mesh = new THREE.Mesh(merged, makeMaterial(b.name, b.src, b.cat));
    mesh.matrixAutoUpdate = false;
    if (b.cat !== 'X') {
      mesh.receiveShadow = true;
      mesh.castShadow = !['terrain', 'glass', 'sheer_linen', 'gravel', 'schist', 'courtyard', 'water', 'flame'].includes(b.name);
    }
    if (b.name === 'flame') world.flames.push(mesh);
    if (b.name === 'glass' || b.name === 'sheer_linen') mesh.renderOrder = 2;
    scene.add(mesh);
  }

  // Furniture collides as simple boxes: no snagging on chair legs, and a much smaller octree.
  const box = new THREE.Box3(), size = new V3(), mid = new V3();
  for (const f of furnitureBoxes) {
    const n = f.name.toLowerCase();
    if (/rug|art|curtain|books|vase|bowl|pears|lamp_table|imac|olive\d/.test(n)) continue;
    box.setFromObject(f);
    box.getSize(size);
    if (size.y < 0.08 || Math.max(size.x, size.z) < 0.3) continue;
    box.getCenter(mid);
    const g = new THREE.BoxGeometry(size.x, size.y, size.z).toNonIndexed();
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.translate(mid.x, mid.y, mid.z);
    g.setIndex([...Array(g.attributes.position.count).keys()]);
    collide.push(g);
  }
  const posOnly = collide.map((g) => {
    const c = new THREE.BufferGeometry();
    c.setAttribute('position', g.attributes.position);
    c.setIndex(g.index);
    return c;
  });
  const collider = new THREE.Mesh(mergeGeometries(posOnly, false));
  collider.updateMatrixWorld(true);
  world.octree.fromGraphNode(collider);

  // Lake, far below, under the Remarkables.
  const lake = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), new THREE.MeshBasicMaterial({ color: 0x06070c, fog: false }));
  lake.rotation.x = -Math.PI / 2;
  lake.position.y = -36.4;
  scene.add(lake);
}

function cropTriangles(g, c, half) {
  const p = g.attributes.position, idx = g.index.array, keep = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], d = idx[i + 2];
    const x = (p.getX(a) + p.getX(b) + p.getX(d)) / 3, z = (p.getZ(a) + p.getZ(b) + p.getZ(d)) / 3;
    if (Math.abs(x - c.x) < half && Math.abs(z - c.y) < half) keep.push(a, b, d);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', p);
  out.setIndex(keep);
  return out;
}

// ------------------------------------------------------------------ vegetation
const swayUniform = { value: 0 };
function tussockGeometry(seed, blades = 16) {
  const r = rng(seed), pos = [], col = [];
  const lo = [0.10, 0.07, 0.03], hi = [0.62, 0.48, 0.24];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 0.6;
    const lean = 0.25 + r() * 0.5, h = 0.55 + r() * 0.45, w = 0.025 + r() * 0.015;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz * w, pz = dx * w;
    const pts = [];
    for (let s = 0; s <= 3; s++) {
      const t = s / 3, out = lean * t * t * 0.9 + 0.04;
      pts.push([dx * out, h * (t - 0.35 * t * t * lean), dz * out, 1 - t]);
    }
    const c = (t) => lo.map((v, i) => v + (hi[i] - v) * Math.min(1, t * 1.3));
    for (let s = 0; s < 3; s++) {
      const [x0, y0, z0, k0] = pts[s], [x1, y1, z1, k1] = pts[s + 1];
      const quad = [
        [x0 - px * k0, y0, z0 - pz * k0], [x0 + px * k0, y0, z0 + pz * k0], [x1 + px * k1, y1, z1 + pz * k1],
        [x0 - px * k0, y0, z0 - pz * k0], [x1 + px * k1, y1, z1 + pz * k1], [x1 - px * k1, y1, z1 - pz * k1],
      ];
      const ts = [s / 3, s / 3, (s + 1) / 3, s / 3, (s + 1) / 3, (s + 1) / 3];
      quad.forEach((v, i) => { pos.push(...v); col.push(...c(ts[i])); });
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function swayMaterial(opts) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = swayUniform;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float hh = clamp(position.y, 0.0, 1.2);
      vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float ph = wp.x * 0.31 + wp.z * 0.23;
      float gust = 0.6 + 0.4 * sin(uTime * 0.4 + wp.x * 0.02);
      transformed.x += sin(uTime * 1.7 + ph) * 0.13 * hh * hh * gust;
      transformed.z += cos(uTime * 1.3 + ph * 1.4) * 0.09 * hh * hh * gust;`);
  };
  return m;
}

function buildVegetation() {
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  const place = (list, geo, mat, tint, scaleMul) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const r = rng(list.length);
    list.forEach(([x, y, z, s], i) => {
      dummy.position.copy(P(x, y, z));
      dummy.rotation.set((r() - 0.5) * 0.12, r() * Math.PI * 2, (r() - 0.5) * 0.12);
      dummy.scale.setScalar(s * scaleMul);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      col.setRGB(...tint(r()));
      mesh.setColorAt(i, col);
    });
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  const tg = tussockGeometry(5);
  place(META.tussock, tg, swayMaterial(), (t) => [0.75 + t * 0.4, 0.7 + t * 0.35, 0.65 + t * 0.3], 1.0);
  place(META.garden, tussockGeometry(9, 12), swayMaterial(), (t) => [0.35 + t * 0.15, 0.55 + t * 0.2, 0.25], 0.8);
  if (world.boulderGeo) {
    addBoxUV(world.boulderGeo);
    const bm = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.28, 0.27, 0.25), roughness: 1, map: detailTexture('concrete', 77, ANISO) });
    const b = place(META.boulders, world.boulderGeo, bm, (t) => [0.8 + t * 0.4, 0.8 + t * 0.4, 0.8 + t * 0.4], 1.0);
    b.castShadow = b.receiveShadow = true;
  }
  // Wilding pines: trunks + stacked cones.
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.25, 0.45, 9, 6).translate(0, 4.5, 0);
  parts.push(paint(trunk, [0.08, 0.05, 0.035]));
  for (let i = 0; i < 6; i++) {
    const r = 3.4 - i * 0.45, h = 4.2 - i * 0.3;
    parts.push(paint(new THREE.ConeGeometry(r, h, 8).translate(0, 6 + i * 2.1, 0), [0.03, 0.06 + i * 0.006, 0.04]));
  }
  const pg = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  const pm = new THREE.MeshLambertMaterial({ vertexColors: true });
  const pines = place(META.pines, pg, pm, (t) => [0.8 + t * 0.4, 0.8 + t * 0.4, 0.8 + t * 0.4], 1.35);
  pines.castShadow = true;
}

function paint(g, rgb) {
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(rgb, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  return g;
}

// ------------------------------------------------------------------ lights that live
const fireLights = [], flickerLights = [];
function buildLights() {
  for (const [x, y, z] of META.fires) {
    const l = new THREE.PointLight(0xff7a2e, 28, 16, 1.6);
    l.position.copy(P(x, y, z + 0.25));
    l.userData.phase = Math.random() * 100;
    fireLights.push(l);
    scene.add(l);
  }
  const lampPick = [0, 2, 3, 5, 9, 11, 12, 14];
  for (const i of lampPick) {
    const p = META.lamps[i];
    if (!p) continue;
    const l = new THREE.PointLight(0xffb070, 7, 9, 1.6);
    l.position.copy(P(p[0], p[1], p[2] + 0.3));
    l.userData = { base: 7, dead: 0, phase: Math.random() * 10 };
    flickerLights.push(l);
    scene.add(l);
  }
  // A failing porch light over the entry, and one at the garage.
  for (const [x, y, z, c] of [[31.1, 11.2, 2.5, 0xcfe0ff], [47.5, 4.5, 2.5, 0xffd2a0]]) {
    const l = new THREE.PointLight(c, 9, 14, 1.6);
    l.position.copy(P(x, y, z));
    l.userData = { base: 9, dead: 0, phase: Math.random() * 10, bad: true };
    flickerLights.push(l);
    scene.add(l);
  }
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  bulb.position.copy(flickerLights[flickerLights.length - 2].position);
  scene.add(bulb);
  flickerLights[flickerLights.length - 2].userData.bulb = bulb;
}

function updateLights(t, dt) {
  for (const l of fireLights) {
    const p = l.userData.phase + t;
    l.intensity = 28 * (0.78 + 0.12 * Math.sin(p * 9.1) + 0.07 * Math.sin(p * 23.7) + 0.05 * Math.sin(p * 3.3));
  }
  for (const m of world.flames) m.material.color.setRGB(3.0 + 0.4 * Math.sin(t * 13), 1.15 + 0.2 * Math.sin(t * 7), 0.3);
  for (const l of flickerLights) {
    const u = l.userData;
    if (u.dead > 0) u.dead -= dt;
    else if (Math.random() < (u.bad ? 0.04 : 0.002)) u.dead = Math.random() * (u.bad ? 0.25 : 0.12);
    const on = u.dead > 0 ? (u.bad ? 0.02 : 0.25) : 1;
    l.intensity = u.base * on * (u.bad ? 0.85 + 0.15 * Math.sin(t * 50 + u.phase) : 1);
    if (u.bulb) u.bulb.visible = on > 0.5;
  }
}

// ------------------------------------------------------------------ walk grid + flow field
const GRID = { x0: -24, y0: -30, cs: 0.5, nx: 0, ny: 0 };
GRID.nx = Math.ceil((88 - GRID.x0) / GRID.cs);
GRID.ny = Math.ceil((62 - GRID.y0) / GRID.cs);
const NCELL = GRID.nx * GRID.ny;
const walk = new Uint8Array(NCELL), heights = new Float32Array(NCELL), indoor = new Uint8Array(NCELL);
const flow = new Int32Array(NCELL).fill(-1), queue = new Int32Array(NCELL);
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function cellOf(x, z) {
  // three.js x,z -> cell index (or -1)
  const ix = Math.floor((x - GRID.x0) / GRID.cs), iy = Math.floor((-z - GRID.y0) / GRID.cs);
  if (ix < 0 || iy < 0 || ix >= GRID.nx || iy >= GRID.ny) return -1;
  return iy * GRID.nx + ix;
}
const cellX = (i) => GRID.x0 + ((i % GRID.nx) + 0.5) * GRID.cs;
const cellZ = (i) => -(GRID.y0 + (Math.floor(i / GRID.nx) + 0.5) * GRID.cs);

const _ray = new THREE.Ray(new V3(), new V3(0, -1, 0));
function groundAt(x, z, from = 2.3) {
  _ray.direction.set(0, -1, 0);
  _ray.origin.set(x, from, z);
  let hit = world.octree.rayIntersect(_ray);
  if (!hit || hit.distance > 8) {
    _ray.origin.y = 90;
    hit = world.octree.rayIntersect(_ray);
  }
  return hit ? hit.position.y : 0;
}

async function buildGrid(progress) {
  const cap = new Capsule(new V3(), new V3(), 0.28);
  const up = new V3(0, 1, 0);
  const t0 = performance.now();
  for (let i = 0; i < NCELL; i++) {
    const x = cellX(i), z = cellZ(i);
    const h = groundAt(x, z);
    heights[i] = h;
    cap.start.set(x, h + 0.62, z);
    cap.end.set(x, h + 1.55, z);
    walk[i] = world.octree.capsuleIntersect(cap) ? 0 : 1;
    _ray.origin.set(x, h + 1.2, z);
    _ray.direction.copy(up);
    const roof = world.octree.rayIntersect(_ray);
    indoor[i] = roof && roof.distance < 7 ? 1 : 0;
    if (i % 2500 === 0) {
      progress(i / NCELL);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  console.log(`walk grid ${GRID.nx}x${GRID.ny} in ${(performance.now() - t0).toFixed(0)} ms, walkable ${walk.reduce((a, b) => a + b, 0)}`);
}

function linked(a, b) {
  return walk[b] && Math.abs(heights[a] - heights[b]) < 0.45;
}

function nearestWalkable(c) {
  if (c < 0) return -1;
  if (walk[c]) return c;
  const ix = c % GRID.nx, iy = (c / GRID.nx) | 0;
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = ix + dx, y = iy + dy;
        if (x < 0 || y < 0 || x >= GRID.nx || y >= GRID.ny) continue;
        const j = y * GRID.nx + x;
        if (walk[j]) return j;
      }
    }
  }
  return -1;
}

let flowSource = -2;
function computeFlow(src) {
  flow.fill(-1);
  if (src < 0) return;
  let head = 0, tail = 0;
  flow[src] = 0;
  queue[tail++] = src;
  while (head < tail) {
    const c = queue[head++], ix = c % GRID.nx, iy = (c / GRID.nx) | 0, d = flow[c] + 1;
    for (let k = 0; k < 8; k++) {
      const x = ix + NB[k][0], y = iy + NB[k][1];
      if (x < 0 || y < 0 || x >= GRID.nx || y >= GRID.ny) continue;
      const j = y * GRID.nx + x;
      if (flow[j] !== -1 || !linked(c, j)) continue;
      if (k >= 4 && (!walk[iy * GRID.nx + x] || !walk[y * GRID.nx + ix])) continue;
      flow[j] = d;
      queue[tail++] = j;
    }
  }
}

function nextStep(c) {
  let cur = c;
  for (let s = 0; s < 4; s++) {
    const ix = cur % GRID.nx, iy = (cur / GRID.nx) | 0;
    let best = -1, bd = flow[cur];
    for (let k = 0; k < 8; k++) {
      const x = ix + NB[k][0], y = iy + NB[k][1];
      if (x < 0 || y < 0 || x >= GRID.nx || y >= GRID.ny) continue;
      const j = y * GRID.nx + x;
      if (flow[j] >= 0 && flow[j] < bd) {
        if (k >= 4 && (!walk[iy * GRID.nx + x] || !walk[y * GRID.nx + ix])) continue;
        bd = flow[j];
        best = j;
      }
    }
    if (best < 0) break;
    cur = best;
  }
  return cur;
}

const terrainCache = new Map();
function terrainHeight(x, z) {
  const k = (Math.round(x / 2) * 4096 + Math.round(z / 2)) | 0;
  let h = terrainCache.get(k);
  if (h === undefined) {
    h = groundAt(Math.round(x / 2) * 2, Math.round(z / 2) * 2, 90);
    terrainCache.set(k, h);
  }
  return h;
}

// ------------------------------------------------------------------ minimap
const mini = { canvas: $('minimap'), base: null, ctx: null, on: true, t: 0 };
function buildMinimap() {
  const c = document.createElement('canvas');
  c.width = GRID.nx;
  c.height = GRID.ny;
  const g = c.getContext('2d');
  const img = g.createImageData(GRID.nx, GRID.ny);
  for (let i = 0; i < NCELL; i++) {
    const ix = i % GRID.nx, iy = GRID.ny - 1 - ((i / GRID.nx) | 0);
    const o = (iy * GRID.nx + ix) * 4;
    const v = walk[i] ? (indoor[i] ? [70, 52, 40, 255] : [18, 14, 16, 200]) : [225, 210, 190, 255];
    img.data.set(v, o);
  }
  g.putImageData(img, 0, 0);
  mini.base = c;
  mini.ctx = mini.canvas.getContext('2d');
}

function drawMinimap() {
  const g = mini.ctx, W = mini.canvas.width, s = 2.4; // px per metre
  const px = camera.position.x, py = -camera.position.z;
  g.save();
  g.clearRect(0, 0, W, W);
  g.beginPath();
  g.arc(W / 2, W / 2, W / 2, 0, 7);
  g.clip();
  g.fillStyle = 'rgba(8,5,8,.85)';
  g.fillRect(0, 0, W, W);
  g.translate(W / 2, W / 2);
  g.rotate(player.yaw);
  g.imageSmoothingEnabled = false;
  const mx = (GRID.x0 - px) * s, my = -(GRID.y0 + GRID.ny * GRID.cs - py) * s;
  g.drawImage(mini.base, mx, my, GRID.nx * GRID.cs * s, GRID.ny * GRID.cs * s);
  g.fillStyle = '#e0261a';
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    g.fillRect((z.pos.x - px) * s - 2.5, (-z.pos.z - py) * -s - 2.5, 5, 5);
  }
  g.fillStyle = '#9cff7a';
  for (const d of drops) g.fillRect((d.mesh.position.x - px) * s - 3, (-d.mesh.position.z - py) * -s - 3, 6, 6);
  g.restore();
  g.fillStyle = '#f2c14e';
  g.beginPath();
  g.moveTo(W / 2, W / 2 - 9);
  g.lineTo(W / 2 + 6, W / 2 + 7);
  g.lineTo(W / 2 - 6, W / 2 + 7);
  g.fill();
}

// ------------------------------------------------------------------ player
const player = {
  collider: new Capsule(new V3(), new V3(), 0.35),
  vel: new V3(), onFloor: false, yaw: 0, pitch: 0, health: 100, lastHit: -99, bob: 0, kick: 0,
};
const keys = {};
function placePlayer(x, y, yaw) {
  const g = groundAt(x, -y);
  player.collider.start.set(x, g + 0.36, -y);
  player.collider.end.set(x, g + 1.62, -y);
  player.vel.set(0, 0, 0);
  player.yaw = yaw;
  player.pitch = 0;
}

const _fwd = new V3(), _side = new V3(), _tmp = new V3(), _tmp2 = new V3();
function playerCollisions() {
  const r = world.octree.capsuleIntersect(player.collider);
  player.onFloor = false;
  if (r) {
    player.onFloor = r.normal.y > 0.3;
    if (!player.onFloor) player.vel.addScaledVector(r.normal, -r.normal.dot(player.vel));
    if (r.depth >= 1e-10) player.collider.translate(r.normal.multiplyScalar(r.depth));
  }
}

function updatePlayer(dt) {
  const sprint = keys.ShiftLeft || keys.ShiftRight;
  const accel = dt * (player.onFloor ? (sprint && !weapon.ads ? 30 : 19) : 5);
  _fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  _side.set(-_fwd.z, 0, _fwd.x);
  if (keys.KeyW) player.vel.addScaledVector(_fwd, accel);
  if (keys.KeyS) player.vel.addScaledVector(_fwd, -accel);
  if (keys.KeyA) player.vel.addScaledVector(_side, -accel);
  if (keys.KeyD) player.vel.addScaledVector(_side, accel);
  if (player.onFloor && keys.Space) {
    player.vel.y = 7.5;
    keys.Space = false;
  }
  let damping = Math.exp(-4 * dt) - 1;
  if (!player.onFloor) {
    player.vel.y -= 28 * dt;
    damping *= 0.1;
  }
  player.vel.addScaledVector(player.vel, damping);
  player.collider.translate(_tmp.copy(player.vel).multiplyScalar(dt));
  // Zombies are solid: get shoved, get trapped.
  for (const z of zombies) {
    if (z.state === 'dead' || z.state === 'rising') continue;
    const dx = player.collider.end.x - z.pos.x, dz = player.collider.end.z - z.pos.z, d2 = dx * dx + dz * dz;
    if (d2 < 0.36 && d2 > 1e-6 && Math.abs(player.collider.start.y - z.pos.y) < 1.6) {
      const d = Math.sqrt(d2), push = (0.6 - d) / d;
      player.collider.translate(_tmp2.set(dx * push, 0, dz * push));
    }
  }
  playerCollisions();
  if (player.collider.end.y < -80) placePlayer(SPAWN.x, SPAWN.y, SPAWN.yaw);
}

// ------------------------------------------------------------------ zombies
const ZG = {
  torso: new THREE.BoxGeometry(0.44, 0.6, 0.25).translate(0, 0.3, 0),
  pelvis: new THREE.BoxGeometry(0.38, 0.22, 0.23),
  head: new THREE.BoxGeometry(0.25, 0.3, 0.27).translate(0, 0.16, 0.02),
  jaw: new THREE.BoxGeometry(0.2, 0.07, 0.2).translate(0, -0.02, 0.06),
  arm: new THREE.BoxGeometry(0.12, 0.66, 0.12).translate(0, -0.3, 0),
  leg: new THREE.BoxGeometry(0.15, 0.86, 0.16).translate(0, -0.43, 0),
  eye: new THREE.BoxGeometry(0.055, 0.03, 0.02),
};
const ZM = {
  skin: [0x9aa680, 0xa8a486, 0x8a987e, 0xb3a68a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, emissive: 0x141a10 })),
  shirt: [0x6e5444, 0x46586e, 0x7e3c32, 0x66665a, 0x8c8264, 0x41553f].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, emissive: 0x0c0a0a })),
  pants: [0x3c3c46, 0x4c443a, 0x404c5c, 0x5c4c38].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, emissive: 0x080808 })),
  eye: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.2) }),
  gore: new THREE.MeshStandardMaterial({ color: 0x3a0505, roughness: 0.6 }),
};
const zombies = [];
let hitMeshes = [];

function makeZombie() {
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const skin = pick(ZM.skin), shirt = pick(ZM.shirt), pants = pick(ZM.pants);
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);
  const pelvis = new THREE.Mesh(ZG.pelvis, pants);
  hips.add(pelvis);
  const legL = new THREE.Mesh(ZG.leg, pants), legR = new THREE.Mesh(ZG.leg, pants);
  legL.position.set(-0.1, 0, 0);
  legR.position.set(0.1, 0, 0);
  hips.add(legL, legR);
  const spine = new THREE.Group();
  spine.position.y = 0.1;
  hips.add(spine);
  const torso = new THREE.Mesh(ZG.torso, shirt);
  spine.add(torso);
  const neck = new THREE.Group();
  neck.position.y = 0.62;
  spine.add(neck);
  const head = new THREE.Mesh(ZG.head, skin);
  neck.add(head);
  const jaw = new THREE.Mesh(ZG.jaw, ZM.gore);
  jaw.position.set(0, 0.03, 0.05);
  head.add(jaw);
  for (const sx of [-0.06, 0.06]) {
    const e = new THREE.Mesh(ZG.eye, ZM.eye);
    e.position.set(sx, 0.2, 0.156);
    head.add(e);
  }
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.29, 0.55, 0);
  armR.position.set(0.29, 0.55, 0);
  const aL = new THREE.Mesh(ZG.arm, Math.random() < 0.5 ? skin : shirt), aR = new THREE.Mesh(ZG.arm, Math.random() < 0.5 ? skin : shirt);
  armL.add(aL);
  armR.add(aR);
  spine.add(armL, armR);
  for (const m of [pelvis, legL, legR, torso, head, aL, aR]) {
    m.castShadow = true;
    m.userData.head = m === head;
  }
  return { root, hips, spine, neck, head, armL, armR, legL, legR, parts: [pelvis, legL, legR, torso, head, aL, aR] };
}

const ROUND = { n: 0, toSpawn: 0, spawnT: 0, between: 0, active: false };
function zombiesForRound(r) {
  return [0, 6, 9, 13, 18, 24][r] ?? Math.min(24 + (r - 5) * 5, 70);
}
function healthForRound(r) {
  return r < 10 ? 150 + 100 * (r - 1) : Math.round(950 * Math.pow(1.1, r - 9));
}

let spawnCandidates = [];
function prepareSpawns() {
  spawnCandidates = META.tussock
    .map(([x, y, z]) => ({ x, y, z, c: cellOf(x, -y) }))
    .filter((p) => p.c >= 0 && walk[p.c] && !indoor[p.c] && (p.x < -2 || p.x > 64 || p.y < -6 || p.y > 38));
}

function spawnZombie(forced) {
  const px = camera.position.x, py = -camera.position.z;
  let cand = forced || null;
  for (let tries = 0; tries < 40 && !forced; tries++) {
    const c = spawnCandidates[(Math.random() * spawnCandidates.length) | 0];
    const d = Math.hypot(c.x - px, c.y - py);
    if (d > 12 && d < 34 && flow[c.c] >= 0) {
      cand = c;
      break;
    }
    cand = c;
  }
  const z = makeZombie();
  const sprinter = Math.random() < Math.min(0.75, Math.max(0, (ROUND.n - 3) * 0.14));
  const scale = 0.92 + Math.random() * 0.18;
  z.root.scale.setScalar(scale);
  Object.assign(z, {
    pos: P(cand.x, cand.y, cand.z),
    hp: healthForRound(ROUND.n),
    speed: sprinter ? 3.4 + Math.random() * 1.2 : 1.0 + Math.min(1.4, ROUND.n * 0.14) + Math.random() * 0.4,
    sprinter, state: 'rising', t: 0, phase: Math.random() * 6, attackCd: 0.6, groanT: 1 + Math.random() * 5,
    heading: 0, stuckT: 0, lastPos: new V3(), stagger: 0, sway: (Math.random() - 0.5) * 0.4, deathDir: 1,
  });
  z.lastPos.copy(z.pos);
  z.root.position.copy(z.pos);
  z.root.position.y -= 1.9;
  z.heading = Math.atan2(px - z.pos.x, -py - z.pos.z);
  z.root.rotation.y = z.heading;
  for (const m of z.parts) m.userData.z = z;
  call(hooks.zombieSpawn, z);
  scene.add(z.root);
  zombies.push(z);
  refreshHitMeshes();
  dust(z.pos, 14);
}

function refreshHitMeshes() {
  hitMeshes = [];
  for (const z of zombies) if (z.state !== 'dead') hitMeshes.push(...z.parts);
}

const _zd = new V3();
function updateZombie(z, dt, t) {
  if (z.update) return z.update(z, dt, t); // custom enemies (e.g. sheep) bring their own brain
  call(hooks.zombieUpdate, z, dt, t);
  z.t += dt;
  if (z.state === 'dead') {
    const k = Math.min(1, z.t / 0.55);
    z.root.rotation.x = -z.deathDir * k * k * 1.45;
    z.root.position.y = z.pos.y + (z.t > 2.6 ? -(z.t - 2.6) * 0.8 : 0);
    if (z.t > 4.2) {
      scene.remove(z.root);
      z.remove = true;
    }
    return;
  }
  if (z.state === 'rising') {
    const k = Math.min(1, z.t / 1.6);
    z.root.position.set(z.pos.x, z.pos.y - 1.9 * (1 - k * (2 - k)), z.pos.z);
    z.armL.rotation.x = -2.6 * k;
    z.armR.rotation.x = -2.2 * k;
    if (Math.random() < 0.3) dust(z.pos, 1);
    if (k >= 1) z.state = 'walk';
    return;
  }
  const pp = player.collider.start;
  const dx = pp.x - z.pos.x, dz = pp.z - z.pos.z, dist = Math.hypot(dx, dz);
  const close = dist < 1.05 && Math.abs(pp.y - 0.36 - z.pos.y) < 1.4;
  z.stagger = Math.max(0, z.stagger - dt);
  // Steering target.
  let tx = pp.x, tz = pp.z;
  const c = nearestWalkable(cellOf(z.pos.x, z.pos.z));
  if (c >= 0 && flow[c] > 2) {
    const n = nextStep(c);
    tx = cellX(n);
    tz = cellZ(n);
  }
  _zd.set(tx - z.pos.x, 0, tz - z.pos.z);
  const want = Math.atan2(_zd.x, _zd.z);
  let dh = want - z.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  z.heading += dh * Math.min(1, dt * (z.sprinter ? 8 : 4));
  let moving = 0;
  if (close) {
    z.state = 'attack';
    z.attackCd -= dt;
    if (z.attackCd <= 0) {
      z.attackCd = 1.15;
      z.swing = 0.0001;
      if (Math.random() < 0.6) sound.groan(z.pos, 1.2, true);
    }
  } else {
    z.state = 'walk';
    z.attackCd = Math.min(z.attackCd, 0.45);
    const sp = z.speed * (z.stagger > 0 ? 0.25 : 1) * dt;
    const nx = z.pos.x + Math.sin(z.heading) * sp, nz = z.pos.z + Math.cos(z.heading) * sp;
    const cur = cellOf(z.pos.x, z.pos.z), nxt = cellOf(nx, nz);
    if (nxt < 0 || walk[nxt] || cur < 0 || !walk[cur]) {
      z.pos.x = nx;
      z.pos.z = nz;
    } else {
      const ax = cellOf(nx, z.pos.z), az = cellOf(z.pos.x, nz);
      if (ax >= 0 && walk[ax]) z.pos.x = nx;
      else if (az >= 0 && walk[az]) z.pos.z = nz;
    }
    moving = 1;
  }
  // Swipe animation and damage on the downswing.
  if (z.swing > 0) {
    z.swing += dt * 3.2;
    if (z.swing > 0.5 && !z.swung) {
      z.swung = true;
      if (dist < 1.4) damagePlayer(z.sprinter ? 45 : 40);
    }
    if (z.swing >= 1) z.swing = z.swung = 0;
  }
  // Separation from other zombies.
  for (const o of zombies) {
    if (o === z || o.state === 'dead' || o.state === 'rising') continue;
    const ox = z.pos.x - o.pos.x, oz = z.pos.z - o.pos.z, d2 = ox * ox + oz * oz;
    if (d2 < 0.36 && d2 > 1e-6) {
      const d = Math.sqrt(d2), push = ((0.6 - d) / d) * 0.5;
      const nx = z.pos.x + ox * push, nz = z.pos.z + oz * push, nc = cellOf(nx, nz);
      if (nc < 0 || walk[nc]) {
        z.pos.x = nx;
        z.pos.z = nz;
      }
    }
  }
  const cc = cellOf(z.pos.x, z.pos.z);
  const gy = cc >= 0 && walk[cc] ? heights[cc] : terrainHeight(z.pos.x, z.pos.z);
  z.pos.y += (gy - z.pos.y) * Math.min(1, dt * 10);
  // Stuck? Crawl back out of the tussock somewhere else.
  z.stuckT += dt;
  if (z.stuckT > 4) {
    if (z.lastPos.distanceTo(z.pos) < 0.6 && !close) respawn(z);
    z.lastPos.copy(z.pos);
    z.stuckT = 0;
  }
  // Animate.
  z.phase += dt * (moving ? (z.sprinter ? 11 : 4.2 + z.speed * 1.4) : 2);
  const s = Math.sin(z.phase), swingAmp = moving ? (z.sprinter ? 0.8 : 0.45) : 0.05;
  z.legL.rotation.x = s * swingAmp;
  z.legR.rotation.x = -s * swingAmp;
  z.hips.position.y = 0.92 + Math.abs(Math.cos(z.phase)) * (z.sprinter ? 0.07 : 0.035);
  z.spine.rotation.x = z.sprinter ? 0.45 : 0.22 + 0.05 * Math.sin(z.phase * 0.5);
  z.spine.rotation.z = z.sway + Math.sin(z.phase * 0.5) * 0.08;
  z.neck.rotation.z = Math.sin(t * 0.9 + z.phase * 0.2) * 0.25 - z.sway;
  const reach = z.swing > 0 ? -1.5 - Math.sin(z.swing * Math.PI) * 1.3 : -1.5;
  z.armL.rotation.x = reach + Math.sin(z.phase + 1) * 0.15;
  z.armR.rotation.x = (z.swing > 0 ? -2.8 + z.swing * 2.6 : -1.45) + Math.sin(z.phase) * 0.15;
  z.armL.rotation.z = -0.12;
  z.armR.rotation.z = 0.12;
  z.root.position.copy(z.pos);
  z.root.rotation.y = z.heading;
  z.groanT -= dt;
  if (z.groanT <= 0) {
    z.groanT = 3 + Math.random() * 7;
    if (dist < 40) sound.groan(z.pos, z.sprinter ? 1.25 : 0.9 + Math.random() * 0.25);
  }
}

function respawn(z) {
  const px = camera.position.x, py = -camera.position.z;
  for (let tries = 0; tries < 30; tries++) {
    const c = spawnCandidates[(Math.random() * spawnCandidates.length) | 0];
    const d = Math.hypot(c.x - px, c.y - py);
    if (d > 15 && d < 40 && flow[c.c] >= 0) {
      z.pos.copy(P(c.x, c.y, c.z));
      z.state = 'rising';
      z.t = 0;
      return;
    }
  }
}

function killZombie(z, headshot, knife) {
  z.state = 'dead';
  z.t = 0;
  z.deathDir = Math.random() < 0.8 ? 1 : -1;
  if (headshot) {
    z.head.visible = false;
    blood(_tmp.copy(z.pos).setY(z.pos.y + 1.75), 40, 3);
  }
  refreshHitMeshes();
  stats.kills++;
  if (headshot) stats.headshots++;
  addPoints(knife ? 130 : headshot ? 100 : 60, true);
  if (drops.length < 2 && Math.random() < 0.045) spawnDrop(z.pos, Math.random() < 0.7 ? 'ammo' : 'insta');
  call(hooks.kill, z, headshot, knife);
}

// ------------------------------------------------------------------ particles (blood, dust, sparks)
const PART_N = 600;
const partGeo = new THREE.BufferGeometry();
const partPos = new Float32Array(PART_N * 3), partCol = new Float32Array(PART_N * 3);
const partVel = new Float32Array(PART_N * 3), partLife = new Float32Array(PART_N);
partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
partGeo.setAttribute('color', new THREE.BufferAttribute(partCol, 3));
const parts = new THREE.Points(partGeo, new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, depthWrite: false }));
parts.frustumCulled = false;
scene.add(parts);
let partNext = 0;
for (let i = 0; i < PART_N; i++) partPos[i * 3 + 1] = -999;

function emit(p, n, rgb, speed, up, life) {
  for (let k = 0; k < n; k++) {
    const i = partNext++ % PART_N;
    partPos.set([p.x, p.y, p.z], i * 3);
    partVel.set([(Math.random() - 0.5) * speed, Math.random() * up, (Math.random() - 0.5) * speed], i * 3);
    const v = 0.7 + Math.random() * 0.6;
    partCol.set([rgb[0] * v, rgb[1] * v, rgb[2] * v], i * 3);
    partLife[i] = life * (0.6 + Math.random() * 0.6);
  }
}
const blood = (p, n = 14, sp = 2) => emit(p, n, [0.45, 0.02, 0.02], sp, sp * 0.9, 0.9);
const dust = (p, n = 6) => emit(p, n, [0.22, 0.17, 0.11], 1.2, 1.4, 1.1);
const sparks = (p) => emit(p, 6, [1.0, 0.7, 0.35], 2.5, 2.0, 0.25);

function updateParticles(dt) {
  for (let i = 0; i < PART_N; i++) {
    if (partLife[i] <= 0) continue;
    partLife[i] -= dt;
    const o = i * 3;
    partVel[o + 1] -= 9.8 * dt;
    partPos[o] += partVel[o] * dt;
    partPos[o + 1] += partVel[o + 1] * dt;
    partPos[o + 2] += partVel[o + 2] * dt;
    if (partLife[i] <= 0) partPos[o + 1] = -999;
  }
  partGeo.attributes.position.needsUpdate = true;
  partGeo.attributes.color.needsUpdate = true;
}

// ------------------------------------------------------------------ power-ups
const drops = [];
const dropGeo = new THREE.BoxGeometry(0.5, 0.32, 0.32);
const dropMat = {
  ammo: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 0.6) }),
  insta: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.4, 2.4) }),
};
const dropGlow = new THREE.SpriteMaterial({ map: glowTexture('rgba(190,255,170,0.9)', 'rgba(60,255,90,0.25)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
let instaUntil = 0;

function spawnDrop(pos, kind) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(dropGeo, dropMat[kind]);
  const glow = new THREE.Sprite(dropGlow);
  glow.scale.setScalar(1.8);
  g.add(box, glow);
  if (kind === 'insta') {
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.2), ZM.gore);
    skull.position.y = 0.3;
    g.add(skull);
  }
  g.position.copy(pos).setY(pos.y + 0.8);
  scene.add(g);
  drops.push({ mesh: g, box, kind, t: 0 });
}

function updateDrops(dt, t) {
  const pp = player.collider.start;
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.t += dt;
    d.box.rotation.y += dt * 1.5;
    d.mesh.position.y += Math.sin(t * 3) * 0.002;
    d.mesh.visible = d.t < 22 || Math.sin(d.t * 18) > 0;
    const close = Math.hypot(pp.x - d.mesh.position.x, pp.z - d.mesh.position.z) < 1.4;
    if (close || d.t > 28) {
      scene.remove(d.mesh);
      drops.splice(i, 1);
      if (!close) continue;
      sound.powerup();
      if (d.kind === 'ammo') {
        weapon.reserve = weapon.reserveMax;
        weapon.mag = weapon.magSize;
        for (const k in GUNS) if (k !== weapon.gun) AMMO[k] = { mag: GUNS[k].magSize, reserve: GUNS[k].reserveMax };
        message('MAX AMMO', true);
        sound.say('Max Ammo');
      } else {
        instaUntil = t + 30;
        message('INSTA-KILL', true);
        sound.say('Insta Kill');
      }
      updateAmmoHud();
    }
  }
  const pu = $('powerups');
  const label = instaUntil > t ? `Insta-kill ${Math.ceil(instaUntil - t)}` : '';
  if (pu.textContent !== label) pu.innerHTML = label ? `<div>${label}</div>` : '';
}

// ------------------------------------------------------------------ weapon
// Two guns: the carbine you start with and a bolt-action sniper (keys 1/2 or mouse wheel).
const GUNS = {
  carbine: { name: 'Wakatipu Carbine', magSize: 30, reserveMax: 270, rate: 0.095, dmg: 70, reloadTime: 2.1,
    adsFov: 52, spread: [0.014, 0.03, 0.002], kick: 0.011, pierce: 1, auto: true, scope: false },
  sniper: { name: 'Remarkables .338', magSize: 5, reserveMax: 40, rate: 1.25, dmg: 900, reloadTime: 2.8,
    adsFov: 9, spread: [0.05, 0.09, 0], kick: 0.05, pierce: 4, auto: false, scope: true },
};
const AMMO = { carbine: { mag: 30, reserve: 210 }, sniper: { mag: 5, reserve: 25 } };
const weapon = {
  gun: 'carbine', ...GUNS.carbine, ...AMMO.carbine, cd: 0, reloading: 0,
  firing: false, ads: false, adsK: 0, flash: 0, knife: 0, recoil: 0, swap: 0,
};
const view = new THREE.Group();
const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
const muzzleLight = new THREE.PointLight(0xffb060, 0, 14, 1.5);
scene.add(muzzleLight);
const knifeMesh = new THREE.Group();

function buildViewModel() {
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a3d43, roughness: 0.45, metalness: 0.15 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x4e331e, roughness: 0.55 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x23201d, roughness: 0.9 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x3c4232, roughness: 1 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    view.add(m);
    return m;
  };
  // An M1-carbine-ish rifle: long walnut stock, blued receiver, thin barrel.
  add(new THREE.BoxGeometry(0.05, 0.07, 0.6), wood, 0, -0.012, -0.02);
  add(new THREE.BoxGeometry(0.048, 0.13, 0.2), wood, 0, -0.06, 0.24, 0.12);
  add(new THREE.BoxGeometry(0.04, 0.09, 0.05), wood, 0, -0.065, 0.1, -0.4);
  add(new THREE.BoxGeometry(0.042, 0.042, 0.22), metal, 0, 0.034, -0.02);
  add(new THREE.CylinderGeometry(0.011, 0.011, 0.32, 10), metal, 0, 0.03, -0.46, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.025, 12), metal, 0, 0.0, -0.3, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 10), metal, 0, 0.03, -0.615, Math.PI / 2);
  add(new THREE.BoxGeometry(0.034, 0.11, 0.065), metal, 0, -0.085, -0.03, 0.08);
  add(new THREE.BoxGeometry(0.006, 0.03, 0.008), metal, 0, 0.052, -0.6);
  add(new THREE.BoxGeometry(0.005, 0.016, 0.01), metal, -0.01, 0.06, 0.07);
  add(new THREE.BoxGeometry(0.005, 0.016, 0.01), metal, 0.01, 0.06, 0.07);
  add(new THREE.BoxGeometry(0.012, 0.02, 0.05), metal, 0.026, 0.035, 0.02);
  add(new THREE.BoxGeometry(0.07, 0.06, 0.1), glove, -0.012, -0.05, -0.24, 0.15, 0, 0.15);
  add(new THREE.BoxGeometry(0.08, 0.08, 0.34), sleeve, -0.07, -0.11, -0.08, 0.32, -0.45, 0);
  add(new THREE.BoxGeometry(0.06, 0.07, 0.09), glove, 0.012, -0.075, 0.1, -0.3);
  add(new THREE.BoxGeometry(0.085, 0.085, 0.3), sleeve, 0.05, -0.12, 0.26, -0.35, 0.15, 0);
  carbineParts.push(...view.children);
  buildSniperModel(metal, wood, glove, sleeve);
  muzzle.position.set(0, 0.03, -0.66);
  muzzle.scale.setScalar(0.2);
  muzzle.visible = false;
  view.add(muzzle);
  showGun('carbine');
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.22), new THREE.MeshStandardMaterial({ color: 0xb8b8b8, metalness: 0.9, roughness: 0.25 }));
  blade.position.z = -0.14;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.1), glove);
  knifeMesh.add(blade, handle);
  knifeMesh.visible = false;
  wcam.add(knifeMesh);
  wcam.add(view);
  wscene.add(new THREE.HemisphereLight(0x8890b0, 0x201818, 1.0));
  const key = new THREE.DirectionalLight(0xffe2cc, 1.0);
  key.position.set(-1, 1, 0.5);
  wscene.add(key);
  wscene.userData.flash = new THREE.PointLight(0xffb060, 0, 2, 1);
  wscene.userData.flash.position.set(0.1, -0.05, -0.6);
  wscene.add(wscene.userData.flash);
}

const carbineParts = [], sniperParts = [];
const sniperGroup = new THREE.Group();

function buildSniperModel(metal, wood, glove, sleeve) {
  // A long bolt-action with a big scope and a dark synthetic stock.
  const stock = new THREE.MeshStandardMaterial({ color: 0x2a2b25, roughness: 0.7 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    sniperGroup.add(m);
    return m;
  };
  // Slightly smaller and lower than the carbine so the long gun doesn't fill the screen.
  sniperGroup.scale.setScalar(0.72);
  sniperGroup.position.set(0.02, -0.035, -0.02);
  view.add(sniperGroup);
  sniperParts.push(sniperGroup);
  add(new THREE.BoxGeometry(0.055, 0.075, 0.62), stock, 0, -0.015, 0.0);
  add(new THREE.BoxGeometry(0.05, 0.14, 0.22), stock, 0, -0.065, 0.27, 0.1);
  add(new THREE.BoxGeometry(0.044, 0.1, 0.05), stock, 0, -0.075, 0.1, -0.35);
  add(new THREE.BoxGeometry(0.046, 0.046, 0.26), metal, 0, 0.034, -0.01);
  add(new THREE.CylinderGeometry(0.013, 0.015, 0.62, 12), metal, 0, 0.032, -0.6, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.022, 0.022, 0.07, 12), metal, 0, 0.032, -0.93, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.3, 16), metal, 0, 0.1, -0.02, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.036, 0.026, 0.08, 16), metal, 0, 0.1, -0.2, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.032, 0.026, 0.06, 16), metal, 0, 0.1, 0.15, Math.PI / 2);
  add(new THREE.BoxGeometry(0.016, 0.05, 0.02), metal, 0, 0.065, -0.07);
  add(new THREE.BoxGeometry(0.016, 0.05, 0.02), metal, 0, 0.065, 0.06);
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 8), metal, 0.045, 0.035, 0.07, 0, 0, Math.PI / 2);
  add(new THREE.SphereGeometry(0.013, 8, 8), metal, 0.075, 0.035, 0.07);
  add(new THREE.BoxGeometry(0.07, 0.06, 0.1), glove, -0.012, -0.05, -0.26, 0.15, 0, 0.15);
  add(new THREE.BoxGeometry(0.08, 0.08, 0.34), sleeve, -0.07, -0.11, -0.1, 0.32, -0.45, 0);
  add(new THREE.BoxGeometry(0.06, 0.07, 0.09), glove, 0.012, -0.08, 0.1, -0.3);
  add(new THREE.BoxGeometry(0.085, 0.085, 0.3), sleeve, 0.05, -0.125, 0.26, -0.35, 0.15, 0);
}

function showGun(name) {
  for (const p of carbineParts) p.visible = name === 'carbine';
  for (const p of sniperParts) p.visible = name === 'sniper';
  muzzle.position.set(0, 0.032, name === 'sniper' ? -0.98 : -0.66);
}

function switchGun(name) {
  if (name === weapon.gun || weapon.reloading > 0 || weapon.knife > 0) return;
  AMMO[weapon.gun] = { mag: weapon.mag, reserve: weapon.reserve };
  Object.assign(weapon, GUNS[name], AMMO[name], { gun: name, cd: 0.45, swap: 0.45, firing: false });
  showGun(name);
  sound.reload();
  $('weapon-name').textContent = weapon.name;
  updateAmmoHud();
}

const HIP = new V3(0.15, -0.16, -0.32), ADS = new V3(0, -0.062, -0.44);
const raycaster = new THREE.Raycaster();
const _dir = new V3(), _orig = new V3();

function fire(t) {
  if (weapon.mag <= 0) {
    sound.click(900, 0, 0.3);
    weapon.cd = 0.25;
    if (weapon.reserve > 0) startReload();
    return;
  }
  weapon.mag--;
  weapon.cd = weapon.rate;
  weapon.flash = 0.05;
  weapon.recoil = 1;
  stats.shots++;
  call(hooks.shot, weapon.gun);
  if (GUNS[weapon.gun].fire) {
    // Guns with their own behaviour (projectiles, pellets…) take over from here.
    GUNS[weapon.gun].fire(t);
    updateAmmoHud();
    if (!weapon.auto) weapon.firing = false;
    return;
  }
  if (weapon.gun === 'sniper') sound.sniper();
  else sound.shot();
  if (!weapon.auto) weapon.firing = false;
  const moving = Math.hypot(player.vel.x, player.vel.z) > 1;
  const spread = weapon.ads ? weapon.spread[2] : moving ? weapon.spread[1] : weapon.spread[0];
  camera.getWorldDirection(_dir);
  _dir.x += (Math.random() - 0.5) * spread;
  _dir.y += (Math.random() - 0.5) * spread;
  _dir.z += (Math.random() - 0.5) * spread;
  _dir.normalize();
  _orig.copy(camera.position);
  _ray.origin.copy(_orig);
  _ray.direction.copy(_dir);
  const wall = world.octree.rayIntersect(_ray);
  const wallDist = wall ? wall.distance : 400;
  raycaster.set(_orig, _dir);
  raycaster.far = wallDist;
  const hits = raycaster.intersectObjects(hitMeshes, false);
  if (hits.length) {
    // The sniper round carries on through several zombies in a line.
    const done = new Set();
    for (const h of hits) {
      const z = h.object.userData.z;
      if (done.has(z)) continue;
      done.add(z);
      const head = h.object.userData.head;
      damageZombie(z, weapon.dmg * (head ? 3 : 1), head, false, h.point);
      if (done.size >= weapon.pierce) break;
    }
    if (done.size > 1) message(done.size + ' FOR 1', false);
  } else if (wall) {
    sparks(wall.position);
    dust(wall.position, 3);
  }
  player.pitch = Math.min(1.45, player.pitch + (weapon.ads ? weapon.kick * 0.55 : weapon.kick));
  player.yaw += (Math.random() - 0.5) * 0.006;
  updateAmmoHud();
  if (weapon.mag === 0 && weapon.reserve > 0) setTimeout(() => startReload(), 180);
}

function damageZombie(z, dmg, head, knife, point) {
  if (!z || z.state === 'dead') return;
  if (instaUntil > clock.elapsedTime) dmg = 1e6;
  call(hooks.zombieDamage, z, dmg, head, knife, point);
  z.hp -= dmg;
  z.stagger = 0.18;
  blood(point, head ? 18 : 10, head ? 2.6 : 1.8);
  stats.hits++;
  hitmark(z.hp <= 0);
  sound.hit(z.hp <= 0);
  if (z.hp <= 0) killZombie(z, head, knife);
  else addPoints(10);
}

function knife() {
  if (weapon.knife > 0 || weapon.reloading > 0) return;
  weapon.knife = 0.45;
  sound.knife();
  camera.getWorldDirection(_dir);
  raycaster.set(camera.position, _dir);
  raycaster.far = 1.9;
  let hits = raycaster.intersectObjects(hitMeshes, false);
  if (!hits.length) {
    // Generous melee: anything right in front of you.
    for (const z of zombies) {
      if (z.state === 'dead' || z.state === 'rising') continue;
      _tmp.copy(z.pos).setY(z.pos.y + 1.2).sub(camera.position);
      if (_tmp.length() < 1.8 && _tmp.normalize().dot(_dir) > 0.6) {
        hits = [{ object: z.parts[3], point: _tmp2.copy(z.pos).setY(z.pos.y + 1.2) }];
        break;
      }
    }
  }
  if (hits.length) {
    sound.thud(0.5);
    damageZombie(hits[0].object.userData.z, 150, false, true, hits[0].point);
  }
}

function startReload() {
  if (weapon.reloading > 0 || weapon.mag === weapon.magSize || weapon.reserve <= 0) return;
  weapon.reloading = weapon.reloadTime;
  sound.reload();
}

function updateWeapon(dt, t) {
  weapon.cd -= dt;
  weapon.knife = Math.max(0, weapon.knife - dt);
  if (weapon.reloading > 0) {
    weapon.reloading -= dt;
    if (weapon.reloading <= 0) {
      const take = Math.min(weapon.magSize - weapon.mag, weapon.reserve);
      weapon.mag += take;
      weapon.reserve -= take;
      updateAmmoHud();
    }
  } else if (weapon.firing && weapon.cd <= 0 && weapon.knife <= 0) fire(t);
  weapon.adsK += ((weapon.ads && weapon.reloading <= 0 && weapon.swap <= 0 ? 1 : 0) - weapon.adsK) * Math.min(1, dt * (weapon.scope ? 9 : 14));
  weapon.swap = Math.max(0, weapon.swap - dt);
  const scoped = weapon.scope && weapon.adsK > 0.85;
  camera.fov = 74 - (74 - weapon.adsFov) * (weapon.scope ? (scoped ? 1 : weapon.adsK * 0.3) : weapon.adsK);
  wcam.fov = 58 - 14 * weapon.adsK;
  view.visible = !scoped;
  $('scope').classList.toggle('on', scoped);
  if (scoped) {
    // Scope sway; hold Shift to steady your breath.
    const k = keys.ShiftLeft || keys.ShiftRight ? 0.15 : 1;
    player.yaw += Math.sin(t * 0.9) * 0.00028 * k;
    player.pitch += Math.cos(t * 1.3) * 0.00022 * k;
  }
  camera.updateProjectionMatrix();
  wcam.updateProjectionMatrix();
  $('crosshair').classList.toggle('ads', weapon.adsK > 0.5);
  // Bob, recoil and reload pose.
  const speed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onFloor) player.bob += dt * speed * 2.1;
  const bobAmt = (1 - weapon.adsK * 0.85) * Math.min(1, speed / 5);
  view.position.lerpVectors(HIP, ADS, weapon.adsK);
  view.position.x += Math.sin(player.bob) * 0.012 * bobAmt;
  view.position.y += -Math.abs(Math.cos(player.bob)) * 0.012 * bobAmt;
  weapon.recoil = Math.max(0, weapon.recoil - dt * 9);
  view.position.z += weapon.recoil * 0.045;
  view.rotation.x = weapon.recoil * 0.08;
  if (weapon.reloading > 0) {
    const k = 1 - weapon.reloading / weapon.reloadTime, dip = Math.sin(Math.min(1, k) * Math.PI);
    view.rotation.x = -0.6 * dip;
    view.rotation.z = 0.5 * dip;
    view.position.y -= 0.12 * dip;
  } else view.rotation.z = 0;
  if (weapon.swap > 0) view.position.y -= Math.sin((weapon.swap / 0.45) * Math.PI) * 0.2;
  if (weapon.gun === 'sniper' && weapon.cd > 0.3 && weapon.mag > 0) {
    // Work the bolt between shots.
    const b = Math.sin(((weapon.rate - weapon.cd) / (weapon.rate - 0.3)) * Math.PI);
    view.rotation.z = 0.25 * b;
    view.position.y -= 0.04 * b;
  }
  const kk = weapon.knife > 0 ? Math.sin((1 - weapon.knife / 0.45) * Math.PI) : 0;
  knifeMesh.visible = kk > 0;
  knifeMesh.position.set(0.05 - 0.05 * kk, -0.15 + 0.05 * kk, -0.3 - 0.3 * kk);
  knifeMesh.rotation.set(0, 0.3, 0);
  view.position.y -= kk * 0.25;
  weapon.flash -= dt;
  const flashOn = weapon.flash > 0;
  muzzle.visible = flashOn;
  if (flashOn) muzzle.material.rotation = Math.random() * 6.28;
  muzzleLight.intensity = flashOn ? 40 : 0;
  muzzleLight.position.copy(camera.position).addScaledVector(_dir.set(0, 0, -1).applyQuaternion(camera.quaternion), 1);
  wscene.userData.flash.intensity = flashOn ? 3 : 0;
}

// ------------------------------------------------------------------ HUD
const stats = { points: 500, kills: 0, headshots: 0, shots: 0, hits: 0 };
let hudPoints = -1;
function addPoints(n, big) {
  stats.points += n;
  $('points').textContent = stats.points;
  const f = document.createElement('span');
  f.textContent = '+' + n;
  if (big) f.className = 'big';
  f.style.right = (Math.random() * 30) + 'px';
  $('floats').appendChild(f);
  setTimeout(() => f.remove(), 1000);
}

function updateAmmoHud() {
  $('mag').textContent = weapon.mag;
  $('mag').classList.toggle('low', weapon.mag <= Math.ceil(weapon.magSize / 5));
  $('reserve').textContent = weapon.reserve;
}

function drawTally(n) {
  const svg = $('tally'), num = $('round-num');
  if (n <= 5) {
    num.textContent = '';
    svg.style.display = '';
    let d = '';
    for (let i = 0; i < Math.min(n, 4); i++) d += `M${22 + i * 30} ${16 + (i % 2) * 4} L${18 + i * 30} 106 `;
    if (n === 5) d += 'M6 84 L132 30';
    svg.innerHTML = `<path d="${d}"/>`;
  } else {
    svg.style.display = 'none';
    num.textContent = n;
  }
  const r = $('round');
  r.classList.remove('flash');
  void r.offsetWidth;
  r.classList.add('flash');
}

let msgTimer = 0;
function message(text, green = false, secs = 2.6) {
  const m = $('message');
  m.textContent = text;
  m.classList.toggle('green', green);
  m.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => m.classList.remove('show'), secs * 1000);
}

let hintTimer = 0;
function hint(text, secs = 4) {
  const h = $('hint');
  h.textContent = text;
  h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove('show'), secs * 1000);
}

function hitmark(kill) {
  const h = $('hitmarker');
  h.classList.remove('show', 'kill');
  void h.offsetWidth;
  h.classList.add('show');
  if (kill) h.classList.add('kill');
}

let roomTimer = 0, roomName = '';
function updateRoom() {
  const x = camera.position.x, y = -camera.position.z, c = cellOf(x, -y);
  const inside = c >= 0 && indoor[c];
  let best = null, bd = 1e9;
  for (const r of ROOMS) {
    if (!!r.outdoor === inside) continue;
    if (r.level && camera.position.y < 2.5) continue;
    const d = Math.hypot(r.at[0] - x, r.at[1] - y);
    if (d < bd) { bd = d; best = r; }
  }
  const name = inside ? (best ? best.name : 'Hallway') : best && bd < 12 ? best.name : bd < 40 ? 'The Garden' : 'The Tussock';
  if (name !== roomName) {
    roomName = name;
    $('room-name').textContent = name;
  }
}

let heartT = 0;
let god = false;
function damagePlayer(n, source) {
  if (state !== 'playing' || god) return;
  call(hooks.playerDamage, n, source);
  player.health -= n;
  player.lastHit = clock.elapsedTime;
  sound.hurt();
  $('hurt').style.opacity = 1;
  setTimeout(() => ($('hurt').style.opacity = 0), 120);
  player.pitch += 0.03;
  if (player.health <= 0) gameOver();
}

function updateHealth(dt, t) {
  if (t - player.lastHit > 3.5) player.health = Math.min(100, player.health + 45 * dt);
  const k = 1 - player.health / 100;
  $('vignette').style.opacity = Math.min(1, k * 1.25).toFixed(3);
  if (player.health < 45) {
    heartT -= dt;
    if (heartT <= 0) {
      heartT = 0.75 + player.health / 80;
      sound.heartbeat();
    }
  }
}

// ------------------------------------------------------------------ game flow
const sound = new Sound();
const clock = new THREE.Clock();
let state = 'loading', freeLook = false, mouseX = 0.5;

function resetGame() {
  for (const z of zombies) scene.remove(z.root);
  zombies.length = 0;
  for (const d of drops) scene.remove(d.mesh);
  drops.length = 0;
  refreshHitMeshes();
  Object.assign(stats, { points: 500, kills: 0, headshots: 0, shots: 0, hits: 0 });
  AMMO.carbine = { mag: 30, reserve: 210 };
  AMMO.sniper = { mag: 5, reserve: 25 };
  Object.assign(weapon, GUNS.carbine, AMMO.carbine, { gun: 'carbine', reloading: 0, firing: false, ads: false, swap: 0 });
  showGun('carbine');
  $('weapon-name').textContent = weapon.name;
  player.health = 100;
  instaUntil = 0;
  placePlayer(SPAWN.x, SPAWN.y, SPAWN.yaw);
  Object.assign(ROUND, { n: 0, toSpawn: 0, spawnT: 0, between: 3, active: false });
  $('points').textContent = stats.points;
  updateAmmoHud();
  drawTally(0);
  flowSource = -2;
  call(hooks.reset);
}

function begin() {
  sound.start();
  if (state === 'over' || state === 'menu') resetGame();
  state = 'playing';
  $('overlay').hidden = true;
  $('hud').hidden = false;
  lockPointer();
  clock.getDelta();
}

function lockPointer() {
  if (freeLook) return;
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => enterFreeLook());
  } catch {
    enterFreeLook();
  }
}

function enterFreeLook() {
  if (freeLook) return;
  freeLook = true;
  hint('Mouse lock is blocked in this frame: move the mouse to look, push to the screen edges to turn (or Q/E). Open the page in its own tab for full mouse lock.', 8);
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  weapon.firing = false;
  sound.suspend();
  showOverlay('Paused', 'Click to resume');
}

function gameOver() {
  state = 'over';
  weapon.firing = false;
  if (document.pointerLockElement) document.exitPointerLock();
  sound.setDrone(0);
  const acc = stats.shots ? Math.round((stats.hits / stats.shots) * 100) : 0;
  const rounds = Math.max(0, ROUND.n - (ROUND.active ? 1 : 0));
  showOverlay('Game over', 'Click to play again',
    `<strong>You survived ${rounds} round${rounds === 1 ? '' : 's'}</strong>${stats.kills} kills &middot; ${stats.headshots} headshots &middot; ${stats.points} points &middot; ${acc}% accuracy`);
}

function showOverlay(status, button, summary = '') {
  $('overlay').hidden = false;
  $('status').textContent = status;
  $('bar').style.display = 'none';
  $('play').textContent = button;
  $('play').hidden = false;
  $('summary').hidden = !summary;
  $('summary').innerHTML = summary;
}

function startRound(n) {
  ROUND.n = n;
  ROUND.toSpawn = zombiesForRound(n);
  ROUND.spawnT = 1.5;
  ROUND.active = true;
  drawTally(n);
  sound.roundStart();
  sound.setDrone(Math.min(0.05, 0.015 + n * 0.004));
  message(n === 1 ? 'They are coming' : `Round ${n}`, false, 3);
  call(hooks.round, n);
}

function updateRound(dt) {
  const alive = zombies.reduce((a, z) => a + (z.state !== 'dead' ? 1 : 0), 0);
  if (!ROUND.active) {
    ROUND.between -= dt;
    if (ROUND.between <= 0) startRound(ROUND.n + 1);
    return;
  }
  ROUND.spawnT -= dt;
  if (ROUND.toSpawn > 0 && alive < 24 && ROUND.spawnT <= 0 && spawnCandidates.length) {
    spawnZombie();
    ROUND.toSpawn--;
    ROUND.spawnT = Math.max(0.5, 2.2 - ROUND.n * 0.15) * (0.6 + Math.random() * 0.8);
  }
  if (ROUND.toSpawn === 0 && alive === 0) {
    ROUND.active = false;
    ROUND.between = 9;
    call(hooks.roundEnd, ROUND.n);
    sound.roundEnd();
    sound.setDrone(0.008);
    message(`Round ${ROUND.n} survived`, false, 3);
  }
}

// ------------------------------------------------------------------ input
document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (state !== 'playing') return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Digit1') switchGun('carbine');
  if (e.code === 'Digit2') switchGun('sniper');
  if (e.code === 'KeyV' || e.code === 'KeyF') knife();
  if (e.code === 'KeyM') mini.canvas.classList.toggle('off');
  if (e.code === 'Escape' || e.code === 'KeyP') pause();
  if (e.code === 'Space') e.preventDefault();
  call(hooks.key, e.code, e);
});
document.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (state === 'playing') call(hooks.keyup, e.code, e);
});
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  pause();
});
document.addEventListener('mousemove', (e) => {
  mouseX = e.clientX / window.innerWidth;
  if (state !== 'playing') return;
  if (!freeLook && document.pointerLockElement !== renderer.domElement) return;
  const sens = 0.0021 * Math.min(1 - weapon.adsK * 0.45, camera.fov / 60);
  player.yaw -= e.movementX * sens;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - e.movementY * sens));
});
renderer.domElement.addEventListener('mousedown', (e) => {
  if (state !== 'playing') return;
  if (!freeLook && document.pointerLockElement !== renderer.domElement) lockPointer();
  if (e.button === 0) weapon.firing = true;
  if (e.button === 2) weapon.ads = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) weapon.firing = false;
  if (e.button === 2) weapon.ads = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if (state === 'playing') switchGun(weapon.gun === 'carbine' ? 'sniper' : 'carbine');
}, { passive: true });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && state === 'playing' && !freeLook) pause();
});
document.addEventListener('pointerlockerror', () => enterFreeLook());
$('play').addEventListener('click', () => begin());
window.addEventListener('resize', () => {
  camera.aspect = wcam.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  wcam.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ main loop
const _look = new V3();
function frame() {
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  swayUniform.value = t;
  SKY.sky.material.uniforms.time.value = t;
  SKY.moon.position.copy(camera.position).addScaledVector(MOON_DIR, 40000);
  SKY.sky.position.copy(camera.position);
  if (world.ready) updateLights(t, dt);
  call(hooks.frame, dt, t, state);

  if (state === 'playing') {
    let turn = (keys.KeyQ || keys.ArrowLeft ? 1 : 0) - (keys.KeyE || keys.ArrowRight ? 1 : 0);
    if (freeLook) turn += mouseX < 0.06 ? 1 : mouseX > 0.94 ? -1 : 0;
    player.yaw += turn * dt * 2.2;
    if (keys.ArrowUp) player.pitch = Math.min(1.5, player.pitch + dt * 1.5);
    if (keys.ArrowDown) player.pitch = Math.max(-1.5, player.pitch - dt * 1.5);
    if (player.control) player.control(dt, t); // e.g. driving a vehicle: owns movement + camera
    else {
      const steps = 5;
      for (let i = 0; i < steps; i++) updatePlayer(dt / steps);
      camera.position.copy(player.collider.end);
      camera.position.y += Math.abs(Math.sin(player.bob)) * 0.03 * (1 - weapon.adsK);
      camera.rotation.set(player.pitch, player.yaw, player.roll || 0);
    }
    const pc = nearestWalkable(cellOf(player.collider.start.x, player.collider.start.z));
    if (pc !== flowSource) {
      flowSource = pc;
      computeFlow(pc);
    }
    updateWeapon(dt, t);
    updateRound(dt);
    for (const z of zombies) updateZombie(z, dt, t);
    for (let i = zombies.length - 1; i >= 0; i--) if (zombies[i].remove) zombies.splice(i, 1);
    updateDrops(dt, t);
    call(hooks.update, dt, t);
    updateHealth(dt, t);
    roomTimer -= dt;
    if (roomTimer <= 0) {
      roomTimer = 0.25;
      updateRoom();
    }
    mini.t -= dt;
    if (mini.t <= 0 && !mini.canvas.classList.contains('off')) {
      mini.t = 1 / 20;
      drawMinimap();
    }
    sound.listener(camera.position, camera.getWorldDirection(_look));
  } else if (state === 'menu' || state === 'loading') {
    const a = t * 0.05 + 2.6;
    camera.position.set(CENTRE.x + Math.sin(a) * 52, 14, CENTRE.z + Math.cos(a) * 52);
    camera.lookAt(CENTRE.x, 1, CENTRE.z);
  }
  updateParticles(dt);
  renderer.clear();
  renderer.render(scene, camera);
  if (state === 'playing' || state === 'paused') {
    renderer.clearDepth();
    renderer.render(wscene, wcam);
  }
  requestAnimationFrame(frame);
}

async function main() {
  const status = $('status'), bar = $('bar-fill');
  const setP = (k, text) => {
    bar.style.width = `${Math.round(k * 100)}%`;
    if (text) status.textContent = text;
  };
  requestAnimationFrame(frame);
  setP(0.05, 'Digging up the house…');
  const gltf = await decodeLevel();
  setP(0.3, 'Pouring the board-formed concrete…');
  await new Promise((r) => setTimeout(r, 0));
  buildLevel(gltf);
  buildVegetation();
  buildLights();
  buildViewModel();
  world.ready = true;
  setP(0.45, 'Walking the plan…');
  await buildGrid((k) => setP(0.45 + k * 0.5));
  buildMinimap();
  prepareSpawns();
  placePlayer(SPAWN.x, SPAWN.y, SPAWN.yaw);
  computeFlow(nearestWalkable(cellOf(player.collider.start.x, player.collider.start.z)));
  call(hooks.ready);
  setP(1, 'Night falls on Drift Bay.');
  $('bar').style.display = 'none';
  $('play').hidden = false;
  state = 'menu';
}

main().catch((e) => {
  console.error(e);
  $('status').textContent = 'Failed to load: ' + e.message;
});

// Test hooks (used by the automated browser check; harmless otherwise).
window.__game = {
  get state() { return state; },
  get zombies() { return zombies.filter((z) => z.state !== 'dead').length; },
  get round() { return ROUND.n; },
  get stats() { return { ...stats, health: player.health, mag: weapon.mag, reserve: weapon.reserve }; },
  get room() { return roomName; },
  begin,
  look(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
  teleport(x, y, yaw = player.yaw) { placePlayer(x, y, yaw); },
  spawn(n) { for (let i = 0; i < n; i++) spawnZombie(); },
  spawnAt(x, y) { spawnZombie({ x, y, z: groundAt(x, -y), c: cellOf(x, -y) }); },
  debugZombies() {
    const p = player.collider.start;
    return zombies.map((z) => ({ st: z.state, d: +Math.hypot(z.pos.x - p.x, z.pos.z - p.z).toFixed(1), x: +z.pos.x.toFixed(1), y: +(-z.pos.z).toFixed(1), flow: flow[nearestWalkable(cellOf(z.pos.x, z.pos.z))] ?? null, sp: +z.speed.toFixed(2) }));
  },
  fire(on) { weapon.firing = on; },
  god(on = true) { god = on; },
  grid: { GRID, walk, indoor, heights },
};

// Everything feature modules may use. Getters for values that are reassigned.
Object.assign(NZ, {
  THREE, V3, P, $, META, ROOMS, CENTRE, SPAWN, Octree, Capsule, mergeGeometries,
  renderer, scene, camera, wscene, wcam, view, world, sound, keys, player, weapon, GUNS, AMMO, ROUND, stats, zombies, drops,
  makeZombie, spawnZombie, killZombie, damageZombie, refreshHitMeshes, damagePlayer, addPoints, message, hint, hitmark,
  emit, blood, dust, sparks, spawnDrop, switchGun, showGun, startReload, updateAmmoHud, groundAt, terrainHeight,
  cellOf, nearestWalkable, computeFlow, nextStep, placePlayer, glowTexture, flashTexture, detailTexture, rng, clock,
  get state() { return state; }, get hitMeshes() { return hitMeshes; }, get flow() { return flow; },
  get walk() { return walk; }, get grid() { return GRID; }, get instaUntil() { return instaUntil; },
  set instaUntil(v) { instaUntil = v; }, get god() { return god; },
});
