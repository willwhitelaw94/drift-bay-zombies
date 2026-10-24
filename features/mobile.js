// Touch controls for phones and tablets. Desktop is untouched: nothing here runs unless the
// device is touch-first (coarse pointer, or touch without a fine hovering pointer).
// Force with ?touch=1 / ?touch=0.
//
// Input is synthesised the same way the keyboard drives the game: the joystick writes
// NZ.keys (WASD + Shift), action buttons dispatch KeyboardEvents on document (so game.js and
// every feature's NZ.hooks.key see them), look-drag writes player.yaw/pitch, FIRE/AIM write
// weapon.firing/ads. When NZ.vehicle is set the buttons swap to a driving layout.

const NZ = window.NZ;
const mm = (q) => matchMedia(q).matches;
const force = new URLSearchParams(location.search).get('touch');
const TOUCH = force ? force !== '0'
  : mm('(pointer: coarse)') || (navigator.maxTouchPoints > 0 && !mm('(hover: hover) and (pointer: fine)'));


function init() {
  const { THREE, renderer, scene, camera, player, weapon, keys, hooks, sound } = NZ;
  NZ.touch = true;
  NZ.mobile = { sens: 0.0055, aimAssist: true, fireDrag: true, haptics: true };

  // ---------------------------------------------------------------- performance
  NZ.quality = Object.assign(NZ.quality || {}, { pixelRatio: 1.25, shadowMapSize: 1024, vegetation: 0.5 });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, NZ.quality.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.type = THREE.PCFShadowMap;

  hooks.ready.push(() => {
    scene.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow) {
        o.shadow.mapSize.set(NZ.quality.shadowMapSize, NZ.quality.shadowMapSize);
        o.shadow.map?.dispose();
        o.shadow.map = null;
      }
      // Thin the big instanced vegetation (tussock): keep every other instance.
      if (o.isInstancedMesh && o.count >= 1000 && NZ.quality.vegetation < 1) {
        const step = Math.round(1 / NZ.quality.vegetation), m = new THREE.Matrix4(), c = new THREE.Color();
        let n = 0;
        for (let i = 0; i < o.count; i += step, n++) {
          o.getMatrixAt(i, m);
          o.setMatrixAt(n, m);
          if (o.instanceColor) {
            o.getColorAt(i, c);
            o.setColorAt(n, c);
          }
        }
        o.count = n;
        o.instanceMatrix.needsUpdate = true;
        if (o.instanceColor) o.instanceColor.needsUpdate = true;
      }
    });
    // Explosions shake the phone (explosives module owns NZ.explode).
    if (NZ.explode) {
      const explode = NZ.explode;
      NZ.explode = (...a) => {
        buzz(70);
        return explode(...a);
      };
    }
  });

  // ---------------------------------------------------------------- page setup
  const vp = document.querySelector('meta[name=viewport]');
  if (vp) vp.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  document.body.classList.add('nz-touch');
  for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (NZ.state === 'playing') e.preventDefault();
  }, { passive: false });

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = (tag, cls, parent, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    parent?.appendChild(e);
    return e;
  };

  const root = el('div', '', document.body);
  root.id = 'nz-touch';
  root.hidden = true;
  const joyBase = el('div', 'nz-joy', root);
  const joyKnob = el('div', 'nz-knob', joyBase);
  const strip = el('div', 'nz-strip', root);
  strip.hidden = true;

  const rotate = el('div', '', document.body, '<div class="nz-phone"></div><p>Rotate your phone to landscape</p>');
  rotate.id = 'nz-rotate';

  // Menu: touch instructions instead of the keyboard list.
  const help = el('p', 'nz-help', null,
    'Left thumb: move (push to the edge to sprint) &middot; Right thumb: drag to look<br>FIRE (drag it to aim while shooting) &middot; AIM toggles &middot; hold the gun to pick a weapon');
  document.querySelector('#overlay .controls')?.after(help);

  // ---------------------------------------------------------------- buttons
  // [id, label, action, right, bottom, size] — action: key code (tap), 'hold:<code>', or special.
  const FOOT = [
    ['fire', 'FIRE', 'fire', 28, 40, 96],
    ['aim', 'AIM', 'aim', 140, 22, 66],
    ['jump', 'JUMP', 'hold:Space', 36, 150, 66],
    ['reload', 'RELOAD', 'KeyR', 128, 104, 58],
    ['gun', 'GUN', 'gun', 118, 182, 60],
    ['melee', 'KNIFE', 'KeyV', 226, 22, 56],
    ['frag', 'FRAG', 'hold:KeyG', 214, 92, 52],
    ['flame', 'FLAME', 'hold:KeyT', 200, 158, 52],
    ['use', 'USE', 'KeyE', 300, 26, 50],
    ['streak', 'STREAK', 'KeyB', 290, 96, 50],
  ];
  const DRIVE = [
    ['gas', 'GAS', 'hold:KeyW', 28, 40, 96],
    ['brake', 'BRAKE', 'hold:KeyS', 140, 22, 70],
    ['hand', 'HAND<br>BRAKE', 'hold:Space', 36, 150, 66],
    ['boost', 'BOOST', 'hold:ShiftLeft', 128, 104, 58],
    ['exit', 'EXIT', 'KeyE', 226, 22, 56],
    ['cam', 'CAM', 'KeyV', 214, 92, 52],
    ['reset', 'RESET', 'KeyR', 200, 158, 52],
  ];
  const TOP = [
    ['pause', '&#10074;&#10074;', 'Escape', 12, 44],
    ['map', 'MAP', 'KeyM', 64, 44],
  ];
  const buttons = {};
  const addBtn = (mode, [id, label, action, r, b, s], top) => {
    const btn = el('div', `nz-btn nz-${mode} nz-b-${id}${top ? ' nz-top' : ''}`, root, `<span>${label}</span>`);
    btn.dataset.action = action;
    if (top) btn.style.cssText = `--t:${r};--s:${b}`;
    else btn.style.cssText = `--r:${r};--b:${b};--s:${s}`;
    buttons[id] = btn;
  };
  for (const d of FOOT) addBtn('foot', d);
  for (const d of DRIVE) addBtn('drive', d);
  for (const d of TOP) addBtn('any', d, true);
  const gunLabel = buttons.gun.firstChild;

  // ---------------------------------------------------------------- key synthesis
  const held = {}, joyKeys = {};
  const KEYNAME = { Space: ' ', Escape: 'Escape', ShiftLeft: 'Shift' };
  const keyName = (code) => KEYNAME[code] || (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code);
  const keyEvent = (type, code) => document.dispatchEvent(new KeyboardEvent(type, { code, key: keyName(code), bubbles: true, cancelable: true }));
  const sync = (code) => (keys[code] = !!(held[code] || joyKeys[code]));
  const press = (code) => {
    held[code] = (held[code] || 0) + 1;
    keyEvent('keydown', code);
    sync(code);
  };
  const release = (code) => {
    if (!held[code]) return;
    held[code]--;
    keyEvent('keyup', code);
    sync(code);
  };
  // A tap is down+up in one go, so held-key logic (Q/E turning etc.) never sees it.
  const tap = (code) => {
    keyEvent('keydown', code);
    keyEvent('keyup', code);
    sync(code);
  };
  const setJoyKey = (code, on) => {
    if (!!joyKeys[code] === on) return;
    joyKeys[code] = on;
    sync(code);
  };

  function buzz(ms) {
    if (NZ.mobile.haptics && navigator.vibrate) navigator.vibrate(ms);
  }

  // ---------------------------------------------------------------- touch tracking
  const touches = new Map(); // identifier -> { kind, ... }
  let joy = null, look = null, fireHeld = 0;
  const unit = () => parseFloat(getComputedStyle(root).getPropertyValue('--u')) || 1;

  function lookBy(dx, dy) {
    const k = NZ.mobile.sens * Math.min(1 - weapon.adsK * 0.45, camera.fov / 60) * assist.friction;
    player.yaw -= dx * k;
    player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - dy * k));
    assist.dragT = 0.15;
  }

  function joyMove(x, y) {
    const R = 58 * unit();
    let dx = x - joy.x0, dy = y - joy.y0, d = Math.hypot(dx, dy);
    // Drag the base along when the thumb wanders far, so it never runs out of travel.
    if (d > R * 1.7) {
      const k = (d - R * 1.7) / d;
      joy.x0 += dx * k;
      joy.y0 += dy * k;
      dx = x - joy.x0;
      dy = y - joy.y0;
      d = Math.hypot(dx, dy);
      placeJoy(joy.x0, joy.y0);
    }
    const c = Math.min(1, d / R), nx = d ? (dx / d) * c : 0, ny = d ? (dy / d) * c : 0;
    joyKnob.style.transform = `translate(${nx * R}px, ${ny * R}px)`;
    const on = c > 0.25;
    setJoyKey('KeyW', on && ny < -0.38);
    setJoyKey('KeyS', on && ny > 0.38);
    setJoyKey('KeyA', on && nx < -0.38);
    setJoyKey('KeyD', on && nx > 0.38);
    const sprint = d > R * 1.15 && ny < -0.5 && !NZ.vehicle;
    setJoyKey('ShiftLeft', sprint);
    joyBase.classList.toggle('sprint', sprint);
  }
  function placeJoy(x, y) {
    joyBase.style.left = x + 'px';
    joyBase.style.top = y + 'px';
  }
  function joyEnd() {
    joy = null;
    for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft']) setJoyKey(k, false);
    joyBase.classList.remove('active', 'sprint');
    joyBase.style.left = joyBase.style.top = '';
    joyKnob.style.transform = '';
  }

  // Weapon strip (long-press the gun button): one entry per gun, Digit1..n in GUNS order.
  let stripTimer = 0;
  function openStrip() {
    const names = Object.keys(NZ.GUNS).slice(0, 9);
    strip.innerHTML = names.map((g, i) =>
      `<div class="nz-gun${g === weapon.gun ? ' on' : ''}" data-code="Digit${i + 1}"><b>${i + 1}</b>${NZ.GUNS[g].name || g}</div>`).join('');
    strip.hidden = false;
    buzz(10);
  }
  const closeStrip = () => (strip.hidden = true);
  const stripItemAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.nz-gun');

  function start(t) {
    const target = t.target instanceof Element ? t.target : null;
    const item = target?.closest('.nz-gun');
    if (item) {
      tap(item.dataset.code);
      closeStrip();
      return;
    }
    if (!strip.hidden) closeStrip();
    const btn = target?.closest('.nz-btn');
    if (btn) {
      const a = btn.dataset.action;
      btn.classList.add('down');
      const rec = { kind: 'btn', btn, a, x: t.clientX, y: t.clientY };
      touches.set(t.identifier, rec);
      if (a === 'fire') {
        fireHeld++;
        weapon.firing = true;
      } else if (a === 'aim') weapon.ads = !weapon.ads;
      else if (a === 'gun') {
        rec.long = false;
        clearTimeout(stripTimer);
        stripTimer = setTimeout(() => {
          rec.long = true;
          openStrip();
        }, 380);
      } else if (a.startsWith('hold:')) press(a.slice(5));
      else tap(a);
      return;
    }
    if (t.clientX < window.innerWidth * 0.42 && !joy) {
      joy = { id: t.identifier, x0: t.clientX, y0: t.clientY };
      placeJoy(t.clientX, t.clientY);
      joyBase.classList.add('active');
      touches.set(t.identifier, { kind: 'joy' });
      return;
    }
    if (!look) {
      look = { id: t.identifier, x: t.clientX, y: t.clientY };
      touches.set(t.identifier, { kind: 'look' });
    }
  }

  function move(t) {
    const rec = touches.get(t.identifier);
    if (!rec) return;
    if (rec.kind === 'joy') joyMove(t.clientX, t.clientY);
    else if (rec.kind === 'look') {
      lookBy(t.clientX - look.x, t.clientY - look.y);
      look.x = t.clientX;
      look.y = t.clientY;
    } else if (rec.a === 'fire' && NZ.mobile.fireDrag) {
      lookBy(t.clientX - rec.x, t.clientY - rec.y);
      rec.x = t.clientX;
      rec.y = t.clientY;
    } else if (rec.a === 'gun' && !strip.hidden) {
      const item = stripItemAt(t.clientX, t.clientY);
      for (const g of strip.children) g.classList.toggle('hot', g === item);
    }
  }

  function end(t) {
    const rec = touches.get(t.identifier);
    if (!rec) return;
    touches.delete(t.identifier);
    if (rec.kind === 'joy') joyEnd();
    else if (rec.kind === 'look') look = null;
    else {
      rec.btn.classList.remove('down');
      if (rec.a === 'fire') {
        fireHeld = Math.max(0, fireHeld - 1);
        if (!fireHeld) weapon.firing = false;
      } else if (rec.a === 'gun') {
        clearTimeout(stripTimer);
        if (!rec.long) document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
        else {
          const item = stripItemAt(t.clientX, t.clientY);
          if (item) {
            tap(item.dataset.code);
            closeStrip();
          }
        }
      } else if (rec.a.startsWith('hold:')) release(rec.a.slice(5));
    }
  }

  const each = (fn) => (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) fn(t);
  };
  root.addEventListener('touchstart', each(start), { passive: false });
  root.addEventListener('touchmove', each(move), { passive: false });
  root.addEventListener('touchend', each(end), { passive: false });
  root.addEventListener('touchcancel', each(end), { passive: false });

  function releaseAll() {
    for (const [, rec] of touches) if (rec.btn) rec.btn.classList.remove('down');
    touches.clear();
    look = null;
    fireHeld = 0;
    weapon.firing = false;
    clearTimeout(stripTimer);
    closeStrip();
    if (joy) joyEnd();
    for (const code in held) while (held[code]) release(code);
  }

  // ---------------------------------------------------------------- start flow
  let started = false;
  const playBtn = document.getElementById('play');
  playBtn.addEventListener('click', () => {
    started = true;
    const de = document.documentElement;
    try {
      const p = document.fullscreenElement || document.webkitFullscreenElement ? null
        : de.requestFullscreen ? de.requestFullscreen({ navigationUI: 'hide' }) : de.webkitRequestFullscreen?.();
      Promise.resolve(p).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
    } catch { /* fullscreen not allowed: the rotate overlay covers portrait */ }
  }, true);
  // iOS keeps the AudioContext suspended until a touch resumes it.
  document.addEventListener('touchend', () => {
    if (NZ.state === 'playing' && sound.ctx && sound.ctx.state !== 'running') sound.ctx.resume();
  });

  const portraitQ = matchMedia('(orientation: portrait)');
  const onOrient = () => {
    document.body.classList.toggle('nz-portrait', portraitQ.matches && started);
    if (portraitQ.matches && NZ.state === 'playing') tap('Escape');
  };
  portraitQ.addEventListener?.('change', onOrient);
  window.addEventListener('resize', onOrient);

  // ---------------------------------------------------------------- per-frame
  let lastState = '', lastMode = '', lastGun = '';
  hooks.frame.push((dt, t, state) => {
    if (state !== lastState) {
      if (lastState === 'playing') releaseAll();
      root.hidden = state !== 'playing';
      lastState = state;
      onOrient();
    }
    if (state !== 'playing' && !playBtn.hidden && playBtn.textContent.includes('Click'))
      playBtn.textContent = playBtn.textContent.replace('Click', 'Tap');
    if (state !== 'playing') return;
    const mode = NZ.vehicle ? 'drive' : 'foot';
    if (mode !== lastMode) {
      releaseAll();
      root.dataset.mode = lastMode = mode;
    }
    buttons.aim.classList.toggle('on', !!weapon.ads);
    if (weapon.name !== lastGun) {
      lastGun = weapon.name;
      gunLabel.textContent = (weapon.name || weapon.gun).split(' ').pop();
    }
  });

  // ---------------------------------------------------------------- aim assist + fire
  const assist = { friction: 1, dragT: 0 };
  const ray = new THREE.Ray(), fwd = new THREE.Vector3(), to = new THREE.Vector3();
  hooks.update.push((dt) => {
    if (fireHeld) weapon.firing = true; // semi-auto guns keep firing while held
    assist.dragT -= dt;
    assist.friction = 1;
    if (!NZ.mobile.aimAssist || NZ.vehicle || player.control) return;
    camera.getWorldDirection(fwd);
    let best = null, bestA = 0.1;
    for (const z of NZ.zombies) {
      if (z.state === 'dead' || z.state === 'rising' || !z.pos) continue;
      to.set(z.pos.x, z.pos.y + 1.35, z.pos.z).sub(camera.position);
      const d = to.length();
      if (d > 45 || d < 0.5) continue;
      const a = Math.acos(Math.min(1, fwd.dot(to) / d));
      if (a < bestA) {
        bestA = a;
        best = { d, x: to.x, y: to.y, z: to.z };
      }
    }
    if (!best) return;
    ray.origin.copy(camera.position);
    ray.direction.set(best.x, best.y, best.z).divideScalar(best.d);
    const wall = NZ.world.octree?.rayIntersect(ray);
    if (wall && wall.distance < best.d - 0.5) return;
    assist.friction = 0.55;
    // Gentle magnetism only while the player is actively aiming (dragging or firing).
    if (assist.dragT <= 0 && !fireHeld) return;
    const ty = Math.atan2(-best.x, -best.z), tp = Math.atan2(best.y, Math.hypot(best.x, best.z));
    let dy = ty - player.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const k = Math.min(1, dt * 3) * 0.35;
    player.yaw += dy * k;
    player.pitch += (tp - player.pitch) * k;
  });

  // ---------------------------------------------------------------- haptics
  let hitBuzzT = 0;
  hooks.playerDamage.push(() => buzz(40));
  hooks.kill.push(() => buzz(18));
  hooks.zombieDamage.push(() => {
    const now = performance.now();
    if (now - hitBuzzT > 90) {
      hitBuzzT = now;
      buzz(6);
    }
  });
}

