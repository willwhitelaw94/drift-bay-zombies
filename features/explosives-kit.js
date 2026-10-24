// Shared FX + audio kit for the explosives features (explosion.js, fire.js, grenades.js).
// Everything here is pooled and allocated once: particles (one additive + one smoke Points
// system with a soft procedural shader), billow/shock sprites, debris chunks, scorch decals,
// light pulses, camera shake, a screen flash and the synthesised sounds.
const NZ = window.NZ;
const { THREE, scene, camera } = NZ;
const V3 = THREE.Vector3;

export const kit = { V3 };
const rand = (a, b) => a + Math.random() * (b - a);
kit.rand = rand;

// ------------------------------------------------------------------ canvas textures
function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const fireTex = canvasTex(128, (g, S) => {
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * 6.28, r = Math.random() * S * 0.22;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r, rr = S * (0.12 + Math.random() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(255,230,160,0.55)');
    gr.addColorStop(0.45, 'rgba(255,120,30,0.35)');
    gr.addColorStop(1, 'rgba(120,20,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  }
});

const ringTex = canvasTex(128, (g, S) => {
  const gr = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.7, 'rgba(255,236,210,0.55)');
  gr.addColorStop(0.85, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
});

const scorchTex = canvasTex(256, (g, S) => {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * 6.28, r = Math.pow(Math.random(), 0.7) * S * 0.36;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r, rr = S * (0.04 + Math.random() * 0.12);
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(8,6,5,0.5)');
    gr.addColorStop(1, 'rgba(8,6,5,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  }
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.42);
  gr.addColorStop(0, 'rgba(4,3,3,0.95)');
  gr.addColorStop(0.55, 'rgba(10,8,6,0.7)');
  gr.addColorStop(1, 'rgba(10,8,6,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  // Radial streaks.
  g.strokeStyle = 'rgba(5,4,3,0.35)';
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * 6.28, r0 = S * 0.12, r1 = S * (0.3 + Math.random() * 0.18);
    g.lineWidth = 1 + Math.random() * 3;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * r0, S / 2 + Math.sin(a) * r0);
    g.lineTo(S / 2 + Math.cos(a) * r1, S / 2 + Math.sin(a) * r1);
    g.stroke();
  }
});
kit.fireTex = fireTex;

// ------------------------------------------------------------------ particles
const VERT = `
attribute float aSize; attribute float aT; attribute float aSeed; attribute float aType;
uniform float uScale; uniform float uFogDensity;
varying float vT; varying float vSeed; varying float vType; varying float vFog;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vT = aT; vSeed = aSeed; vType = aType;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float depth = max(0.05, -mvPosition.z);
  gl_PointSize = aT < 0.0 ? 0.0 : min(480.0, aSize * uScale / depth);
  vFog = exp(-uFogDensity * uFogDensity * depth * depth * 0.6);
  #include <logdepthbuf_vertex>
}`;
const FRAG = `
uniform vec3 uFogColor; uniform float uAdd;
varying float vT; varying float vSeed; varying float vType; varying float vFog;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = gl_PointCoord - 0.5;
  if (vType < 0.5) p = vec2(p.x * 1.3, p.y * 1.08 - 0.02); // flames: a taller, narrower lick
  float d = length(p) * 2.0;
  float a = atan(p.y, p.x);
  float edge = 1.0 - 0.07 * sin(a * 3.0 + vSeed * 40.0 + vT * 4.0) - 0.05 * sin(a * 7.0 - vSeed * 17.0);
  float m = smoothstep(edge, 0.0, d);
  m *= m;
  if (m <= 0.002) discard;
  vec3 col; float alpha;
  if (vType < 0.5) {            // flame
    col = mix(vec3(1.0, 0.86, 0.5), vec3(1.0, 0.36, 0.05), smoothstep(0.0, 0.4, vT));
    col = mix(col, vec3(0.3, 0.05, 0.015), smoothstep(0.4, 1.0, vT));
    col *= 0.55 + (1.0 - d) * 0.9;
    alpha = m * 0.8 * (1.0 - vT) * smoothstep(0.0, 0.06, vT + 0.01);
  } else if (vType < 1.5) {     // ember / spark
    col = vec3(1.0, 0.62, 0.22) * 2.2;
    alpha = smoothstep(1.0, 0.0, d) * (1.0 - vT * vT);
  } else if (vType < 2.5) {     // smoke
    col = vec3(0.075, 0.068, 0.064) * (0.75 + vSeed * 0.6);
    alpha = m * 0.6 * smoothstep(0.0, 0.1, vT) * (1.0 - vT);
  } else if (vType < 3.5) {     // dust
    col = vec3(0.26, 0.21, 0.15) * (0.8 + vSeed * 0.4);
    alpha = m * 0.55 * smoothstep(0.0, 0.08, vT) * (1.0 - vT);
  } else {                      // glass glint
    col = vec3(0.75, 0.95, 1.0) * 1.6;
    alpha = smoothstep(1.0, 0.0, d) * (1.0 - vT) * (0.5 + 0.5 * sin(vT * 40.0 + vSeed * 30.0));
  }
  if (uAdd > 0.5) col *= vFog * alpha; else col = mix(uFogColor, col, vFog);
  gl_FragColor = vec4(col, uAdd > 0.5 ? 1.0 : alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class ParticlePool {
  constructor(n, additive) {
    this.n = n;
    this.next = 0;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.size = new Float32Array(n);
    this.t = new Float32Array(n).fill(-1);
    this.seed = new Float32Array(n);
    this.type = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.seed[i] = Math.random();
      this.pos[i * 3 + 1] = -9999;
    }
    const g = new THREE.BufferGeometry();
    const dyn = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(this.pos, 3));
    g.setAttribute('aSize', dyn(this.size, 1));
    g.setAttribute('aT', dyn(this.t, 1));
    g.setAttribute('aType', dyn(this.type, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uFogDensity: { value: scene.fog ? scene.fog.density : 0 },
        uFogColor: { value: scene.fog ? scene.fog.color : new THREE.Color() }, uAdd: { value: additive ? 1 : 0 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, type, grav = 0, drag = 0) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    const o = i * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.size[i] = s0;
    this.type[i] = type;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.t[i] = 0;
  }

  update(dt) {
    const { pos, vel, t } = this;
    for (let i = 0; i < this.n; i++) {
      if (t[i] < 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        t[i] = -1;
        pos[i * 3 + 1] = -9999;
        continue;
      }
      const o = i * 3, k = this.drag[i] > 0 ? Math.exp(-this.drag[i] * dt) : 1;
      vel[o] *= k;
      vel[o + 1] = vel[o + 1] * k + this.grav[i] * dt;
      vel[o + 2] *= k;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      const f = this.age[i] / this.life[i];
      t[i] = f;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * f;
    }
    const a = this.geo.attributes;
    a.position.needsUpdate = a.aSize.needsUpdate = a.aT.needsUpdate = a.aType.needsUpdate = true;
  }

  clear() {
    this.t.fill(-1);
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = -9999;
  }
}

kit.glow = new ParticlePool(2600, true); // flames (0), embers (1), glass glints (4)
kit.smoke = new ParticlePool(900, false); // smoke (2), dust (3)
kit.T = { FLAME: 0, EMBER: 1, SMOKE: 2, DUST: 3, GLASS: 4 };

// ------------------------------------------------------------------ sprites (fireball billows + shock ring)
function spritePool(n, map, blending) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, blending, transparent: true, depthWrite: false, opacity: 0 }));
    s.visible = false;
    s.renderOrder = 7;
    s.userData = { age: 0, life: 1, s0: 1, s1: 1, vy: 0, spin: 0, peak: 1 };
    scene.add(s);
    list.push(s);
  }
  return { list, next: 0 };
}
const billows = spritePool(20, fireTex, THREE.AdditiveBlending);
const shocks = spritePool(4, ringTex, THREE.AdditiveBlending);

function useSprite(pool, x, y, z, s0, s1, life, peak, vy = 0, spin = 0) {
  const s = pool.list[pool.next];
  pool.next = (pool.next + 1) % pool.list.length;
  s.position.set(x, y, z);
  Object.assign(s.userData, { age: 0, life, s0, s1, vy, spin, peak });
  s.material.rotation = Math.random() * 6.28;
  s.scale.setScalar(s0);
  s.visible = true;
  return s;
}
kit.billow = (x, y, z, s0, s1, life, vy = 1.5) => useSprite(billows, x, y, z, s0, s1, life, 1, vy, rand(-2, 2));
kit.shock = (x, y, z, s1, life = 0.22) => useSprite(shocks, x, y, z, 0.4, s1, life, 0.32);

function updateSprites(pool, dt, ease) {
  for (const s of pool.list) {
    if (!s.visible) continue;
    const u = s.userData;
    u.age += dt;
    if (u.age >= u.life) {
      s.visible = false;
      continue;
    }
    const k = u.age / u.life, e = ease(k);
    s.scale.setScalar(u.s0 + (u.s1 - u.s0) * e);
    s.position.y += u.vy * dt;
    s.material.rotation += u.spin * dt;
    s.material.opacity = u.peak * (1 - k) * (1 - k);
  }
}

// ------------------------------------------------------------------ debris chunks
const DEBRIS_N = 140;
const debris = {
  mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 1 }), DEBRIS_N),
  pos: new Float32Array(DEBRIS_N * 3), vel: new Float32Array(DEBRIS_N * 3), rot: new Float32Array(DEBRIS_N * 3),
  spin: new Float32Array(DEBRIS_N * 3), life: new Float32Array(DEBRIS_N), size: new Float32Array(DEBRIS_N),
  floor: new Float32Array(DEBRIS_N), smoky: new Uint8Array(DEBRIS_N), next: 0,
};
debris.mesh.frustumCulled = false;
debris.mesh.castShadow = true;
const _dummy = new THREE.Object3D();
_dummy.scale.setScalar(0);
_dummy.updateMatrix();
for (let i = 0; i < DEBRIS_N; i++) debris.mesh.setMatrixAt(i, _dummy.matrix);
const debrisCol = new THREE.Color();
for (let i = 0; i < DEBRIS_N; i++) debris.mesh.setColorAt(i, debrisCol.setHSL(0.07, 0.25, 0.12 + Math.random() * 0.18));
scene.add(debris.mesh);

kit.debris = (x, y, z, vx, vy, vz, size, floorY, smoky) => {
  const i = debris.next;
  debris.next = (i + 1) % DEBRIS_N;
  const o = i * 3;
  debris.pos[o] = x; debris.pos[o + 1] = y; debris.pos[o + 2] = z;
  debris.vel[o] = vx; debris.vel[o + 1] = vy; debris.vel[o + 2] = vz;
  for (let k = 0; k < 3; k++) {
    debris.rot[o + k] = Math.random() * 6;
    debris.spin[o + k] = rand(-14, 14);
  }
  debris.life[i] = rand(2.5, 4);
  debris.size[i] = size;
  debris.floor[i] = floorY;
  debris.smoky[i] = smoky ? 1 : 0;
};

function updateDebris(dt) {
  const { pos, vel, rot, spin } = debris;
  let dirty = false;
  for (let i = 0; i < DEBRIS_N; i++) {
    if (debris.life[i] <= 0) continue;
    dirty = true;
    debris.life[i] -= dt;
    const o = i * 3;
    vel[o + 1] -= 16 * dt;
    pos[o] += vel[o] * dt;
    pos[o + 1] += vel[o + 1] * dt;
    pos[o + 2] += vel[o + 2] * dt;
    const fl = debris.floor[i] + debris.size[i] * 0.5;
    if (pos[o + 1] < fl) {
      pos[o + 1] = fl;
      if (vel[o + 1] < -1.5) {
        vel[o + 1] *= -0.3;
        if (Math.random() < 0.5) kit.smoke.emit(pos[o], fl, pos[o + 2], 0, 0.3, 0, 0.6, 0.15, 0.5, 3, 0, 1);
      } else vel[o + 1] = 0;
      vel[o] *= 0.6;
      vel[o + 2] *= 0.6;
      for (let k = 0; k < 3; k++) spin[o + k] *= 0.5;
    }
    for (let k = 0; k < 3; k++) rot[o + k] += spin[o + k] * dt;
    if (debris.smoky[i] && pos[o + 1] > fl + 0.05 && Math.random() < dt * 30) {
      kit.smoke.emit(pos[o], pos[o + 1], pos[o + 2], 0, 0.2, 0, rand(0.6, 1.1), 0.12, 0.45, 2, 0.4, 1);
      if (Math.random() < 0.5) kit.glow.emit(pos[o], pos[o + 1], pos[o + 2], 0, 0, 0, 0.25, 0.14, 0.05, 1);
    }
    const s = debris.life[i] < 0.6 ? debris.size[i] * (debris.life[i] / 0.6) : debris.size[i];
    _dummy.position.set(pos[o], pos[o + 1], pos[o + 2]);
    _dummy.rotation.set(rot[o], rot[o + 1], rot[o + 2]);
    _dummy.scale.set(s, s * 0.7, s * 0.85);
    if (debris.life[i] <= 0) _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    debris.mesh.setMatrixAt(i, _dummy.matrix);
  }
  if (dirty) debris.mesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------ scorch decals
const SCORCH_N = 48;
const scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const scorches = [];
for (let i = 0; i < SCORCH_N; i++) {
  const m = new THREE.Mesh(scorchGeo, new THREE.MeshLambertMaterial({ map: scorchTex, transparent: true, depthWrite: false, opacity: 0 }));
  m.visible = false;
  m.renderOrder = 1;
  m.userData.age = 0;
  scene.add(m);
  scorches.push(m);
}
let scorchNext = 0;
kit.scorch = (x, y, z, size) => {
  const m = scorches[scorchNext];
  scorchNext = (scorchNext + 1) % SCORCH_N;
  m.position.set(x, y + 0.03 + scorchNext * 0.001, z);
  m.rotation.y = Math.random() * 6.28;
  m.scale.set(size, 1, size);
  m.material.opacity = 0.95;
  m.userData.age = 0;
  m.visible = true;
};
function updateScorches(dt) {
  for (const m of scorches) {
    if (!m.visible) continue;
    m.userData.age += dt;
    if (m.userData.age > 40) m.material.opacity = Math.max(0, 0.95 - (m.userData.age - 40) / 15);
    if (m.material.opacity <= 0) m.visible = false;
  }
}

// ------------------------------------------------------------------ light pulses
// Lights are created once (a changing light count recompiles every material).
const pulses = [];
for (let i = 0; i < 3; i++) {
  const l = new THREE.PointLight(0xffa04a, 0, 20, 1.6);
  l.userData = { age: 1, life: 1, peak: 0 };
  scene.add(l);
  pulses.push(l);
}
let pulseNext = 0;
kit.lightPulse = (x, y, z, peak, range, life) => {
  const l = pulses[pulseNext];
  pulseNext = (pulseNext + 1) % pulses.length;
  l.position.set(x, y, z);
  l.distance = range;
  Object.assign(l.userData, { age: 0, life, peak });
  l.intensity = peak;
};
function updatePulses(dt) {
  for (const l of pulses) {
    const u = l.userData;
    if (u.age >= u.life) {
      l.intensity = 0;
      continue;
    }
    u.age += dt;
    const k = Math.min(1, u.age / u.life);
    l.intensity = u.peak * (1 - k) * (1 - k) * (0.85 + 0.15 * Math.random());
    l.color.setRGB(1, 0.75 - 0.35 * k, 0.4 - 0.3 * k);
  }
}

// ------------------------------------------------------------------ camera shake + screen flash
let trauma = 0;
kit.shake = (amount) => { trauma = Math.min(1.2, trauma + amount); };
function applyShake(dt, t) {
  if (trauma <= 0) return;
  trauma = Math.max(0, trauma - dt * 1.1);
  const s = trauma * trauma;
  camera.rotation.x += s * 0.07 * Math.sin(t * 61.3 + 1.7) * Math.sin(t * 13.1);
  camera.rotation.y += s * 0.07 * Math.sin(t * 53.7 + 4.1) * Math.cos(t * 11.3);
  camera.rotation.z += s * 0.09 * Math.sin(t * 47.9 + 0.3);
  camera.position.y += s * 0.08 * Math.sin(t * 71.1);
}

const flashEl = document.createElement('div');
flashEl.id = 'nz-xflash';
flashEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:2;mix-blend-mode:screen;' +
  'background:radial-gradient(ellipse at center, rgba(255,240,210,1), rgba(255,140,40,.85) 60%, rgba(120,30,0,.6))';
document.body.appendChild(flashEl);
let flashK = 0;
kit.flash = (k) => { flashK = Math.max(flashK, Math.min(1, k)); };

// ------------------------------------------------------------------ update
const _right = new V3();
NZ.hooks.frame.push(() => {
  const h = NZ.renderer.domElement.height;
  const sc = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
  kit.glow.mat.uniforms.uScale.value = sc;
  kit.smoke.mat.uniforms.uScale.value = sc;
});
NZ.hooks.update.push((dt, t) => {
  kit.glow.update(dt);
  kit.smoke.update(dt);
  updateSprites(billows, dt, (k) => 1 - (1 - k) * (1 - k) * (1 - k));
  updateSprites(shocks, dt, (k) => 1 - (1 - k) * (1 - k));
  updateDebris(dt);
  updateScorches(dt);
  updatePulses(dt);
  applyShake(dt, t);
  if (flashK > 0) {
    flashK = Math.max(0, flashK - dt * 3.2);
    flashEl.style.opacity = (flashK * flashK * 0.85).toFixed(3);
  }
});
NZ.hooks.reset.push(() => {
  kit.glow.clear();
  kit.smoke.clear();
  for (const s of billows.list) s.visible = false;
  for (const s of shocks.list) s.visible = false;
  debris.life.fill(0);
  _dummy.scale.setScalar(0);
  _dummy.updateMatrix();
  for (let i = 0; i < DEBRIS_N; i++) debris.mesh.setMatrixAt(i, _dummy.matrix);
  debris.mesh.instanceMatrix.needsUpdate = true;
  for (const m of scorches) m.visible = false;
  for (const l of pulses) l.userData.age = l.userData.life;
  trauma = 0;
  flashK = 0;
  flashEl.style.opacity = 0;
});

// ------------------------------------------------------------------ audio
// All synthesised on the game's AudioContext (NZ.sound.ctx exists after the first click).
const snd = () => (NZ.sound.ctx ? NZ.sound : null);

// Gain + stereo pan for a world position, with our own distance falloff.
function spatial(s, pos, ref, when) {
  const ctx = s.ctx;
  const g = ctx.createGain();
  const p = ctx.createStereoPanner();
  let d = 0;
  if (pos) {
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const dx = pos.x - camera.position.x, dy = pos.y - camera.position.y, dz = pos.z - camera.position.z;
    d = Math.hypot(dx, dy, dz);
    p.pan.value = d > 0.5 ? Math.max(-0.85, Math.min(0.85, (dx * _right.x + dz * _right.z) / d)) : 0;
  }
  g.gain.value = 1 / (1 + Math.max(0, d - ref) / ref);
  g.connect(p).connect(s.master);
  return { node: g, d, t: s.t + (when || 0) };
}

function noiseBurst(s, out, t, type, f0, f1, dur, peak, attack = 0.003, q = 0.7) {
  const n = s.noiseSrc();
  const f = s.ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = s.ctx.createGain();
  s.env(g, t, attack, peak, dur);
  n.connect(f).connect(g).connect(out);
  n.start(t, Math.random());
  n.stop(t + attack + dur + 0.05);
}

function tone(s, out, t, type, f0, f1, dur, peak, attack = 0.003) {
  const o = s.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = s.ctx.createGain();
  s.env(g, t, attack, peak, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + dur + 0.05);
}

kit.sfx = {
  boom(pos, size = 1) {
    const s = snd();
    if (!s) return;
    const dist = pos.distanceTo(camera.position);
    const delay = Math.min(0.5, dist / 343);
    const sp = spatial(s, pos, 10 * size, delay), out = sp.node, t = sp.t;
    const muffle = 1 / (1 + dist / 25);
    // Crack, body, sub-drop and a long rolling tail off the hills.
    noiseBurst(s, out, t, 'lowpass', 9000 * muffle + 400, 90, 1.4, 1.8 * size);
    noiseBurst(s, out, t, 'bandpass', 2400 * muffle + 300, 200, 0.25, 1.0 * size * muffle, 0.001, 1.2);
    tone(s, out, t, 'sine', 78, 22, 1.1, 2.4 * size);
    tone(s, out, t, 'triangle', 160, 38, 0.35, 1.2 * size);
    noiseBurst(s, out, t + 0.08, 'lowpass', 260, 60, 3.2, 0.7 * size, 0.08);
    noiseBurst(s, out, t + 0.6 + dist / 400, 'lowpass', 500, 120, 2.2, 0.2 * size, 0.2);
    if (dist < 14) {
      for (let i = 0; i < 7; i++) s.click(900 + Math.random() * 2500, delay + 0.35 + Math.random() * 1.1, 0.05 + Math.random() * 0.06);
    }
    if (dist < 5 * size) tone(s, s.master, s.t + 0.05, 'sine', 3900, 3600, 2.6, 0.045, 0.02); // ears ringing
  },
  clink(pos, vol = 0.4) {
    const s = snd();
    if (!s) return;
    const sp = spatial(s, pos, 3);
    tone(s, sp.node, sp.t, 'sine', 2900 + Math.random() * 300, 2700, 0.12, vol * 0.5);
    tone(s, sp.node, sp.t, 'sine', 4300 + Math.random() * 500, 4100, 0.08, vol * 0.3);
    noiseBurst(s, sp.node, sp.t, 'bandpass', 1800, 900, 0.05, vol, 0.001, 2);
  },
  thunk(pos, vol = 0.5) {
    const s = snd();
    if (!s) return;
    const sp = spatial(s, pos, 3);
    tone(s, sp.node, sp.t, 'sine', 180, 70, 0.12, vol);
    noiseBurst(s, sp.node, sp.t, 'lowpass', 1200, 300, 0.08, vol * 0.6);
  },
  shatter(pos) {
    const s = snd();
    if (!s) return;
    const sp = spatial(s, pos, 4), out = sp.node, t = sp.t;
    noiseBurst(s, out, t, 'highpass', 3500, 6000, 0.25, 0.9, 0.001);
    noiseBurst(s, out, t, 'bandpass', 1400, 600, 0.12, 0.6, 0.001, 1.5);
    for (let i = 0; i < 12; i++) {
      const f = 3200 + Math.random() * 5200, w = Math.random() * 0.45;
      tone(s, out, t + w, 'sine', f, f * 0.97, 0.06 + Math.random() * 0.12, 0.12 * (1 - w));
    }
  },
  fwoomp(pos, size = 1) {
    const s = snd();
    if (!s) return;
    const sp = spatial(s, pos, 6), out = sp.node, t = sp.t;
    noiseBurst(s, out, t, 'bandpass', 250, 1600, 0.45, 1.2 * size, 0.04, 0.9);
    noiseBurst(s, out, t, 'lowpass', 600, 120, 1.0, 0.9 * size, 0.05);
    tone(s, out, t, 'sine', 55, 90, 0.4, 0.8 * size, 0.05);
  },
  pin() {
    const s = snd();
    if (!s) return;
    s.click(3200, 0, 0.35);
    tone(s, s.master, s.t + 0.02, 'sine', 2550, 2500, 0.35, 0.09);
    s.click(1500, 0.12, 0.25);
  },
  beep(urgent) {
    const s = snd();
    if (!s) return;
    tone(s, s.master, s.t, 'square', urgent ? 2100 : 1500, urgent ? 2100 : 1500, 0.05, urgent ? 0.07 : 0.04, 0.002);
    s.click(5000, 0, 0.08);
  },
  whoosh(vol = 0.35) {
    const s = snd();
    if (!s) return;
    noiseBurst(s, s.master, s.t, 'bandpass', 1400, 300, 0.3, vol, 0.03, 1.2);
  },
  lighter() {
    const s = snd();
    if (!s) return;
    s.click(4200, 0, 0.3);
    noiseBurst(s, s.master, s.t + 0.05, 'bandpass', 700, 2200, 0.35, 0.35, 0.03, 0.8);
  },
  scream(pos) {
    if (NZ.sound.ctx) NZ.sound.groan(pos, 1.7 + Math.random() * 0.3, true);
  },
  crackle(pos, vol) {
    const s = snd();
    if (!s) return;
    const sp = spatial(s, pos, 3);
    noiseBurst(s, sp.node, sp.t, 'bandpass', 1500 + Math.random() * 4000, 900, 0.015 + Math.random() * 0.03, vol, 0.001, 3);
  },
};

// A continuous fire roar whose level fire.js sets every frame.
let roar = null;
kit.setRoar = (level) => {
  const s = snd();
  if (!s) return;
  if (!roar) {
    const n = s.noiseSrc(true);
    const lp = s.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const bp = s.ctx.createBiquadFilter();
    bp.type = 'peaking';
    bp.frequency.value = 160;
    bp.gain.value = 8;
    roar = s.ctx.createGain();
    roar.gain.value = 0;
    n.connect(lp).connect(bp).connect(roar).connect(s.master);
    n.start();
  }
  roar.gain.setTargetAtTime(Math.min(0.5, level), s.t, 0.15);
};
