// TEAM WORLD: the slope down to Lake Wakatipu, the water, the jetty and the runabout.
//
// Defines the shared contracts NZ.terrainAt(x, z) (three.js world coords -> ground height, the
// carved lake bed under water) and NZ.waterLevel. Adds a coarse 2 m nav grid over the whole
// play area (zombies outside the house grid follow it, spawns come up the slope and out of the
// shallows), the lake surface shader, wading / swimming, the moored boat and its zombie crew.
import TERRAIN from './world_terrain.js';

const NZ = window.NZ;
const { THREE, V3, P, scene, camera, player, keys, weapon, sound, zombies, hooks } = NZ;
const W = TERRAIN.water;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ heightfield
const ROWS = TERRAIN.rows, COLS = TERRAIN.cols, STEP = TERRAIN.step, HALF = TERRAIN.half;
const PHI = (TERRAIN.north_deg * Math.PI) / 180, SP = Math.sin(PHI), CP = Math.cos(PHI);
const [AX, AY] = TERRAIN.anchor;
const ZH = (() => {
  const bin = atob(TERRAIN.z_b64), out = new Float32Array(ROWS * COLS);
  for (let i = 0; i < out.length; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    out[i] = (v > 32767 ? v - 65536 : v) / 100;
  }
  return out;
})();

// Plan metres (x, y) -> bilinear height on the rotated 4 m DEM grid.
function heightPlan(px, py) {
  const dx = px - AX, dy = py - AY;
  const fi = Math.min(ROWS - 1.001, Math.max(0, (dx * SP + dy * CP + HALF) / STEP));
  const fj = Math.min(COLS - 1.001, Math.max(0, (dx * CP - dy * SP + HALF) / STEP));
  const i = fi | 0, j = fj | 0, u = fi - i, v = fj - j, k = i * COLS + j;
  return (ZH[k] * (1 - v) + ZH[k + 1] * v) * (1 - u) + (ZH[k + COLS] * (1 - v) + ZH[k + COLS + 1] * v) * u;
}
const terrainAt = (x, z) => heightPlan(x, -z);
NZ.terrainAt = terrainAt;
NZ.waterLevel = W;
NZ.waterDepthAt = (x, z) => W - terrainAt(x, z);

// ------------------------------------------------------------------ jetty
const J = TERRAIN.jetty;
const JD = { x: J.dir[0], y: J.dir[1] }, JLEN = Math.hypot(J.b[0] - J.a[0], J.b[1] - J.a[1]);
function jettyLocal(px, py) {
  const dx = px - J.a[0], dy = py - J.a[1];
  return { along: dx * JD.x + dy * JD.y, across: -dx * JD.y + dy * JD.x };
}
function onJetty(px, py, pad = 0) {
  const l = jettyLocal(px, py);
  return l.along > -pad && l.along < JLEN + pad && Math.abs(l.across) < J.width / 2 + pad;
}

// ------------------------------------------------------------------ coarse nav grid (2 m)
const [PX0, PY0, PX1, PY1] = TERRAIN.play;
const NAV = { x0: PX0 + 2, y0: PY0 + 2, cs: 2, nx: 0, ny: 0 };
NAV.nx = Math.floor((PX1 - 2 - NAV.x0) / NAV.cs);
NAV.ny = Math.floor((PY1 - 2 - NAV.y0) / NAV.cs);
const NN = NAV.nx * NAV.ny;
const navH = new Float32Array(NN), navE = new Float32Array(NN), navWalk = new Uint8Array(NN);
const navFlow = new Int32Array(NN).fill(-1), navQ = new Int32Array(NN), navShore = new Float32Array(NN);
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const navCellPlan = (px, py) => {
  const ix = Math.floor((px - NAV.x0) / NAV.cs), iy = Math.floor((py - NAV.y0) / NAV.cs);
  return ix < 0 || iy < 0 || ix >= NAV.nx || iy >= NAV.ny ? -1 : iy * NAV.nx + ix;
};
const navPX = (i) => NAV.x0 + ((i % NAV.nx) + 0.5) * NAV.cs;
const navPY = (i) => NAV.y0 + (((i / NAV.nx) | 0) + 0.5) * NAV.cs;

function buildNav() {
  for (let i = 0; i < NN; i++) {
    const px = navPX(i), py = navPY(i);
    const h = onJetty(px, py) ? J.deck : heightPlan(px, py);
    navH[i] = h;
    navE[i] = Math.max(h, W - 1.2); // swimmers stay at the surface
  }
  for (let i = 0; i < NN; i++) {
    const ix = i % NAV.nx, iy = (i / NAV.nx) | 0;
    let steep = 0;
    for (let k = 0; k < 4; k++) {
      const x = ix + NB8[k][0], y = iy + NB8[k][1];
      if (x < 0 || y < 0 || x >= NAV.nx || y >= NAV.ny) continue;
      steep = Math.max(steep, Math.abs(navE[i] - navE[y * NAV.nx + x]));
    }
    navWalk[i] = steep < 1.5 ? 1 : 0;
  }
  // Distance to the waterline (cells), for lapping sound and place names.
  navShore.fill(1e9);
  let tail = 0;
  for (let i = 0; i < NN; i++) {
    const ix = i % NAV.nx, iy = (i / NAV.nx) | 0, wet = navH[i] < W;
    for (let k = 0; k < 4; k++) {
      const x = ix + NB8[k][0], y = iy + NB8[k][1];
      if (x < 0 || y < 0 || x >= NAV.nx || y >= NAV.ny) continue;
      if (navH[y * NAV.nx + x] < W !== wet) {
        navShore[i] = 0;
        navQ[tail++] = i;
        break;
      }
    }
  }
  for (let head = 0; head < tail;) {
    const c = navQ[head++], ix = c % NAV.nx, iy = (c / NAV.nx) | 0;
    for (let k = 0; k < 4; k++) {
      const x = ix + NB8[k][0], y = iy + NB8[k][1];
      if (x < 0 || y < 0 || x >= NAV.nx || y >= NAV.ny) continue;
      const j = y * NAV.nx + x;
      if (navShore[j] <= navShore[c] + 1) continue;
      navShore[j] = navShore[c] + 1;
      navQ[tail++] = j;
    }
  }
}

let navSource = -2, navT = 0;
function computeNavFlow(src) {
  navFlow.fill(-1);
  if (src < 0) return;
  let head = 0, tail = 0;
  navFlow[src] = 0;
  navQ[tail++] = src;
  while (head < tail) {
    const c = navQ[head++], ix = c % NAV.nx, iy = (c / NAV.nx) | 0, d = navFlow[c] + 1;
    for (let k = 0; k < 8; k++) {
      const x = ix + NB8[k][0], y = iy + NB8[k][1];
      if (x < 0 || y < 0 || x >= NAV.nx || y >= NAV.ny) continue;
      const j = y * NAV.nx + x;
      if (navFlow[j] !== -1 || !navWalk[j] || Math.abs(navE[c] - navE[j]) > 1.5) continue;
      navFlow[j] = d;
      navQ[tail++] = j;
    }
  }
}

function navGoal(z) {
  let cur = navCellPlan(z.pos.x, -z.pos.z);
  if (cur < 0 || navFlow[cur] <= 1) return null;
  for (let s = 0; s < 3; s++) {
    const ix = cur % NAV.nx, iy = (cur / NAV.nx) | 0;
    let best = -1, bd = navFlow[cur];
    for (let k = 0; k < 8; k++) {
      const x = ix + NB8[k][0], y = iy + NB8[k][1];
      if (x < 0 || y < 0 || x >= NAV.nx || y >= NAV.ny) continue;
      const j = y * NAV.nx + x;
      if (navFlow[j] >= 0 && navFlow[j] < bd) {
        bd = navFlow[j];
        best = j;
      }
    }
    if (best < 0) break;
    cur = best;
  }
  z.goal = z.goal || { x: 0, z: 0 };
  z.goal.x = navPX(cur);
  z.goal.z = -navPY(cur);
  return z.goal;
}

// Spawn points outside the house grid: up the slope, along the shore and in the shallows.
const outerSpawns = [];
let baseSpawnLen = -1;
function prepareOuterSpawns() {
  const G = NZ.grid;
  for (let i = 0; i < NN; i += 2) {
    const px = navPX(i), py = navPY(i);
    if (px > G.x0 - 2 && px < G.x0 + G.nx * G.cs + 2 && py > G.y0 - 2 && py < G.y0 + G.ny * G.cs + 2) continue;
    if (!navWalk[i] || W - navH[i] > 0.9 || onJetty(px, py, 1)) continue;
    outerSpawns.push({ x: px, y: py, z: navH[i], c: -1, outer: true });
  }
}
function refreshSpawns() {
  const list = NZ.spawnCandidates;
  if (!list) return;
  if (baseSpawnLen < 0) baseSpawnLen = list.length;
  list.length = baseSpawnLen;
  const px = player.collider.start.x, py = -player.collider.start.z, near = [];
  for (const s of outerSpawns) {
    const d = Math.hypot(s.x - px, s.y - py);
    if (d > 14 && d < 40) near.push(s);
  }
  // Weighted so that, out on the slope or at the lake, most of the game's random picks land near you.
  const outside = NZ.cellOf(player.collider.start.x, player.collider.start.z) < 0;
  const want = near.length ? (outside ? Math.max(near.length, Math.round(baseSpawnLen * 1.5)) : Math.min(near.length, 120)) : 0;
  for (let k = 0; k < want; k++) list.push(near[k % near.length]);
  spawnFrom.set(px, 0, py);
}
const spawnFrom = new V3(1e9, 0, 0);

