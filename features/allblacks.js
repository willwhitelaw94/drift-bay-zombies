// All Blacks zombies: every humanoid zombie is restyled in a torn black rugby jersey
// (silver fern, white collar, a number 1–23 on the back), black shorts, black socks with
// white tops and grey-green skin. Textures/materials are built once and shared.
const NZ = window.NZ;
const { THREE } = NZ;

const SKIN = ['#76846b', '#83907a', '#6c7a66'];

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function knit(g, w, h, r) {
  g.fillStyle = '#0c0c0e';
  g.fillRect(0, 0, w, h);
  // Fine vertical ribs and a faint horizontal stitch.
  for (let x = 0; x < w; x += 3) {
    g.fillStyle = `rgba(60,62,70,${0.18 + r() * 0.12})`;
    g.fillRect(x, 0, 1, h);
  }
  for (let y = 0; y < h; y += 4) {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, y, w, 1);
  }
  for (let k = 0; k < (w * h) / 60; k++) {
    g.fillStyle = `rgba(90,90,100,${r() * 0.18})`;
    g.fillRect(r() * w, r() * h, 1.5, 1.5);
  }
}

function tear(g, x, y, s, r, skin) {
  // A ragged hole showing grey-green skin, rimmed with blood.
  const n = 9, pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, rr = s * (0.55 + r() * 0.6);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8]);
  }
  const path = () => {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.closePath();
  };
  const blood = g.createRadialGradient(x, y, s * 0.3, x, y, s * 2.1);
  blood.addColorStop(0, 'rgba(110,8,6,0.95)');
  blood.addColorStop(1, 'rgba(60,0,0,0)');
  g.fillStyle = blood;
  g.fillRect(x - s * 2.2, y - s * 2.2, s * 4.4, s * 4.4);
  path();
  g.fillStyle = skin;
  g.fill();
  g.strokeStyle = '#3a0303';
  g.lineWidth = 3;
  g.stroke();
  // Claw scratches and a drip or two.
  g.strokeStyle = 'rgba(120,10,8,0.9)';
  g.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    g.beginPath();
    g.moveTo(x - s + k * s * 0.5, y - s * 0.4);
    g.lineTo(x - s * 0.2 + k * s * 0.5, y + s * 0.9);
    g.stroke();
  }
  g.fillStyle = 'rgba(95,4,4,0.9)';
  for (let k = 0; k < 2; k++) g.fillRect(x + (r() - 0.5) * s, y + s * 0.6, 2.5, s * (1 + r() * 2));
}

function fern(g, x, y, L, angle) {
  // The silver fern: a curved frond with paired leaflets tapering to the tip.
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = g.strokeStyle = '#dfe2e6';
  g.shadowColor = 'rgba(255,255,255,0.35)';
  g.shadowBlur = 3;
  const stem = (t) => [Math.sin(t * 1.4) * L * 0.14, -t * L];
  g.lineWidth = Math.max(1.5, L * 0.025);
  g.beginPath();
  for (let i = 0; i <= 20; i++) {
    const [sx, sy] = stem(i / 20);
    i ? g.lineTo(sx, sy) : g.moveTo(sx, sy);
  }
  g.stroke();
  const N = 15;
  for (let i = 1; i < N; i++) {
    const t = i / N, [sx, sy] = stem(t);
    const len = L * 0.2 * Math.pow(1 - t, 0.7) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 2.4)));
    for (const side of [-1, 1]) {
      const a = side * (1.05 - t * 0.45) - Math.PI / 2;
      g.beginPath();
      g.ellipse(sx + Math.cos(a) * len * 0.5, sy + Math.sin(a) * len * 0.5, len * 0.5, Math.max(1, L * 0.028), a, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

function texture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function mat(tex, rough = 0.88) {
  return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0x3c3c40, roughness: rough });
}

const W = 256, H = 352;

function frontMaterial(seed) {
  const r = NZ.rng(seed);
  const [c, g] = canvas(W, H);
  knit(g, W, H, r);
  // White collar: a band around the neck with a short placket.
  g.fillStyle = '#ece9e2';
  g.beginPath();
  g.moveTo(W * 0.3, 0);
  g.lineTo(W * 0.7, 0);
  g.lineTo(W * 0.62, 26);
  g.lineTo(W * 0.53, 30);
  g.lineTo(W * 0.53, 58);
  g.lineTo(W * 0.47, 58);
  g.lineTo(W * 0.47, 30);
  g.lineTo(W * 0.38, 26);
  g.closePath();
  g.fill();
  g.fillStyle = '#0c0c0e';
  g.fillRect(W * 0.4, 0, W * 0.2, 14);
  // Fern on the wearer's left chest (viewer's right on the +z front face).
  fern(g, W * 0.72, 150, 96, 0.12);
  // Torn, bloody patches.
  const tears = 1 + (seed % 3);
  for (let k = 0; k < tears; k++) tear(g, 30 + r() * (W - 60), 170 + r() * 150, 14 + r() * 16, r, SKIN[seed % 3]);
  // Grime.
  for (let k = 0; k < 18; k++) {
    g.fillStyle = `rgba(${70 + r() * 40},${20 + r() * 20},10,${0.08 + r() * 0.12})`;
    g.beginPath();
    g.arc(r() * W, r() * H, 6 + r() * 22, 0, 7);
    g.fill();
  }
  return mat(texture(c));
}