const CSS = `
body.nz-touch { touch-action: none; overscroll-behavior: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  --sl: env(safe-area-inset-left, 0px); --sr: env(safe-area-inset-right, 0px); --st: env(safe-area-inset-top, 0px); --sb: env(safe-area-inset-bottom, 0px); }
#overlay { z-index: 30; }
#nz-touch { position: fixed; inset: 0; z-index: 20; touch-action: none; --u: 1; font-family: "Oswald", sans-serif; }
#nz-touch[hidden] { display: none; }
@media (min-width: 1000px) and (min-height: 700px) { #nz-touch { --u: 1.25; } }

.nz-btn { position: absolute; right: calc(var(--r) * var(--u) * 1px + var(--sr)); bottom: calc(var(--b) * var(--u) * 1px + var(--sb));
  width: calc(var(--s) * var(--u) * 1px); height: calc(var(--s) * var(--u) * 1px); border-radius: 50%; box-sizing: border-box;
  display: grid; place-items: center; text-align: center; line-height: 1.05; color: rgba(240,232,220,.9);
  font-size: calc(11px * var(--u)); font-weight: 600; letter-spacing: .08em; text-shadow: 0 1px 2px #000;
  background: rgba(12,6,10,.32); border: 2px solid rgba(232,220,203,.32); transition: background .08s, transform .08s; }
.nz-btn span { pointer-events: none; }
.nz-btn.down { background: rgba(179,21,12,.55); border-color: rgba(255,200,180,.7); transform: scale(.93); }
.nz-btn.on { background: rgba(242,193,78,.35); border-color: rgba(242,193,78,.85); }
.nz-top { right: auto; bottom: auto; top: calc(var(--t) * var(--u) * 1px + var(--st)); right: calc(134px * var(--u) + var(--sr)); font-size: calc(12px * var(--u)); }
.nz-b-fire, .nz-b-gas { font-size: calc(17px * var(--u)); border-color: rgba(179,21,12,.75); background: rgba(90,8,6,.35); }
.nz-b-gun span { font-size: calc(10px * var(--u)); max-width: 90%; overflow: hidden; }
#nz-touch[data-mode="foot"] .nz-drive, #nz-touch[data-mode="drive"] .nz-foot { display: none; }

.nz-joy { position: absolute; left: calc(110px * var(--u) + var(--sl)); top: calc(100% - 110px * var(--u) - var(--sb));
  width: calc(116px * var(--u)); height: calc(116px * var(--u)); margin: calc(-58px * var(--u)) 0 0 calc(-58px * var(--u));
  border-radius: 50%; border: 2px solid rgba(232,220,203,.22); background: rgba(12,6,10,.18); opacity: .55; pointer-events: none; }
.nz-joy.active { opacity: 1; border-color: rgba(232,220,203,.4); }
.nz-joy.sprint { border-color: rgba(242,193,78,.9); box-shadow: 0 0 18px rgba(242,193,78,.35); }
.nz-knob { position: absolute; left: 50%; top: 50%; width: 46%; height: 46%; margin: -23% 0 0 -23%; border-radius: 50%;
  background: rgba(232,220,203,.45); box-shadow: 0 0 8px rgba(0,0,0,.6); }

.nz-strip { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); display: flex; gap: 8px; }
.nz-strip[hidden] { display: none; }
.nz-gun { padding: 10px 14px; min-width: 64px; border-radius: 10px; text-align: center; font-size: 13px; letter-spacing: .06em;
  background: rgba(12,6,10,.7); border: 2px solid rgba(232,220,203,.3); color: var(--chalk); }
.nz-gun b { display: block; font-size: 20px; color: var(--gold); }
.nz-gun.on { border-color: rgba(242,193,78,.8); }
.nz-gun.hot { background: rgba(179,21,12,.7); }

#nz-rotate { display: none; position: fixed; inset: 0; z-index: 50; background: #050306; color: var(--chalk);
  flex-direction: column; align-items: center; justify-content: center; gap: 18px; font-size: 18px; letter-spacing: .12em; text-transform: uppercase; text-align: center; padding: 24px; }
body.nz-portrait #nz-rotate { display: flex; }
.nz-phone { width: 56px; height: 96px; border: 4px solid var(--chalk); border-radius: 12px; animation: nzrot 1.8s ease-in-out infinite; }
@keyframes nzrot { 0%, 25% { transform: rotate(0); } 60%, 100% { transform: rotate(-90deg); } }

.nz-help { display: none; }
body.nz-touch .controls { display: none; }
body.nz-touch .nz-help { display: block; font-size: 14px; opacity: .75; margin: 18px auto 8px; line-height: 1.5; }
body.nz-touch #play { padding: 16px 44px; }

/* HUD: clear of the thumbs and the notch. */
body.nz-touch #room { top: calc(10px + var(--st)); left: calc(14px + var(--sl)); }
body.nz-touch #room-name { font-size: 15px; }
body.nz-touch #room small { font-size: 9px; }
body.nz-touch #minimap { top: calc(10px + var(--st)); right: calc(12px + var(--sr)); width: 112px; height: 112px; }
body.nz-touch #round { left: calc(14px + var(--sl)); top: calc(64px + var(--st)); bottom: auto; height: 56px; }
body.nz-touch #tally { width: 92px; height: 56px; }
body.nz-touch #round-num { font-size: 54px; }
body.nz-touch #ammo { right: auto; left: 50%; transform: translateX(-50%); bottom: calc(6px + var(--sb)); text-align: center; white-space: nowrap; }
body.nz-touch #mag { font-size: 30px; }
body.nz-touch #ammo .sep { font-size: 20px; margin: 0 6px; }
body.nz-touch #reserve { font-size: 18px; }
body.nz-touch #weapon-name { font-size: 9px; }
body.nz-touch #points-wrap { right: auto; left: 50%; transform: translateX(-50%); bottom: calc(66px + var(--sb)); text-align: center; }
body.nz-touch #points { font-size: 20px; min-width: 0; background: none; }
body.nz-touch #powerups { bottom: auto; top: calc(12px + var(--st)); }
body.nz-touch #message { font-size: 40px; top: 20%; }
body.nz-touch #hint { font-size: 13px; top: 32%; width: 70%; }
@media (max-height: 520px) {
  body.nz-touch h1 { font-size: 40px; margin: 4px 0; }
  body.nz-touch .kicker { font-size: 10px; }
  body.nz-touch .fine { display: none; }
  body.nz-touch .nz-help { font-size: 12px; margin: 8px auto 4px; }
  body.nz-touch #summary { font-size: 14px; margin-bottom: 8px; }
  body.nz-touch #summary strong { font-size: 30px; }
}
`;

if (TOUCH) init();