// ------------------------------------------------------------------ minimap underlay + place names
const miniCanvas = document.createElement('canvas');
function buildMiniUnder() {
  miniCanvas.width = NAV.nx;
  miniCanvas.height = NAV.ny;
  const g = miniCanvas.getContext('2d'), img = g.createImageData(NAV.nx, NAV.ny);
  for (let i = 0; i < NN; i++) {
    const ix = i % NAV.nx, iy = NAV.ny - 1 - ((i / NAV.nx) | 0), o = (iy * NAV.nx + ix) * 4;
    const d = W - navH[i];
    let c;
    if (d > 0) {
      const k = Math.min(1, d / 6);
      c = [20 - k * 12, 46 - k * 26, 70 - k * 30, 230];
      if (navShore[i] < 1.5) c = [70, 96, 120, 240];
    } else c = navWalk[i] ? [24 + Math.min(14, -d * 0.3), 18 + Math.min(8, -d * 0.2), 18, 215] : [60, 52, 46, 230];
    img.data.set(c, o);
  }
  g.putImageData(img, 0, 0);
  // The jetty and the path.
  const tx = (px) => px - NAV.x0, ty = (py) => NAV.ny * NAV.cs - (py - NAV.y0);
  g.strokeStyle = 'rgba(214,190,150,0.95)';
  g.lineWidth = J.width / NAV.cs;
  g.beginPath();
  g.moveTo(tx(J.a[0]) / NAV.cs, ty(J.a[1]) / NAV.cs);
  g.lineTo(tx(J.b[0]) / NAV.cs, ty(J.b[1]) / NAV.cs);
  g.stroke();
  g.strokeStyle = 'rgba(120,100,80,0.8)';
  g.lineWidth = 0.8;
  g.beginPath();
  PATH_PTS.forEach(([x, y], k) => (k ? g.lineTo : g.moveTo).call(g, tx(x) / NAV.cs, ty(y) / NAV.cs));
  g.stroke();
}

NZ.minimapUnder = (g, px, py, s) => {
  g.drawImage(miniCanvas, (NAV.x0 - px) * s, -(NAV.y0 + NAV.ny * NAV.cs - py) * s, NAV.nx * NAV.cs * s, NAV.ny * NAV.cs * s);
  // The boat.
  const bx = (BOAT.x - px) * s, by = (-BOAT.z - py) * -s;
  g.save();
  g.translate(bx, by);
  g.rotate(-BOAT.yaw);
  g.fillStyle = '#e8e4da';
  g.beginPath();
  g.moveTo(0, -3.1 * s);
  g.lineTo(1.15 * s, -0.6 * s);
  g.lineTo(1.15 * s, 2.9 * s);
  g.lineTo(-1.15 * s, 2.9 * s);
  g.lineTo(-1.15 * s, -0.6 * s);
  g.fill();
  g.restore();
};

NZ.placeName = (px, py) => {
  if (BOAT.aboard) return 'The Runabout';
  if (onJetty(px, py, 0.3)) return 'The Jetty';
  const c = navCellPlan(px, py);
  if (c < 0) return null;
  const d = W - heightPlan(px, py);
  if (d > 0.05) return 'Lake Wakatipu';
  if (navShore[c] < 12) return 'Drift Bay Shore';
  if (Math.hypot(px - AX, py - AY) > 70) return 'The Slope';
  return null;
};