const backCache = new Map();
function backMaterial(num) {
  if (backCache.has(num)) return backCache.get(num);
  const r = NZ.rng(num * 977);
  const [c, g] = canvas(W, H);
  knit(g, W, H, r);
  g.fillStyle = '#ece9e2';
  g.fillRect(W * 0.3, 0, W * 0.4, 12);
  g.font = '900 150px "Oswald", "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = '#000';
  g.strokeText(String(num), W / 2, H * 0.46);
  g.fillStyle = '#f2f0ea';
  g.fillText(String(num), W / 2, H * 0.46);
  // Scuffs through the number so it reads as worn.
  for (let k = 0; k < 7; k++) {
    g.fillStyle = 'rgba(12,12,14,0.85)';
    g.fillRect(r() * W, H * 0.25 + r() * H * 0.45, 8 + r() * 18, 2 + r() * 3);
  }
  if (num % 4 === 0) tear(g, 40 + r() * (W - 80), 250 + r() * 70, 16, r, SKIN[num % 3]);
  const m = mat(texture(c));
  backCache.set(num, m);
  return m;
}

function plainKnit(seed, trimBottom) {
  const r = NZ.rng(seed);
  const [c, g] = canvas(64, 128);
  knit(g, 64, 128, r);
  if (trimBottom) {
    g.fillStyle = '#ece9e2';
    g.fillRect(0, 128 - 10, 64, 6);
  }
  return mat(texture(c));
}

function armMaterial(skin, seed) {
  // Short black sleeve with a white cuff, then grey-green arm with dried blood.
  const r = NZ.rng(seed);
  const [c, g] = canvas(64, 256);
  g.fillStyle = skin;
  g.fillRect(0, 0, 64, 256);
  for (let k = 0; k < 30; k++) {
    g.fillStyle = `rgba(30,40,20,${r() * 0.25})`;
    g.fillRect(r() * 64, r() * 256, 3 + r() * 8, 3 + r() * 8);
  }
  for (let k = 0; k < 4; k++) {
    g.fillStyle = 'rgba(90,6,4,0.75)';
    g.fillRect(r() * 60, 90 + r() * 150, 3, 10 + r() * 40);
  }
  const [k2, kg] = canvas(64, 80);
  knit(kg, 64, 80, r);
  g.drawImage(k2, 0, 0);
  g.fillStyle = '#ece9e2';
  g.fillRect(0, 74, 64, 6);
  return new THREE.MeshStandardMaterial({ map: texture(c), roughness: 0.85, emissive: 0x141a10 });
}

function legMaterial(skin, seed) {
  // Top to bottom: black shorts, knee, white sock tops, black sock, boot.
  const r = NZ.rng(seed);
  const [c, g] = canvas(64, 256);
  knit(g, 64, 256, r);
  g.fillStyle = skin;
  g.fillRect(0, 70, 64, 76);
  g.fillStyle = 'rgba(100,8,6,0.7)';
  g.fillRect(10 + r() * 30, 96, 18, 10);
  g.fillStyle = '#ece9e2';
  g.fillRect(0, 146, 64, 14);
  g.fillStyle = '#0c0c0e';
  g.fillRect(0, 152, 64, 3);
  g.fillStyle = '#060606';
  g.fillRect(0, 232, 64, 24);
  g.fillStyle = '#2a2a2a';
  g.fillRect(0, 232, 64, 2);
  return mat(texture(c), 0.9);
}

let M = null;
function build() {
  M = {
    front: [1, 2, 3, 4].map(frontMaterial),
    side: plainKnit(11, false),
    shorts: plainKnit(12, false),
    skin: SKIN.map((s) => new THREE.MeshStandardMaterial({ color: s, roughness: 0.85, emissive: 0x10160c })),
    arm: SKIN.map((s, i) => armMaterial(s, 30 + i)),
    leg: SKIN.map((s, i) => legMaterial(s, 40 + i)),
  };
}

function dress(z) {
  if (z.kind) return; // sheep and other non-humanoids keep their own look
  if (!M) build();
  const [pelvis, legL, legR, torso, head, aL, aR] = z.parts;
  const s = (Math.random() * SKIN.length) | 0;
  z.jersey = 1 + ((Math.random() * 23) | 0);
  const front = M.front[(Math.random() * M.front.length) | 0];
  torso.material = [M.side, M.side, M.side, M.side, front, backMaterial(z.jersey)];
  pelvis.material = M.shorts;
  legL.material = legR.material = M.leg[s];
  aL.material = aR.material = M.arm[s];
  head.material = M.skin[s];
}

NZ.hooks.zombieSpawn.push(dress);
NZ.allBlacks = { dress };
