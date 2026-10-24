// Procedural greyscale detail textures (canvas), multiplied by each material's exported colour.
import * as THREE from './vendor/three.module.min.js';

export function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const grey = (v, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

function blotches(g, r, S, n, lo, hi, rmin, rmax, a = 0.18) {
  for (let k = 0; k < n; k++) {
    g.fillStyle = grey(lo + r() * (hi - lo), a);
    g.beginPath();
    g.arc(r() * S, r() * S, rmin + r() * (rmax - rmin), 0, 7);
    g.fill();
  }
}

const DRAW = {
  boards(g, r, S) {
    const n = 8, w = S / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = grey(165 + r() * 60);
      g.fillRect(i * w, 0, w, S);
      for (let k = 0; k < 16; k++) {
        g.fillStyle = grey(110 + r() * 70, 0.25);
        g.fillRect(i * w + r() * w, 0, 1, S);
      }
      g.fillStyle = grey(45);
      g.fillRect(i * w, 0, 2, S);
    }
  },
  planks(g, r, S) {
    const n = 6, h = S / n;
    for (let i = 0; i < n; i++) {
      let x = -r() * S;
      while (x < S) {
        const len = S * (0.45 + r() * 0.6);
        g.fillStyle = grey(160 + r() * 70);
        g.fillRect(x, i * h, len, h);
        for (let k = 0; k < 7; k++) {
          g.fillStyle = grey(110 + r() * 60, 0.22);
          g.fillRect(x, i * h + r() * h, len, 1);
        }
        g.fillStyle = grey(70);
        g.fillRect(x, i * h, 1.5, h);
        x += len;
      }
      g.fillStyle = grey(60);
      g.fillRect(0, i * h, S, 1.5);
    }
  },
  concrete(g, r, S) {
    g.fillStyle = grey(200);
    g.fillRect(0, 0, S, S);
    blotches(g, r, S, 700, 150, 240, 2, 10);
    for (let y = 0; y < S; y += 32) {
      g.fillStyle = grey(120, 0.55);
      g.fillRect(0, y, S, 1.5);
      for (let k = 0; k < 10; k++) {
        g.fillStyle = grey(140 + r() * 60, 0.3);
        g.fillRect(0, y + 2 + r() * 28, S, 1);
      }
    }
    for (let k = 0; k < 350; k++) {
      g.fillStyle = grey(80, 0.5);
      g.fillRect(r() * S, r() * S, 1.5, 1.5);
    }
  },
  stone(g, r, S) {
    g.fillStyle = grey(70);
    g.fillRect(0, 0, S, S);
    let y = 0;
    while (y < S) {
      const h = 30 + r() * 40;
      let x = -r() * 60;
      while (x < S) {
        const w = 40 + r() * 70;
        g.fillStyle = grey(150 + r() * 90);
        g.fillRect(x + 2, y + 2, w - 4, h - 4);
        x += w;
      }
      y += h;
    }
    blotches(g, r, S, 900, 90, 255, 1, 4, 0.15);
  },
  gravel(g, r, S) {
    g.fillStyle = grey(150);
    g.fillRect(0, 0, S, S);
    for (let k = 0; k < 9000; k++) {
      g.fillStyle = grey(70 + r() * 185);
      const s = 1 + r() * 2.6;
      g.fillRect(r() * S, r() * S, s, s);
    }
  },
  grass(g, r, S) {
    g.fillStyle = grey(140);
    g.fillRect(0, 0, S, S);
    blotches(g, r, S, 120, 90, 230, 10, 40, 0.15);
    g.lineWidth = 1;
    for (let k = 0; k < 5000; k++) {
      const x = r() * S, y = r() * S, a = r() * 6.3, l = 3 + r() * 8;
      g.strokeStyle = grey(90 + r() * 165, 0.6);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  },
  lime(g, r, S) {
    g.fillStyle = grey(215);
    g.fillRect(0, 0, S, S);
    blotches(g, r, S, 260, 170, 255, 8, 40, 0.07);
  },
  metal(g, r, S) {
    g.fillStyle = grey(200);
    g.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 32) {
      g.fillStyle = grey(110);
      g.fillRect(x, 0, 3, S);
      g.fillStyle = grey(240, 0.5);
      g.fillRect(x + 3, 0, 1, S);
    }
    blotches(g, r, S, 200, 150, 240, 4, 18, 0.08);
  },
};

export function detailTexture(kind, seed, anisotropy) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  DRAW[kind](g, rng(seed), S);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

export function glowTexture(inner, outer, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, inner);
  grad.addColorStop(0.32, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function flashTexture() {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  grad.addColorStop(0, 'rgba(255,250,220,1)');
  grad.addColorStop(0.2, 'rgba(255,200,90,0.9)');
  grad.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grad;
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7);
    g.beginPath();
    g.moveTo(-7, 0);
    g.lineTo(0, -S / 2);
    g.lineTo(7, 0);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, S / 5, 0, 7);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