// ------------------------------------------------------------------ the lake surface
function waveTexture(N = 256) {
  // Tileable heightfield from integer-frequency waves -> normal map (rgb) + height (a).
  const r = NZ.rng(42), h = new Float32Array(N * N), waves = [];
  for (let k = 0; k < 28; k++) {
    const kx = Math.round((r() - 0.5) * 18) || 1, ky = Math.round((r() - 0.5) * 18) || 1;
    waves.push([kx, ky, 1 / Math.pow(Math.hypot(kx, ky), 1.25), r() * TAU]);
  }
  let lo = 1e9, hi = -1e9;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (const [kx, ky, a, ph] of waves) s += a * Math.sin((TAU * (kx * x + ky * y)) / N + ph);
      h[y * N + x] = s;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
  }
  const data = new Uint8Array(N * N * 4), at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 9, dy = (at(x, y + 1) - at(x, y - 1)) * 9;
      const l = Math.hypot(dx, dy, 1), o = (y * N + x) * 4;
      data[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[o + 3] = ((at(x, y) - lo) / (hi - lo)) * 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function depthTexture() {
  // Signed water depth (-2 .. 10 m) on the DEM grid, so the shader knows the shallows.
  const data = new Uint8Array(ROWS * COLS);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, ((W - ZH[i] + 2) / 12) * 255));
  const t = new THREE.DataTexture(data, COLS, ROWS, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const waterUniforms = {
  time: { value: 0 },
  tWave: { value: null },
  tDepth: { value: null },
  moonDir: { value: new V3(-0.5, 0.42, -1).normalize() },
  horizon: { value: new THREE.Color() },
  haze: { value: 0.0024 },
  grid: { value: new THREE.Vector4(AX, AY, SP, CP) },
  grid2: { value: new THREE.Vector4(HALF, STEP, COLS, ROWS) },
  lampPos: { value: [new V3(), new V3()] },
  lampCol: { value: [new THREE.Color(), new THREE.Color()] },
};

function buildWater() {
  waterUniforms.tWave.value = waveTexture();
  waterUniforms.tDepth.value = depthTexture();
  const mat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    transparent: true,
    depthWrite: true,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float time, haze;
      uniform sampler2D tWave, tDepth;
      uniform vec3 moonDir, horizon;
      uniform vec4 grid, grid2;
      uniform vec3 lampPos[2];
      uniform vec3 lampCol[2];
      varying vec3 vWorld;

      float waterDepth(vec2 xz) {
        float dx = xz.x - grid.x, dy = -xz.y - grid.y;
        vec2 uv = (vec2(dx * grid.w - dy * grid.z, dx * grid.z + dy * grid.w) + grid2.x) / grid2.y + 0.5;
        uv /= grid2.zw;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 12.0;
        return texture2D(tDepth, uv).r * 12.0 - 2.0;
      }
      vec3 sky(vec3 d) {
        float h = max(d.y, 0.0);
        vec3 col = mix(horizon, vec3(0.004, 0.005, 0.016), pow(clamp(h * 1.6 + 0.02, 0.0, 1.0), 0.55));
        float m = max(dot(d, moonDir), 0.0);
        return col + vec3(0.6, 0.12, 0.05) * pow(m, 60.0) * 0.8 + vec3(0.25, 0.05, 0.03) * pow(m, 5.0) * 0.18;
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 p = vWorld.xz;
        vec4 w1 = texture2D(tWave, p * 0.043 + vec2(time * 0.011, time * 0.006));
        vec4 w2 = texture2D(tWave, p * 0.109 + vec2(-time * 0.016, time * 0.019));
        vec4 w3 = texture2D(tWave, p * 0.0071 + vec2(time * 0.0021, -time * 0.0034));
        vec4 w4 = texture2D(tWave, p * 0.37 + vec2(time * 0.031, -time * 0.024));
        float far = clamp(dist / 420.0, 0.0, 1.0);
        float nearK = 1.0 - smoothstep(4.0, 40.0, dist);
        vec3 nt = (w1.xyz * 2.0 - 1.0) + (w2.xyz * 2.0 - 1.0) * 0.55 + (w3.xyz * 2.0 - 1.0) * 0.9 + (w4.xyz * 2.0 - 1.0) * 0.7 * nearK;
        float bump = mix(0.42, 0.1, far);
        vec3 N = normalize(vec3(nt.x * bump, 1.0, nt.y * bump));
        float d = waterDepth(p);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 refl = sky(R);
        float g = max(dot(R, moonDir), 0.0);
        refl += vec3(1.0, 0.38, 0.22) * (pow(g, 700.0) * 9.0 + pow(g, 90.0) * 0.5) + vec3(0.5, 0.1, 0.06) * pow(g, 8.0) * 0.22;
        for (int i = 0; i < 2; i++) {
          vec3 L = lampPos[i] - vWorld;
          float ld = length(L);
          float s = max(dot(R, L / ld), 0.0);
          refl += lampCol[i] * pow(s, 600.0) * 6.0 / (1.0 + ld * ld * 0.02);
        }
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        float deep = smoothstep(0.2, 7.0, d);
        vec3 body = mix(vec3(0.016, 0.03, 0.026), vec3(0.002, 0.006, 0.012), deep);
        vec3 col = mix(body, refl, fres);
        // Lapping foam and shimmer along the shore.
        float lap = 0.22 + 0.12 * sin(time * 1.15 + p.x * 0.07 + p.y * 0.05) + 0.05 * sin(time * 2.7 + p.y * 0.3);
        float hgt = texture2D(tWave, p * 0.31 + vec2(time * 0.02, 0.0)).a;
        float edge = smoothstep(lap * 0.7, 0.0, d) * smoothstep(-0.06, 0.03, d);
        float foam = edge * smoothstep(0.32, 0.7, hgt + (lap - d) * 1.6);
        col += vec3(0.13, 0.11, 0.125) * foam;
        float shimmer = smoothstep(1.4, 0.2, d) * pow(max(w2.a * w1.a, 0.0), 3.0);
        col += vec3(0.25, 0.08, 0.05) * shimmer * (0.6 + 0.4 * sin(time * 3.0 + p.x));
        float alpha = mix(0.45, 0.97, smoothstep(0.0, 2.2, d));
        alpha = max(max(alpha, fres), foam * 0.8);
        float fogF = 1.0 - exp(-haze * haze * dist * dist);
        col = mix(col, horizon, fogF);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = W;
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

// ------------------------------------------------------------------ foam / wake particles
const FOAM_N = 1200;
const foam = {
  pos: new Float32Array(FOAM_N * 3), alpha: new Float32Array(FOAM_N), size: new Float32Array(FOAM_N),
  vel: new Float32Array(FOAM_N * 2), life: new Float32Array(FOAM_N), max: new Float32Array(FOAM_N),
  s0: new Float32Array(FOAM_N), grow: new Float32Array(FOAM_N), next: 0, mesh: null,
};
function buildFoam() {
  const g = new THREE.BufferGeometry();
  for (let i = 0; i < FOAM_N; i++) foam.pos[i * 3 + 1] = -999;
  g.setAttribute('position', new THREE.BufferAttribute(foam.pos, 3));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(foam.alpha, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(foam.size, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { scale: { value: 600 }, fogCol: waterUniforms.horizon, fogD: { value: 0.02 } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aAlpha; attribute float aSize; uniform float scale;
      varying float vA; varying float vD;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * scale / max(0.5, -mv.z);
        vA = aAlpha; vD = -mv.z;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 fogCol; uniform float fogD;
      varying float vA; varying float vD;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        float a = smoothstep(1.0, 0.25, r) * vA;
        if (a < 0.01) discard;
        vec3 col = mix(vec3(0.3, 0.29, 0.32), fogCol, 1.0 - exp(-fogD * fogD * vD * vD * 0.25));
        gl_FragColor = vec4(col, a * 0.22);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  foam.mesh = new THREE.Points(g, m);
  foam.mesh.frustumCulled = false;
  foam.mesh.renderOrder = 1;
  scene.add(foam.mesh);
}
function foamAt(x, z, vx, vz, life, s0, grow) {
  const i = foam.next++ % FOAM_N;
  foam.pos[i * 3] = x;
  foam.pos[i * 3 + 1] = W + 0.04;
  foam.pos[i * 3 + 2] = z;
  foam.vel[i * 2] = vx;
  foam.vel[i * 2 + 1] = vz;
  foam.life[i] = foam.max[i] = life;
  foam.s0[i] = s0;
  foam.grow[i] = grow;
}
function updateFoam(dt) {
  const damp = Math.exp(-1.4 * dt);
  for (let i = 0; i < FOAM_N; i++) {
    if (foam.life[i] <= 0) continue;
    foam.life[i] -= dt;
    const k = Math.max(0, foam.life[i] / foam.max[i]);
    foam.pos[i * 3] += foam.vel[i * 2] * dt;
    foam.pos[i * 3 + 2] += foam.vel[i * 2 + 1] * dt;
    foam.vel[i * 2] *= damp;
    foam.vel[i * 2 + 1] *= damp;
    foam.size[i] = foam.s0[i] + foam.grow[i] * (1 - k);
    foam.alpha[i] = Math.min(1, k * 2.5) * k;
    if (foam.life[i] <= 0) {
      foam.pos[i * 3 + 1] = -999;
      foam.alpha[i] = 0;
    }
  }
  const g = foam.mesh.geometry;
  g.attributes.position.needsUpdate = g.attributes.aAlpha.needsUpdate = g.attributes.aSize.needsUpdate = true;
  foam.mesh.material.uniforms.fogD.value = scene.fog ? scene.fog.density : 0.02;
  foam.mesh.material.uniforms.scale.value = NZ.renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
const splash = (x, z, n = 10, up = 2.4) => NZ.emit(new V3(x, W + 0.05, z), n, [0.5, 0.56, 0.66], 1.6, up, 0.7);

// ------------------------------------------------------------------ slope planting + path
const PATH_PTS = [[52, 40], [62, 70], [74, 104], [90, 140], [104, 176], [113, 200], [J.a[0] - JD.x * 1.0, J.a[1] - JD.y * 1.0]];

function buildPath() {
  const curve = new THREE.CatmullRomCurve3(PATH_PTS.map(([x, y]) => new V3(x, 0, -y)));
  const n = Math.ceil(curve.getLength());
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = curve.getPointAt(t), tg = curve.getTangentAt(t);
    const sx = -tg.z, sz = tg.x, l = Math.hypot(sx, sz), w = 0.85 + 0.15 * Math.sin(i * 0.37);
    for (const side of [-1, 1]) {
      const x = p.x + (sx / l) * w * side, z = p.z + (sz / l) * w * side;
      pos.push(x, terrainAt(x, z) + 0.07, z);
      uv.push(side * w, i);
    }
    if (i < n) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const tex = NZ.detailTexture('gravel', 91, 8);
  tex.repeat.set(0.8, 0.8);
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.3, 0.27, 0.23), roughness: 1, map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function distToPath(px, py) {
  let best = 1e9;
  for (let k = 0; k < PATH_PTS.length - 1; k++) {
    const [ax, ay] = PATH_PTS[k], [bx, by] = PATH_PTS[k + 1];
    const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
    best = Math.min(best, Math.hypot(px - ax - vx * t, py - ay - vy * t));
  }
  return best;
}

const swayTime = { value: 0 };
function clumpGeometry(seed, blades, lo, hi, height) {
  const r = NZ.rng(seed), pos = [], col = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * TAU + r() * 0.7, lean = 0.2 + r() * 0.5, h = height * (0.6 + r() * 0.5), w = 0.03 + r() * 0.02;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz * w, pz = dx * w;
    const p0 = [0, 0, 0], p1 = [dx * lean * 0.35, h * 0.55, dz * lean * 0.35], p2 = [dx * lean, h, dz * lean];
    const quad = (A, B, ka, kb, ta, tb) => {
      const v = [[A[0] - px * ka, A[1], A[2] - pz * ka], [A[0] + px * ka, A[1], A[2] + pz * ka], [B[0] + px * kb, B[1], B[2] + pz * kb],
        [A[0] - px * ka, A[1], A[2] - pz * ka], [B[0] + px * kb, B[1], B[2] + pz * kb], [B[0] - px * kb, B[1], B[2] - pz * kb]];
      const ts = [ta, ta, tb, ta, tb, tb];
      v.forEach((q, i) => {
        pos.push(...q);
        col.push(...lo.map((c, k) => c + (hi[k] - c) * ts[i]));
      });
    };
    quad(p0, p1, 1, 0.7, 0, 0.55);
    quad(p1, p2, 0.7, 0.05, 0.55, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function plantSlope() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = swayTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float hh = clamp(position.y, 0.0, 1.6);
      vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float ph = wp.x * 0.31 + wp.z * 0.23;
      transformed.x += sin(uTime * 1.6 + ph) * 0.12 * hh * hh;
      transformed.z += cos(uTime * 1.25 + ph * 1.4) * 0.08 * hh * hh;`);
  };
  const kinds = [
    { geo: clumpGeometry(21, 11, [0.1, 0.07, 0.03], [0.62, 0.48, 0.24], 0.95), list: [] }, // tussock
    { geo: clumpGeometry(33, 9, [0.04, 0.06, 0.03], [0.2, 0.26, 0.12], 1.7), list: [] }, // flax by the water
  ];
  const r = NZ.rng(7);
  for (let k = 0; k < 9000; k++) {
    const px = PX0 + r() * (PX1 - PX0), py = PY0 + r() * (PY1 - PY0), h = heightPlan(px, py), d = W - h;
    if (d > -0.35) continue;
    const rh = Math.hypot(px - AX, py - AY);
    if (rh < 70 || (rh < 100 && r() > (rh - 70) / 30)) continue;
    if (distToPath(px, py) < 1.8 || onJetty(px, py, 2)) continue;
    const c = navCellPlan(px, py);
    const shore = c >= 0 ? navShore[c] : 99;
    if (shore < 6 && r() < 0.6) kinds[1].list.push([px, py, h]);
    else if (r() < 0.7) kinds[0].list.push([px, py, h]);
  }
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  for (const [ki, kind] of kinds.entries()) {
    // Tile the instances so off-screen patches are culled.
    const tiles = new Map();
    for (const p of kind.list) {
      const key = Math.floor(p[0] / 60) + ':' + Math.floor(p[1] / 60);
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(p);
    }
    for (const list of tiles.values()) {
      const mesh = new THREE.InstancedMesh(kind.geo, mat, list.length);
      list.forEach(([px, py, h], i) => {
        dummy.position.copy(P(px, py, h - 0.05));
        dummy.rotation.set((r() - 0.5) * 0.15, r() * TAU, (r() - 0.5) * 0.15);
        dummy.scale.setScalar(0.75 + r() * 0.6);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const t = r();
        col.setRGB(0.75 + t * 0.4, 0.7 + t * 0.35, 0.65 + t * 0.3 * (ki ? 1.2 : 1));
        mesh.setColorAt(i, col);
      });
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
  }
}

// ------------------------------------------------------------------ the jetty lantern
let lantern = null;
function buildLantern() {
  const end = P(J.b[0] - JD.x * 0.4 + JD.y * (J.width / 2 + 0.05), J.b[1] - JD.y * 0.4 - JD.x * (J.width / 2 + 0.05), J.deck + 1.05);
  lantern = new THREE.PointLight(0xffa860, 6, 20, 1.5);
  lantern.position.copy(end);
  lantern.userData.phase = Math.random() * 10;
  scene.add(lantern);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: NZ.glowTexture('rgba(255,220,170,1)', 'rgba(255,140,60,0.3)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(0.9);
  glow.position.copy(end);
  scene.add(glow);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.4, 0.7) }));
  box.position.copy(end);
  scene.add(box);
}

// ------------------------------------------------------------------ the boat
const BOAT = {
  group: null, x: 0, z: 0, yaw: 0, y: W, pitch: 0, roll: 0, speed: 0, yawRate: 0, throttle: 0, steer: 0,
  home: { x: 0, z: 0, yaw: 0 }, aboard: false, driving: false, view: 'chase', engine: null, rpm: 0,
  crewRound: -1, crewIdle: false, chase: new V3(), lastHint: 0, test: null,
};
const HULL_T = (lz) => Math.min(1, Math.max(0, (2.9 - lz) / 6));
const hullHalf = (lz) => {
  const t = HULL_T(lz);
  return 1.15 * (t < 0.55 ? 1 : Math.pow(Math.max(0, Math.cos(((t - 0.55) / 0.45) * Math.PI * 0.5)), 0.8));
};
const FLOOR_Y = 0.35, FORE_Y = 1.0, GUNWALE_Y = 0.88, FLOOR_Z0 = -1.5, FLOOR_Z1 = 2.7;
const floorHalf = (lz) => hullHalf(lz) * 0.9 - 0.08;
const HELM = { x: 0.42, z: 0.5 };

function buildBoat() {
  const g = new THREE.Group();
  // Hull: lofted stations from the transom (t=0) to the bow (t=1).
  const S = 16, pos = [];
  const station = (t) => {
    const z = 2.9 - 6 * t, w = hullHalf(z), h = 0.88 + 0.28 * t * t;
    const k = -0.32 + Math.pow(Math.max(0, t - 0.5), 1.5) * 1.4, cy = -0.02 + 0.25 * t * t;
    return [[-w, h, z], [-w * 0.93, cy, z], [0, k, z], [w * 0.93, cy, z], [w, h, z]];
  };
  for (let s = 0; s < S; s++) {
    const a = station(s / S), b = station((s + 1) / S);
    for (let k = 0; k < 4; k++) pos.push(...a[k], ...b[k], ...b[k + 1], ...a[k], ...b[k + 1], ...a[k + 1]);
  }
  const tr = station(0), mid = [0, 0.4, 2.9];
  for (let k = 0; k < 4; k++) pos.push(...mid, ...tr[k + 1], ...tr[k]);
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hullGeo.computeVertexNormals();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.55, side: THREE.DoubleSide });
  hullMat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying float vLy;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLy = position.y;');
    sh.fragmentShader = 'varying float vLy;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      if (vLy < 0.08) diffuseColor.rgb = vec3(0.16, 0.035, 0.03);
      else if (vLy > 0.6 && vLy < 0.7) diffuseColor.rgb = vec3(0.04, 0.07, 0.16);`);
  };
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.castShadow = true;
  g.add(hull);
  // Cockpit floor and foredeck.
  const floorShape = new THREE.Shape(), fore = new THREE.Shape();
  const zs = [];
  for (let z = FLOOR_Z1; z >= FLOOR_Z0 - 0.001; z -= 0.3) zs.push(z);
  zs.forEach((z, i) => (i ? floorShape.lineTo(-floorHalf(z), -z) : floorShape.moveTo(-floorHalf(z), -z)));
  [...zs].reverse().forEach((z) => floorShape.lineTo(floorHalf(z), -z));
  const fz = [];
  for (let z = FLOOR_Z0; z >= -3.08; z -= 0.2) fz.push(z);
  fz.forEach((z, i) => (i ? fore.lineTo(-hullHalf(z) * 0.97, -z) : fore.moveTo(-hullHalf(z) * 0.97, -z)));
  [...fz].reverse().forEach((z) => fore.lineTo(hullHalf(z) * 0.97, -z));
  const teak = new THREE.MeshStandardMaterial({ color: 0x6a4a2c, roughness: 0.8, map: NZ.detailTexture('planks', 61, 8) });
  teak.map.repeat.set(1.5, 1.5);
  const white = new THREE.MeshStandardMaterial({ color: 0xcfcabd, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.5 });
  const vinyl = new THREE.MeshStandardMaterial({ color: 0x8a7f6e, roughness: 0.9 });
  const fl = new THREE.Mesh(new THREE.ShapeGeometry(floorShape).rotateX(-Math.PI / 2), teak);
  fl.position.y = FLOOR_Y;
  const fd = new THREE.Mesh(new THREE.ShapeGeometry(fore).rotateX(-Math.PI / 2), white);
  fd.position.y = FORE_Y;
  g.add(fl, fd);
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(floorHalf(FLOOR_Z0) * 2 + 0.1, FORE_Y - FLOOR_Y, 0.06), white, 0, (FORE_Y + FLOOR_Y) / 2, FLOOR_Z0);
  // Console, windscreen, wheel, throttle.
  add(new THREE.BoxGeometry(0.72, 0.85, 0.55), white, HELM.x, FLOOR_Y + 0.425, -0.5);
  add(new THREE.BoxGeometry(0.6, 0.05, 0.3), dark, HELM.x, FLOOR_Y + 0.87, -0.4, -0.35);
  const glass = new THREE.MeshStandardMaterial({ color: 0x40505a, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  add(new THREE.PlaneGeometry(0.8, 0.42), glass, HELM.x, FLOOR_Y + 1.06, -0.72, -0.55);
  add(new THREE.TorusGeometry(0.17, 0.022, 6, 18), dark, HELM.x, FLOOR_Y + 0.98, -0.2, -0.9);
  add(new THREE.BoxGeometry(0.05, 0.16, 0.05), dark, HELM.x + 0.3, FLOOR_Y + 0.95, -0.3, 0.3);
  // Seats: helm + passenger pedestals, stern bench.
  for (const sx of [HELM.x, -HELM.x]) {
    add(new THREE.BoxGeometry(0.12, 0.42, 0.12), dark, sx, FLOOR_Y + 0.21, HELM.z);
    add(new THREE.BoxGeometry(0.52, 0.1, 0.48), vinyl, sx, FLOOR_Y + 0.47, HELM.z);
    add(new THREE.BoxGeometry(0.52, 0.45, 0.08), vinyl, sx, FLOOR_Y + 0.75, HELM.z + 0.26, 0.15);
  }
  add(new THREE.BoxGeometry(1.9, 0.42, 0.5), vinyl, 0, FLOOR_Y + 0.21, 2.45);
  // Outboard.
  add(new THREE.BoxGeometry(0.44, 0.62, 0.58), dark, 0, 1.05, 3.2);
  add(new THREE.BoxGeometry(0.46, 0.06, 0.6), white, 0, 0.8, 3.2);
  add(new THREE.BoxGeometry(0.13, 1.0, 0.22), dark, 0, 0.25, 3.28);
  add(new THREE.BoxGeometry(0.06, 0.26, 0.34), dark, 0, -0.32, 3.26);
  // Navigation lights.
  add(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 6), dark, -0.75, 1.45, 2.6);
  const navLight = (rgb, x, y, z, s) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: NZ.glowTexture(rgb, rgb.replace('1)', '0.25)')), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.position.set(x, y, z);
    sp.scale.setScalar(s);
    g.add(sp);
  };
  navLight('rgba(255,60,40,1)', -0.6, 1.06, -2.3, 0.22);
  navLight('rgba(60,255,120,1)', 0.6, 1.06, -2.3, 0.22);
  navLight('rgba(255,240,220,1)', -0.75, 2.08, 2.6, 0.26);
  g.rotation.order = 'YXZ';
  scene.add(g);
  BOAT.group = g;
  // Moored alongside the end of the jetty, bow out.
  const side = 1, off = J.width / 2 + 1.15 + 0.35;
  const mx = J.b[0] - JD.x * 4.2 + JD.y * off * side, my = J.b[1] - JD.y * 4.2 - JD.x * off * side;
  Object.assign(BOAT.home, { x: mx, z: -my, yaw: Math.atan2(-JD.x, JD.y) });
  resetBoat();
}

function resetBoat() {
  Object.assign(BOAT, { x: BOAT.home.x, z: BOAT.home.z, yaw: BOAT.home.yaw, speed: 0, yawRate: 0, throttle: 0, steer: 0, rpm: 0 });
  placeBoatMesh(0);
}

// World <-> boat-local (yaw only) helpers.
function toLocal(x, z, out) {
  const dx = x - BOAT.x, dz = z - BOAT.z, c = Math.cos(BOAT.yaw), s = Math.sin(BOAT.yaw);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}
function toWorld(lx, lz, out) {
  const c = Math.cos(BOAT.yaw), s = Math.sin(BOAT.yaw);
  out.x = BOAT.x + lx * c + lz * s;
  out.z = BOAT.z - lx * s + lz * c;
  return out;
}
const _l = { x: 0, z: 0 }, _w = { x: 0, z: 0 };
const insideFloor = (l, m = 0) => l.z > FLOOR_Z0 + m && l.z < FLOOR_Z1 - m && Math.abs(l.x) < floorHalf(l.z) - m;
const insideHull = (l, m = 0) => l.z > -3.1 - m && l.z < 2.95 + m && Math.abs(l.x) < hullHalf(l.z) + m;
const deckY = () => BOAT.y + FLOOR_Y;

function placeBoatMesh(t) {
  const bob = 0.05 * Math.sin(t * 1.3) + 0.025 * Math.sin(t * 2.9 + 1);
  BOAT.y = W + bob - Math.min(0.12, Math.abs(BOAT.speed) * 0.006);
  BOAT.pitch = 0.012 * Math.sin(t * 1.1) + Math.min(0.09, Math.max(-0.03, BOAT.speed * 0.008)) * (BOAT.speed > 9 ? 0.6 : 1);
  BOAT.roll = 0.02 * Math.sin(t * 0.9 + 0.5) + BOAT.yawRate * Math.abs(BOAT.speed) * 0.012;
  BOAT.group.position.set(BOAT.x, BOAT.y, BOAT.z);
  BOAT.group.rotation.set(BOAT.pitch, BOAT.yaw, BOAT.roll);
}

function depthPlanAt(x, z) {
  return onJetty(x, -z, 0.25) ? -1 : W - terrainAt(x, z);
}

function stepBoat(dt, t) {
  const px = BOAT.x, pz = BOAT.z, pyaw = BOAT.yaw;
  if (BOAT.driving) {
    const tk = BOAT.test || keys;
    BOAT.throttle = (tk.KeyW ? 1 : 0) - (tk.KeyS ? 1 : 0);
    BOAT.steer = (tk.KeyA ? 1 : 0) - (tk.KeyD ? 1 : 0);
  } else BOAT.throttle = BOAT.steer = 0;
  const target = BOAT.throttle > 0 ? 14 : BOAT.throttle < 0 ? -3.5 : 0;
  const accel = BOAT.throttle > 0 ? 4.2 : BOAT.throttle < 0 ? 5 : 0;
  if (BOAT.throttle) BOAT.speed += Math.sign(target - BOAT.speed) * Math.min(Math.abs(target - BOAT.speed), accel * dt);
  BOAT.speed *= Math.exp(-(BOAT.throttle ? 0.08 : 0.45) * dt);
  const grip = Math.min(1, Math.abs(BOAT.speed) / 4) * Math.sign(BOAT.speed || 1);
  BOAT.yawRate += (BOAT.steer * 0.85 * grip - BOAT.yawRate) * Math.min(1, dt * 3);
  BOAT.yaw += BOAT.yawRate * dt;
  BOAT.x += -Math.sin(BOAT.yaw) * BOAT.speed * dt;
  BOAT.z += -Math.cos(BOAT.yaw) * BOAT.speed * dt;
  // Shallows, the jetty and the edge of the play area.
  let hit = false;
  for (const [lx, lz] of [[0, -3.0], [-1.0, -1.2], [1.0, -1.2], [-1.1, 2.8], [1.1, 2.8]]) {
    toWorld(lx, lz, _w);
    if (depthPlanAt(_w.x, _w.z) < 0.55) hit = true;
  }
  const rx = BOAT.x - AX, ry = -BOAT.z - AY;
  if (Math.hypot(rx, ry) > 520) hit = true;
  if (hit) {
    BOAT.x = px;
    BOAT.z = pz;
    BOAT.yaw = pyaw;
    if (Math.abs(BOAT.speed) > 3) {
      NZ.sound.thud?.(Math.min(1, Math.abs(BOAT.speed) / 10));
      splash(BOAT.x, BOAT.z, 20, 3);
    }
    BOAT.speed *= -0.25;
    BOAT.yawRate *= 0.3;
  }
  placeBoatMesh(t);
  // Carry whatever is aboard by the change in position and heading.
  const dyaw = BOAT.yaw - pyaw;
  if (BOAT.x !== px || BOAT.z !== pz || dyaw) {
    const carry = (v) => {
      const dx = v.x - px, dz = v.z - pz, c = Math.cos(-pyaw), s = Math.sin(-pyaw);
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      toWorld(lx, lz, _w);
      return [_w.x - v.x, _w.z - v.z];
    };
    if (BOAT.aboard || BOAT.driving) {
      const [mx, mz] = carry(player.collider.start);
      player.collider.translate(new V3(mx, 0, mz));
      player.yaw += dyaw;
    }
    for (const z of zombies) {
      if (!z.aboard) continue;
      const [mx, mz] = carry(z.pos);
      z.pos.x += mx;
      z.pos.z += mz;
      z.heading -= 0;
      if (z.state === 'dead') z.root.position.set(z.pos.x, z.root.position.y, z.pos.z);
    }
  }
  // Wake and spray.
  const sp = Math.abs(BOAT.speed);
  if (sp > 0.6) {
    const n = Math.min(6, Math.ceil(sp * dt * 30));
    for (let k = 0; k < n; k++) {
      const side = k % 2 ? 1 : -1;
      toWorld(side * (0.85 + Math.random() * 0.4), 2.6 + Math.random() * 0.8, _w);
      const ox = -Math.cos(BOAT.yaw) * side * sp * (0.08 + Math.random() * 0.06), oz = Math.sin(BOAT.yaw) * side * sp * (0.08 + Math.random() * 0.06);
      foamAt(_w.x, _w.z, ox, oz, 3 + Math.random() * 3, 0.2, 0.55 + sp * 0.03);
      toWorld((Math.random() - 0.5) * 0.7, 3.2 + Math.random() * 0.5, _w);
      foamAt(_w.x, _w.z, 0, 0, 2 + Math.random() * 1.5, 0.3, 0.6);
    }
    if (sp > 5 && Math.random() < sp * dt * 3) {
      const side = Math.random() < 0.5 ? -1 : 1;
      toWorld(side * 0.75, -1.8, _w);
      NZ.emit(new V3(_w.x, W + 0.3, _w.z), 5, [0.55, 0.6, 0.7], 2.2, 2.6, 0.6);
    }
  } else if (Math.random() < dt * 1.5) {
    toWorld((Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 5.6, _w);
    foamAt(_w.x, _w.z, 0, 0, 2.5, 0.4, 0.8);
  }
}

// Player standing on the boat: deck support, gunwales, console.
function boatSupport() {
  if (BOAT.driving) return;
  const feet = player.collider.start.y - 0.35;
  toLocal(player.collider.start.x, player.collider.start.z, _l);
  const floor = _l.z < FLOOR_Z0 ? BOAT.y + FORE_Y : deckY();
  const wasAboard = BOAT.aboard;
  BOAT.aboard = false;
  if (!insideHull(_l, 0.1)) return;
  if (feet > floor + 0.45 && !wasAboard) return; // still in the air above it
  if (feet < floor - 0.7 && !wasAboard) return; // in the water beside it (swimming handles that)
  // Gunwales: stay in the cockpit unless jumping clear.
  if (feet < BOAT.y + GUNWALE_Y + 0.2) {
    if (!insideFloor(_l, 0.1) && _l.z >= FLOOR_Z0) {
      _l.z = Math.min(FLOOR_Z1 - 0.12, Math.max(FLOOR_Z0 + 0.12, _l.z));
      _l.x = Math.max(-floorHalf(_l.z) + 0.12, Math.min(floorHalf(_l.z) - 0.12, _l.x));
    }
    if (_l.z < FLOOR_Z0 && feet < BOAT.y + FORE_Y - 0.25) _l.z = FLOOR_Z0 + 0.05;
  }
  // Console block.
  if (_l.x > HELM.x - 0.42 && _l.x < HELM.x + 0.42 && _l.z > -0.84 && _l.z < -0.16) _l.z = _l.z < -0.5 ? -0.84 : -0.16;
  toWorld(_l.x, _l.z, _w);
  const f = _l.z < FLOOR_Z0 ? BOAT.y + FORE_Y : deckY();
  if (player.vel.y > 1 && feet > f + 0.02) {
    BOAT.aboard = wasAboard && feet < f + 1.6;
    return; // mid-jump
  }
  const dy = f + 0.35 - player.collider.start.y;
  player.collider.translate(new V3(_w.x - player.collider.start.x, dy, _w.z - player.collider.start.z));
  player.vel.y = Math.max(0, player.vel.y);
  player.onFloor = true;
  BOAT.aboard = true;
}

// ------------------------------------------------------------------ driving
function takeHelm() {
  if (player.control || NZ.vehicle) return;
  BOAT.driving = true;
  BOAT.aboard = true;
  if (NZ.vehicle == null) NZ.vehicle = BOAT_VEHICLE;
  player.control = driveControl;
  player.yaw = BOAT.yaw;
  player.pitch = -0.08;
  weapon.firing = false;
  weapon.ads = false;
  BOAT.chase.set(BOAT.x, BOAT.y + 3, BOAT.z).addScaledVector(new V3(Math.sin(BOAT.yaw), 0, Math.cos(BOAT.yaw)), 9);
  engine(true);
  NZ.hint('W/S throttle · A/D steer · V chase / seated view · E leave the helm', 6);
}
function leaveHelm() {
  BOAT.driving = false;
  player.control = null;
  if (NZ.vehicle === BOAT_VEHICLE) NZ.vehicle = null;
  toWorld(HELM.x - 0.75, HELM.z - 0.1, _w);
  const y = deckY() + 0.36;
  player.collider.start.set(_w.x, y, _w.z);
  player.collider.end.set(_w.x, y + 1.26, _w.z);
  player.vel.set(0, 0, 0);
  player.roll = 0;
  engine(false);
}
const BOAT_VEHICLE = { kind: 'boat', get speed() { return BOAT.speed; }, leave: () => BOAT.driving && leaveHelm(), boat: BOAT };

const _cam = new V3(), _look = new V3();
function driveControl(dt) {
  toWorld(HELM.x, HELM.z, _w);
  const seat = deckY() + 0.5;
  player.collider.start.set(_w.x, seat, _w.z);
  player.collider.end.set(_w.x, seat + 1.26, _w.z);
  player.vel.set(-Math.sin(BOAT.yaw) * BOAT.speed, 0, -Math.cos(BOAT.yaw) * BOAT.speed);
  if (BOAT.view === 'seat') {
    camera.position.set(_w.x, deckY() + 1.55, _w.z);
    camera.rotation.set(player.pitch + BOAT.pitch * 0.6, player.yaw, BOAT.roll * 0.8);
  } else {
    const fx = -Math.sin(BOAT.yaw), fz = -Math.cos(BOAT.yaw);
    _cam.set(BOAT.x - fx * 9.5, BOAT.y + 3.4, BOAT.z - fz * 9.5);
    BOAT.chase.lerp(_cam, Math.min(1, dt * 4));
    BOAT.chase.y = Math.max(BOAT.chase.y, W + 1.5);
    camera.position.copy(BOAT.chase);
    _look.set(BOAT.x + fx * 4, BOAT.y + 1.1, BOAT.z + fz * 4);
    camera.lookAt(_look);
    player.yaw = BOAT.yaw;
  }
}

// ------------------------------------------------------------------ audio: lapping, engine, splashes
const audio = { lap: null, eng: null };
function ensureAudio() {
  const ctx = sound.ctx;
  if (!ctx || audio.lap) return !!audio.lap;
  const n = sound.noiseSrc(true), bp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
  bp.type = 'bandpass';
  bp.frequency.value = 520;
  bp.Q.value = 0.6;
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  g.gain.value = 0;
  n.connect(bp).connect(lp).connect(g).connect(sound.master);
  n.start();
  audio.lap = { g, bp };
  // Outboard: two detuned saws + a sub, low-passed, positioned at the stern.
  const eg = ctx.createGain(), elp = ctx.createBiquadFilter(), pan = ctx.createPanner();
  eg.gain.value = 0;
  elp.type = 'lowpass';
  elp.frequency.value = 500;
  pan.panningModel = 'equalpower';
  pan.distanceModel = 'inverse';
  pan.refDistance = 4;
  pan.rolloffFactor = 1.2;
  const oscs = [];
  for (const [type, mul, vol] of [['sawtooth', 1, 0.5], ['sawtooth', 1.012, 0.4], ['square', 0.5, 0.35]]) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = type;
    o.frequency.value = 40 * mul;
    og.gain.value = vol;
    o.connect(og).connect(elp);
    o.start();
    oscs.push([o, mul]);
  }
  const rush = sound.noiseSrc(true), rg = ctx.createGain(), rf = ctx.createBiquadFilter();
  rf.type = 'bandpass';
  rf.frequency.value = 900;
  rg.gain.value = 0;
  rush.connect(rf).connect(rg).connect(pan);
  rush.start();
  elp.connect(eg).connect(pan).connect(sound.master);
  audio.eng = { eg, elp, pan, oscs, rg, on: false };
  return true;
}
function engine(on) {
  if (!ensureAudio()) return;
  audio.eng.on = on;
  if (on) sound.thud?.(0.4);
}
function updateAudio(dt, t) {
  if (!ensureAudio()) return;
  const ctx = sound.ctx, now = ctx.currentTime;
  // Lapping: louder the closer you are to the waterline.
  const c = navCellPlan(camera.position.x, -camera.position.z);
  const shoreM = c >= 0 ? navShore[c] * NAV.cs : 200;
  const near = Math.max(0, 1 - shoreM / 34) * (camera.position.y < W + 12 ? 1 : 0.4);
  const swell = (0.55 + 0.45 * Math.sin(t * 0.83)) * (0.6 + 0.4 * Math.sin(t * 2.1 + Math.sin(t * 0.6) * 2));
  audio.lap.g.gain.setTargetAtTime(near * swell * 0.16, now, 0.15);
  audio.lap.bp.frequency.setTargetAtTime(380 + swell * 420, now, 0.2);
  const e = audio.eng;
  const sp = Math.abs(BOAT.speed);
  BOAT.rpm += ((e.on ? 0.25 + Math.abs(BOAT.throttle) * 0.75 : 0) - BOAT.rpm) * Math.min(1, dt * 2.5);
  for (const [o, mul] of e.oscs) o.frequency.setTargetAtTime((34 + BOAT.rpm * 70 + sp * 2) * mul, now, 0.05);
  e.elp.frequency.setTargetAtTime(300 + BOAT.rpm * 1300, now, 0.08);
  e.eg.gain.setTargetAtTime(e.on ? 0.05 + BOAT.rpm * 0.09 : 0, now, e.on ? 0.1 : 0.4);
  e.rg.gain.setTargetAtTime(Math.min(0.12, sp * 0.009), now, 0.2);
  toWorld(0, 3.1, _w);
  if (e.pan.positionX) {
    e.pan.positionX.value = _w.x;
    e.pan.positionY.value = BOAT.y + 0.6;
    e.pan.positionZ.value = _w.z;
  } else e.pan.setPosition(_w.x, BOAT.y + 0.6, _w.z);
}
function splashSound(vol = 0.3) {
  const ctx = sound.ctx;
  if (!ctx) return;
  const t = ctx.currentTime, n = sound.noiseSrc(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(1400, t);
  f.frequency.exponentialRampToValueAtTime(400, t + 0.3);
  f.Q.value = 0.8;
  sound.env(g, t, 0.01, vol, 0.35);
  n.connect(f).connect(g).connect(sound.master);
  n.start(t, Math.random());
  n.stop(t + 0.45);
}

// ------------------------------------------------------------------ the player in the water
const swim = { on: false, wading: 0, stamina: 1, splashT: 0, bar: null, hintT: 0 };
function buildHud() {
  const st = document.createElement('style');
  st.textContent = `#stamina{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);width:220px;height:7px;border-radius:4px;
    background:rgba(0,0,0,.45);box-shadow:0 0 0 1px rgba(160,200,230,.35);opacity:0;transition:opacity .4s}
    #stamina.on{opacity:1} #stamina i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#4f8fb8,#a9dcf2)}
    #stamina.low i{background:linear-gradient(90deg,#a33,#e66)}
    #stamina b{position:absolute;left:0;right:0;top:-18px;text-align:center;font:600 11px Oswald,sans-serif;letter-spacing:.2em;color:#a9dcf2;opacity:.8}`;
  document.head.appendChild(st);
  swim.bar = document.createElement('div');
  swim.bar.id = 'stamina';
  swim.bar.innerHTML = '<b>STAMINA</b><i></i>';
  NZ.$('hud').appendChild(swim.bar);
}

function updatePlayerWater(dt, t) {
  if (BOAT.driving) {
    swim.on = false;
    swim.wading = 0;
    return;
  }
  const cs = player.collider.start, feet = cs.y - 0.35;
  const bed = terrainAt(cs.x, cs.z), depth = W - bed;
  const onJ = onJetty(cs.x, -cs.z, 0.1) && feet > J.deck - 0.3;
  const wasSwim = swim.on;
  if (BOAT.aboard || onJ) swim.on = false;
  else if (!swim.on && depth > 1.5 && feet < W - 0.25) swim.on = true;
  else if (swim.on && depth < 1.3) swim.on = false;
  if (swim.on !== wasSwim) {
    splash(cs.x, cs.z, 18, 3);
    splashSound(0.35);
  }
  const sub = W - feet;
  swim.wading = !swim.on && !BOAT.aboard && !onJ && sub > 0.12 ? Math.min(1, sub / 0.9) : 0;
  if (swim.on) {
    // Float at the surface, slow swim, no weapons; stamina pushes you back to shore.
    const sprint = keys.ShiftLeft || keys.ShiftRight;
    swim.stamina = Math.max(0, swim.stamina - dt / (sprint ? 13 : 24));
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    let ix = 0, iz = 0;
    if (keys.KeyW) { ix += fx; iz += fz; }
    if (keys.KeyS) { ix -= fx; iz -= fz; }
    if (keys.KeyA) { ix += fz; iz -= fx; }
    if (keys.KeyD) { ix -= fz; iz += fx; }
    const il = Math.hypot(ix, iz) || 1;
    let speed = (sprint && swim.stamina > 0 ? 2.4 : 1.7) * (swim.stamina > 0 ? 1 : 0.35);
    let vx = (ix / il) * speed, vz = (iz / il) * speed;
    if (swim.stamina <= 0) {
      // Exhausted: the swell carries you towards the nearest shallows.
      const gx = heightPlan(cs.x + 3, -cs.z) - heightPlan(cs.x - 3, -cs.z), gy = heightPlan(cs.x, -cs.z + 3) - heightPlan(cs.x, -cs.z - 3);
      const gl = Math.hypot(gx, gy) || 1;
      vx += (gx / gl) * 1.3;
      vz += (-gy / gl) * 1.3;
      if (t - swim.hintT > 5) {
        swim.hintT = t;
        NZ.hint('Exhausted — the lake pushes you back to shore', 3);
      }
    }
    const k = 1 - Math.exp(-4 * dt);
    player.vel.x += (vx - player.vel.x) * k;
    player.vel.z += (vz - player.vel.z) * k;
    player.vel.y = 0;
    const eye = W + 0.2 + Math.sin(t * 1.8) * 0.045;
    player.collider.translate(new V3(0, eye - player.collider.end.y, 0));
    player.onFloor = false;
    keys.Space = false;
    // The hull is solid from the water; Space next to it climbs aboard.
    toLocal(cs.x, cs.z, _l);
    if (insideHull(_l, 0.45)) {
      if (keys.Space || BOAT.wantClimb) {
        BOAT.wantClimb = false;
        const lz = Math.min(FLOOR_Z1 - 0.3, Math.max(FLOOR_Z0 + 0.3, _l.z));
        toWorld(Math.sign(_l.x) * (floorHalf(lz) - 0.3), lz, _w);
        const y = deckY() + 0.36;
        player.collider.start.set(_w.x, y, _w.z);
        player.collider.end.set(_w.x, y + 1.26, _w.z);
        player.vel.set(0, 0, 0);
        swim.on = false;
        BOAT.aboard = true;
        splashSound(0.25);
      } else {
        if (t - BOAT.lastHint > 4) {
          BOAT.lastHint = t;
          NZ.hint('Space — climb aboard', 2.5);
        }
        if (insideHull(_l, 0.3)) {
          const lx = Math.sign(_l.x || 1) * (hullHalf(_l.z) + 0.3);
          toWorld(lx, _l.z, _w);
          player.collider.translate(new V3(_w.x - cs.x, 0, _w.z - cs.z));
        }
      }
    }
    swim.splashT -= dt;
    if (swim.splashT <= 0 && Math.hypot(player.vel.x, player.vel.z) > 0.6) {
      swim.splashT = 0.45;
      splash(cs.x + player.vel.x * 0.3, cs.z + player.vel.z * 0.3, 4, 1.4);
      foamAt(cs.x, cs.z, 0, 0, 2.5, 0.5, 1.6);
    }
  } else {
    swim.stamina = Math.min(1, swim.stamina + dt / 5);
    if (swim.wading > 0) {
      const damp = Math.exp(-3.2 * swim.wading * dt);
      player.vel.x *= damp;
      player.vel.z *= damp;
      swim.splashT -= dt;
      const sp = Math.hypot(player.vel.x, player.vel.z);
      if (swim.splashT <= 0 && sp > 0.5) {
        swim.splashT = 0.32 - Math.min(0.15, sp * 0.03);
        splash(cs.x + player.vel.x * 0.15, cs.z + player.vel.z * 0.15, 5, 1.6 + swim.wading);
        foamAt(cs.x, cs.z, 0, 0, 2, 0.4, 1.2);
        if (Math.random() < 0.5) splashSound(0.08 + swim.wading * 0.08);
      }
    }
  }
  swim.bar.classList.toggle('on', swim.on || swim.stamina < 0.97);
  swim.bar.classList.toggle('low', swim.stamina < 0.25);
  swim.bar.lastChild.style.width = (swim.stamina * 100).toFixed(1) + '%';
}

function lockWeapons() {
  // Swimming or at the helm: no shooting, no reloading, no knife; the gun drops out of view.
  weapon.firing = false;
  weapon.ads = false;
  weapon.cd = Math.max(weapon.cd, 0.25);
  weapon.knife = Math.max(weapon.knife, 0.001);
  if (weapon.reloading > 0) weapon.reloading = weapon.reloadTime;
  NZ.view.position.y -= 0.5;
  if (BOAT.driving) NZ.view.visible = false;
}

// ------------------------------------------------------------------ zombies: water, crew, boarding
const CREW_SPOTS = [[-0.45, 0.95], [0.5, 1.75], [-0.35, -0.9], [0.1, 2.2], [0.55, -1.15]];
function spawnCrew() {
  BOAT.crewRound = NZ.ROUND.n;
  BOAT.crewIdle = true;
  const n = 3 + ((Math.random() * 3) | 0);
  for (let k = 0; k < n; k++) {
    const [lx, lz] = CREW_SPOTS[k];
    toWorld(lx, lz, _w);
    NZ.spawnZombie({ x: _w.x, y: -_w.z, z: deckY(), c: -1 });
    const z = zombies[zombies.length - 1];
    Object.assign(z, { crew: true, aboard: true, state: 'walk', t: 0, update: crewIdle });
    z.root.position.copy(z.pos);
  }
}
function crewIdle(z, dt, t) {
  z.t += dt;
  z.phase += dt * 1.2;
  const pp = player.collider.start;
  const want = Math.atan2(pp.x - z.pos.x, pp.z - z.pos.z);
  let dh = want - z.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  z.heading += dh * Math.min(1, dt * 0.8);
  z.legL.rotation.x = z.legR.rotation.x = 0;
  z.spine.rotation.x = 0.3 + 0.05 * Math.sin(z.phase);
  z.spine.rotation.z = z.sway + Math.sin(z.phase * 0.7) * 0.1;
  z.neck.rotation.z = Math.sin(t * 0.7 + z.phase) * 0.35;
  z.armL.rotation.x = -0.4 + Math.sin(z.phase) * 0.12;
  z.armR.rotation.x = -0.3 + Math.sin(z.phase + 1) * 0.12;
  z.root.position.copy(z.pos);
  z.root.rotation.y = z.heading;
  z.groanT -= dt;
  if (z.groanT <= 0) {
    z.groanT = 4 + Math.random() * 8;
    if (Math.hypot(pp.x - z.pos.x, pp.z - z.pos.z) < 45) sound.groan(z.pos, 0.85);
  }
}
function wakeCrew() {
  if (!BOAT.crewIdle) return;
  BOAT.crewIdle = false;
  let n = 0;
  for (const z of zombies) if (z.crew && z.update === crewIdle) { delete z.update; n++; }
  if (n) {
    NZ.message('All hands', false, 2);
    sound.groan(BOAT.group.position, 1.15, true);
  }
}
function updateCrew() {
  const pp = player.collider.start, d = Math.hypot(pp.x - BOAT.x, pp.z - BOAT.z);
  const alive = zombies.filter((z) => z.crew && z.state !== 'dead');
  if (!alive.length && BOAT.crewRound !== NZ.ROUND.n && NZ.ROUND.n > 0 && d < 70 && d > 25) spawnCrew();
  if (BOAT.crewIdle && (BOAT.aboard || d < 6)) wakeCrew();
  // Wander off and the idle crew slips back under; they come back next round.
  if (BOAT.crewIdle && d > 110) {
    for (const z of alive) {
      NZ.scene.remove(z.root);
      z.state = 'dead';
      z.remove = true;
    }
    NZ.refreshHitMeshes();
    BOAT.crewIdle = false;
    BOAT.crewRound = -1;
  }
}

function zombieInWater(z, dt) {
  // Before the default brain: slower in the water, coarse-flow steering outside the house grid.
  if (z.baseSpeed === undefined) z.baseSpeed = z.speed;
  const bed = z.aboard ? deckY() : onJetty(z.pos.x, -z.pos.z, 0.2) ? J.deck : terrainAt(z.pos.x, z.pos.z);
  const depth = W - bed;
  z.wade = z.aboard ? 0 : depth > 1.45 ? 2 : depth > 0.15 ? 1 : 0;
  z.speed = z.baseSpeed * (z.wade === 2 ? 0.4 : z.wade === 1 ? 0.55 : 1);
  if (NZ.cellOf(z.pos.x, z.pos.z) >= 0) z.goal = null;
  else if (!navGoal(z)) z.goal = null;
}

function zombiesAfterBrain(dt, t) {
  for (const z of zombies) {
    if (z.update && z.update !== crewIdle) continue; // other teams' custom enemies
    if (z.aboard) {
      toLocal(z.pos.x, z.pos.z, _l);
      if (z.state !== 'dead') {
        _l.z = Math.min(FLOOR_Z1 - 0.25, Math.max(FLOOR_Z0 + 0.25, _l.z));
        _l.x = Math.max(-floorHalf(_l.z) + 0.25, Math.min(floorHalf(_l.z) - 0.25, _l.x));
        toWorld(_l.x, _l.z, _w);
        z.pos.x = _w.x;
        z.pos.z = _w.z;
        z.pos.y = deckY();
        if (z.state !== 'rising') z.root.position.copy(z.pos);
      }
      continue;
    }
    if (z.state === 'dead' || z.state === 'rising') continue;
    if (NZ.cellOf(z.pos.x, z.pos.z) >= 0) continue;
    // Swimmers and waders reaching the hull clamber over the gunwale.
    toLocal(z.pos.x, z.pos.z, _l);
    if (insideHull(_l, 0.35) && (z.wade || Math.abs(z.pos.y - deckY()) < 1)) {
      z.aboard = true;
      splash(z.pos.x, z.pos.z, 12, 2.5);
      sound.groan(z.pos, 1.1, true);
      continue;
    }
    if (!z.wade) continue;
    if (z.wade === 2) {
      z.pos.y += (W - 1.25 - z.pos.y) * Math.min(1, dt * 6);
      z.root.position.y = z.pos.y;
      z.spine.rotation.x = 0.9;
      z.armL.rotation.x = -1.6 + Math.sin(z.phase * 0.8) * 1.1;
      z.armR.rotation.x = -1.6 - Math.sin(z.phase * 0.8) * 1.1;
      z.legL.rotation.x = Math.sin(z.phase * 2) * 0.3;
      z.legR.rotation.x = -Math.sin(z.phase * 2) * 0.3;
    }
    if (Math.random() < dt * (z.wade === 2 ? 3 : 2.2)) {
      splash(z.pos.x, z.pos.z, 3, 1.3);
      foamAt(z.pos.x, z.pos.z, 0, 0, 2.2, 0.5, 1.4);
    }
  }
}

// ------------------------------------------------------------------ hooks
let water = null, ready = false, spawnT = 0;
hooks.ready.push(() => {
  buildNav();
  prepareOuterSpawns();
  buildMiniUnder();
  water = buildWater();
  buildFoam();
  buildPath();
  plantSlope();
  buildLantern();
  buildBoat();
  buildHud();
  ready = true;
});

hooks.frame.push((dt, t, state) => {
  if (!ready) return;
  waterUniforms.time.value = t;
  swayTime.value = t;
  if (scene.fog) waterUniforms.horizon.value.copy(scene.fog.color);
  water.position.x = camera.position.x;
  water.position.z = camera.position.z;
  waterUniforms.lampPos.value[0].copy(lantern.position);
  waterUniforms.lampCol.value[0].setRGB(1.0, 0.55, 0.25).multiplyScalar(lantern.intensity / 6);
  toWorld(-0.75, 2.6, _w);
  waterUniforms.lampPos.value[1].set(_w.x, BOAT.y + 2.1, _w.z);
  waterUniforms.lampCol.value[1].setRGB(0.5, 0.48, 0.45);
  lantern.intensity = 6 * (0.85 + 0.1 * Math.sin(t * 7.3 + lantern.userData.phase) + 0.05 * Math.sin(t * 17.1));
  if (state === 'playing') stepBoat(dt, t);
  else placeBoatMesh(t);
  updateFoam(dt);
});

hooks.update.push((dt, t) => {
  if (!ready) return;
  const otherControl = player.control && !BOAT.driving; // someone else's vehicle owns the player
  if (!otherControl) {
    boatSupport();
    updatePlayerWater(dt, t);
  }
  if (!BOAT.driving && !otherControl) {
    camera.position.copy(player.collider.end);
    // Near the helm: offer the wheel.
    if (BOAT.aboard) {
      toLocal(player.collider.start.x, player.collider.start.z, _l);
      if (Math.hypot(_l.x - HELM.x, _l.z - HELM.z) < 1.3 && t - BOAT.lastHint > 6) {
        BOAT.lastHint = t;
        NZ.hint('E — take the helm', 2.5);
      }
    }
  }
  if (!otherControl && (swim.on || BOAT.driving)) lockWeapons();
  zombiesAfterBrain(dt, t);
  updateCrew();
  // Coarse flow field over the whole map, toward the player.
  navT -= dt;
  const pc = navCellPlan(player.collider.start.x, -player.collider.start.z);
  if (pc !== navSource && navT <= 0) {
    navSource = pc;
    navT = 0.3;
    computeNavFlow(pc);
  }
  spawnT -= dt;
  if (spawnT <= 0 || Math.hypot(player.collider.start.x - spawnFrom.x, -player.collider.start.z - spawnFrom.z) > 8) {
    spawnT = 1;
    refreshSpawns();
  }
  updateAudio(dt, t);
});

hooks.zombieUpdate.push((z, dt) => {
  if (ready) zombieInWater(z, dt);
});

hooks.zombieSpawn.push((z) => {
  if (W - terrainAt(z.pos.x, z.pos.z) > 0.05) splash(z.pos.x, z.pos.z, 14, 2.5);
});

hooks.zombieDamage.push((z) => {
  if (z.crew && BOAT.crewIdle) wakeCrew();
});

hooks.kill.push((z) => {
  if (z.update === crewIdle) delete z.update;
});

hooks.key.push((code) => {
  if (!ready) return;
  if (code === 'KeyE') {
    if (BOAT.driving) leaveHelm();
    else if (BOAT.aboard) {
      toLocal(player.collider.start.x, player.collider.start.z, _l);
      if (Math.hypot(_l.x - HELM.x, _l.z - HELM.z) < 1.4) takeHelm();
    }
  }
  if (code === 'KeyV' && BOAT.driving) BOAT.view = BOAT.view === 'seat' ? 'chase' : 'seat';
});

hooks.reset.push(() => {
  if (BOAT.driving) leaveHelm();
  BOAT.aboard = false;
  BOAT.crewIdle = false;
  BOAT.crewRound = -1;
  swim.on = false;
  swim.stamina = 1;
  if (BOAT.group) resetBoat();
});

// ------------------------------------------------------------------ test hooks
window.__game_world = {
  get state() {
    const p = player.collider.start;
    return {
      x: +p.x.toFixed(2), y: +(-p.z).toFixed(2), feet: +(p.y - 0.35).toFixed(2), ground: +terrainAt(p.x, p.z).toFixed(2),
      depth: +(W - terrainAt(p.x, p.z)).toFixed(2), swimming: swim.on, wading: +swim.wading.toFixed(2), stamina: +swim.stamina.toFixed(2),
      aboard: BOAT.aboard, driving: BOAT.driving, view: BOAT.view,
      boat: { x: +BOAT.x.toFixed(1), y: +(-BOAT.z).toFixed(1), yaw: +BOAT.yaw.toFixed(2), speed: +BOAT.speed.toFixed(2) },
      crew: zombies.filter((z) => z.crew && z.state !== 'dead').length, crewIdle: BOAT.crewIdle,
      aboardZombies: zombies.filter((z) => z.aboard && z.state !== 'dead').length,
      navFlow: navFlow[navCellPlan(p.x, -p.z)] ?? null, place: NZ.placeName(p.x, -p.z),
    };
  },
  jetty: J, water: W, nav: { ...NAV }, home: BOAT.home,
  // Plan coords + yaw (radians, three.js player yaw).
  teleport(x, y, yaw) { NZ.placePlayer(x, y, yaw ?? player.yaw); },
  toTerrace() { NZ.placePlayer(55, 52, -0.42); player.pitch = -0.1; },
  toJetty() { NZ.placePlayer(J.a[0] - JD.x * 3, J.a[1] - JD.y * 3, Math.atan2(-JD.x, JD.y)); player.pitch = -0.1; },
  toWater(along = 12, across = 12) {
    const x = J.a[0] + JD.x * along - JD.y * across, y = J.a[1] + JD.y * along + JD.x * across;
    NZ.placePlayer(x, y, Math.atan2(-JD.x, JD.y));
  },
  aimNearest() {
    const c = camera.position;
    let best = null, bd = 1e9;
    for (const z of zombies) {
      if (z.state === 'dead') continue;
      const d = c.distanceTo(z.pos);
      if (d < bd) { bd = d; best = z; }
    }
    if (!best) return null;
    const dx = best.pos.x - c.x, dz = best.pos.z - c.z, dy = best.pos.y + 1.4 - c.y;
    player.yaw = Math.atan2(-dx, -dz);
    player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return +bd.toFixed(1);
  },
  board(fore = false) {
    toWorld(fore ? 0 : -0.2, fore ? -2.45 : -1.2, _w);
    const y = (fore ? BOAT.y + FORE_Y : deckY()) + 0.36;
    player.collider.start.set(_w.x, y, _w.z);
    player.collider.end.set(_w.x, y + 1.26, _w.z);
    player.vel.set(0, 0, 0);
    player.yaw = BOAT.yaw + Math.PI;
    BOAT.aboard = true;
  },
  spawnCrew() { if (!zombies.some((z) => z.crew && z.state !== 'dead')) spawnCrew(); },
  wakeCrew,
  helm() {
    toWorld(HELM.x, HELM.z + 0.2, _w);
    const y = deckY() + 0.36;
    player.collider.start.set(_w.x, y, _w.z);
    player.collider.end.set(_w.x, y + 1.26, _w.z);
    BOAT.aboard = true;
    takeHelm();
  },
  leave() { if (BOAT.driving) leaveHelm(); },
  drive(throttle, steer) {
    BOAT.test = throttle === null ? null : { KeyW: throttle > 0, KeyS: throttle < 0, KeyA: steer > 0, KeyD: steer < 0 };
  },
  view(v) { BOAT.view = v; },
  tire() { swim.stamina = 0; },
  spawnSwimmers(n = 4) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU, r = 10 + Math.random() * 6;
      const x = BOAT.x + Math.cos(a) * r, z = BOAT.z + Math.sin(a) * r;
      if (W - terrainAt(x, z) < 0.2) continue;
      NZ.spawnZombie({ x, y: -z, z: terrainAt(x, z), c: -1 });
    }
  },
};
