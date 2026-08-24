'use strict';
/*
 * ============================================================================
 *  Narwhale.io Classic (2016) — SERVIDOR DE JUEGO RECONSTRUIDO
 * ============================================================================
 *
 *  El protocolo y la física están extraídos del cliente original (app.js),
 *  de modo que el servidor sea 100% autoritativo PERO respetando la
 *  interpolación/extrapolación visual del cliente:
 *
 *  CONTRATO DEL CLIENTE (verificado en los parsers de app.js):
 *
 *  - SetElements (48): [time:F64LE] + elementos:
 *      id:U32LE   -> el cliente lee U16 y avanza 4 bytes => el UID del
 *                    START (U16) debe coincidir con los 16 bits bajos.
 *      color: 3 bytes RGB (r<<16|g<<8|b)
 *      nombre: null-terminated + encodeURIComponent
 *      breakPoint:U8, alpha:U8(/255),
 *      dash:U8  -> maxDash = nibble bajo, curDash = nibble alto
 *      overDash:U8(/255), tuskRatio:U8(/255*2), decoration:U8
 *      cabeza: x:F32, y:F32, speed:U16, velAngle:I8(/127*PI), rot:I8(/127*PI)
 *      f:U8  -> nmero de partes restantes
 *      parte i (1..f): rot:I8 ... EXCEPTO si i == breakPoint:
 *                      x:F32, y:F32, vx:F32, vy:F32 (parte "libre" del corte)
 *
 *  - time va en SEGUNDOS (float64). El cliente compara el delta contra
 *    performance.now()/1000 para detectar throttling; si se mandan
 *    milisegundos el smoothing se degrada al mnimo (0.1) y el narval
 *    "se siente raro" (goma, lag).
 *
 *  - El cliente extrapola la cabeza con velocidad constante (speed+velAngle)
 *    y cada segmento con su integrador `updaterel`:
 *        vt -= vt * damp            (por frame)
 *        rot += dt * vt
 *        clamp angular -> vt *= 1 - 0.75*dt*60
 *        pos = prev + 36 * dir(rot + PI)     (36 px, hardcodeado!)
 *    con damp = 0.15 + 0.35*(N - i)/N  y  maxAngle = (2*PI/3)*(i-1)/10.
 *    => Este servidor replica ESE MISMO integrador para que la simulacin
 *       autoritativa y la extrapolacin del cliente coincidan entre snapshots.
 *
 *  - Al cortar (colmillo), el cliente hace parts.splice(breakPoint, 1):
 *    el servidor debe splicear su propia cadena igual para que las longitudes
 *    casen, y mandar la parte del corte con datos completos (la cola severada
 *    queda anclada ah y se anima libre).
 *
 *  - LeaderBoard (50): count:U8 + (level:U8, nombre\0) * count. NADA ms.
 *  - PlayerInfo (49): level:U8, nUpgrades:U8, upgradeIds:U8...
 *  - Start (respuesta): uid:U16LE.  Ping (37): echo del F32 tal cual.
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  port: 8080,
  tickRate: 60,          // Hz de simulación (dt fijo = réplica exacta del cliente)
  snapshotEvery: 4,      // 60/4 = 15 snapshots por segundo (estables!)

  worldWidth: 6000,
  worldHeight: 6000,

  physics: {
    maxSpeed: 240,       // px/s de nado normal
    accelK: 6,           // suavizado exponencial hacia la velocidad objetivo
    dashSpeed: 900,      // px/s del dash
    dashK: 14,           // aceleración (brusquedad) durante el dash
    dashDuration: 0.55,  // s
    retreatSpeed: 480,   // px/s del retreat
    retreatDuration: 0.4,
    turnRate: 3.4,       // rad/s base (mejorable)
    wallBounce: 0.35,

    // ---- Cadena: idéntico al cliente ----
    chainParts: 11,
    segLen: 36,          // hardcodeado en el cliente (i.size = 36)
    followK: 12,         // respuesta de la cola (vt por rad de error)
    vtMax: 6,            // rad/s máximo por segmento
    bodyRadius: 15,      // radio de colisión de cada segmento
    tuskBaseLen: 30,     // colmillo: largo = tuskBaseLen + 45 * tuskRatio
    tuskScaleLen: 45,
  },

  growth: {
    baseSize: 36,        // el cliente hardcodea size=36 (solo crece el colmillo)
    cutGrow: 4,          // tamaño ganado por corte
    killGrow: 8,         // tamaño ganado por kill
    levelStep: 8,        // size necesario por nivel
    tuskBase: 0.5,
    tuskPerSize: 0.5 / 36,
    tuskPerUpgrade: 0.12,
  },

  dash: {
    regen: 0.55,              // cargas por segundo
    regenPerUpgrade: 0.3,
    maxCharges: 10,
    invincibleTime: 3.0,      // s al spawn
    cutCooldown: 0.8,         // s entre cortes sobre la misma víctima
    minLivingParts: 4,        // con menos partes vivas -> RIP
  },

  leaderboardEvery: 2.0, // s
};

// ==================== OPCODES (contrato 2016) ====================
const OPCODES = {
  JOIN: 16,
  LEAVE: 17,
  START: 18,
  GET_LOBBIES: 19,
  UPDATE_TARGET: 32,
  SPLIT_UP: 33,
  RIP: 34,
  RETREAT: 35,
  PING: 37,
  SET_ELEMENTS: 48,
  PLAYER_INFO: 49,
  LEADER_BOARD: 50,
};

// ==================== UTILIDADES ====================

// Delta angular normalizado a [-PI, PI]
function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// encodeURIComponent + terminador null (igual que stringToUint del cliente)
function stringToBytes(str) {
  const enc = encodeURIComponent(String(str).slice(0, 25));
  const bytes = [];
  for (let i = 0; i < enc.length; i++) bytes.push(enc.charCodeAt(i) & 0xff);
  bytes.push(0);
  return bytes;
}

function parseStringBytes(data, offset) {
  const bytes = [];
  while (offset < data.length) {
    const b = data[offset++];
    if (b === 0) break;
    bytes.push(b);
  }
  const raw = String.fromCharCode.apply(null, bytes);
  let name;
  try { name = decodeURIComponent(raw); } catch (e) { name = raw; }
  return [offset, name];
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

function randomColor() {
  return hslToRgb(Math.random(), 0.85 + Math.random() * 0.1, 0.6 + Math.random() * 0.1);
}

// ====================================================================
//  FÍSICA DE CADENA — réplica EXACTA del updaterel del cliente
//  (ChainElementUnit.updaterel en app.js). Si esto no coincide, el
//  cliente pelea contra el servidor y la cola "vibra".
// ====================================================================
const CHAIN = {
  // damp del segmento i (1..N) — cliente: 0.15 + (N - i)/N * 0.35
  damp(i, n) { return 0.15 + ((n - i) / n) * 0.35; },
  // ángulo máximo entre segmentos — cliente: (2*PI/3) * (i-1)/10
  maxAngle(i) { return ((2 * Math.PI) / 3) * ((i - 1) / 10); },

  updaterel(part, px, py, prevRot, segLen, dt, damp, maxAngle) {
    part.vt -= part.vt * damp;                 // por frame (quirk del original)
    part.rot += dt * part.vt;
    const a = wrapAngle(part.rot - prevRot);
    if (a > maxAngle && part.vt > 0) part.vt *= 1 - 0.75 * dt * 60;
    else if (a < -maxAngle && part.vt < 0) part.vt *= 1 - 0.75 * dt * 60;
    part.x = px + Math.cos(part.rot + Math.PI) * segLen;
    part.y = py + Math.sin(part.rot + Math.PI) * segLen;
  },

  // Simulación server-side de la cadena completa de un narval.
  // La cabeza es autoritativa (la mueve la física del jugador); el resto
  // sigue con el mismo integrador que usará el cliente para extrapolar.
  updateChain(p, dt) {
    const P = CONFIG.physics;
    const parts = p.parts;
    const n = parts.length;

    // Cabeza
    const head = parts[0];
    head.x = p.x;
    head.y = p.y;
    head.vx = p.vx;
    head.vy = p.vy;
    head.rot = p.angle;
    head.vt = p.angularVel;

    let prev = head;
    for (let i = 1; i < n; i++) {
      const part = parts[i];

      if (i === p.breakPoint) {
        // Parte libre (ancla de la cola cortada): vuela con inercia
        part.x += part.vx * dt;
        part.y += part.vy * dt;
        const decay = Math.exp(-2.0 * dt);
        part.vx *= decay;
        part.vy *= decay;
        part.rot += part.vt * dt;
        part.vt *= decay;
      } else {
        // El segmento apunta al anterior; vt responde al error angular
        const targetRot = Math.atan2(prev.y - part.y, prev.x - part.x);
        const err = wrapAngle(targetRot - part.rot);
        part.vt = clamp(err * P.followK, -P.vtMax, P.vtMax);
        CHAIN.updaterel(part, prev.x, prev.y, prev.rot, P.segLen, dt,
          CHAIN.damp(i, n), CHAIN.maxAngle(i));
      }
      prev = part;
    }

    // Sanitizer anti-NaN
    for (const s of parts) {
      if (!Number.isFinite(s.x)) s.x = p.x;
      if (!Number.isFinite(s.y)) s.y = p.y;
      if (!Number.isFinite(s.rot)) s.rot = p.angle;
      if (!Number.isFinite(s.vx)) s.vx = 0;
      if (!Number.isFinite(s.vy)) s.vy = 0;
      if (!Number.isFinite(s.vt)) s.vt = 0;
    }
  },
};

// ==================== NARVAL (jugador) ====================
class Narwhal {
  constructor(id, socket, name) {
    this.id = id;                 // UID de 16 bits (cas con START y SetElements)
    this.socket = socket;
    this.name = (name || 'Narwhal').slice(0, 25);
    this.color = randomColor();

    // Estado
    this.isAlive = false;
    this.room = null;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.angularVel = 0;          // rad/s reales de la cabeza (para vt de la parte 1)

    this.inputX = 0; this.inputY = 0;

    // Cadena
    this.parts = [];
    this.breakPoint = CONFIG.physics.chainParts; // sin cortes (= longitud)
    for (let i = 0; i < CONFIG.physics.chainParts; i++) {
      this.parts.push({ x: 0, y: 0, vx: 0, vy: 0, rot: 0, vt: 0 });
    }

    // Dash / stamina
    this.maxDash = 1;
    this.curDash = 0;
    this.overDash = 0;
    this.dashTime = 0; this.dashDirX = 1; this.dashDirY = 0;
    this.retreatTime = 0; this.retreatDirX = -1; this.retreatDirY = 0;

    // Crecimiento
    this.size = CONFIG.growth.baseSize;
    this.level = 1;
    this.score = 0;
    this.kills = 0;
    this.tuskRatio = CONFIG.growth.tuskBase;
    this.decoration = 1;          // 1 = ojitos (el cliente interpola la fuerza)
    this.alpha = 1;

    this.upgrades = { tusk: 0, speed: 0, turn: 0, dashSpeed: 0, staminaRegen: 0, stamina: 0 };

    this.invincibleDur = 0;
    this.cutCooldown = 0;
    this.spawnAge = 0;
  }

  // ---- Derivadas con upgrades ----
  get maxSpeed() { return CONFIG.physics.maxSpeed + this.upgrades.speed * 20; }
  get turnRate() { return CONFIG.physics.turnRate + this.upgrades.turn * 0.35; }
  get dashSpeed() { return CONFIG.physics.dashSpeed + this.upgrades.dashSpeed * 90; }
  get regenRate() {
    return CONFIG.dash.regen * (1 + this.upgrades.staminaRegen * CONFIG.dash.regenPerUpgrade);
  }
  get tuskLen() {
    return CONFIG.physics.tuskBaseLen + CONFIG.physics.tuskScaleLen * this.tuskRatio;
  }

  spawn(room) {
    const margin = 600;
    this.room = room;
    this.isAlive = true;
    this.x = margin + Math.random() * (room.width - 2 * margin);
    this.y = margin + Math.random() * (room.height - 2 * margin);
    this.vx = 0; this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.angularVel = 0;

    // Cadena inicial: recta detrás de la cabeza, espaciada 36 px
    this.parts = [];
    this.breakPoint = CONFIG.physics.chainParts;
    for (let i = 0; i < CONFIG.physics.chainParts; i++) {
      this.parts.push({
        x: this.x - Math.cos(this.angle) * CONFIG.physics.segLen * i,
        y: this.y - Math.sin(this.angle) * CONFIG.physics.segLen * i,
        vx: 0, vy: 0,
        rot: this.angle, vt: 0,
      });
    }

    // Mantener nombre/color/nivel de la vida anterior (respawn manual)
    this.maxDash = Math.min(1 + this.upgrades.stamina, CONFIG.dash.maxCharges);
    this.curDash = this.maxDash;
    this.overDash = 0;
    this.dashTime = 0;
    this.retreatTime = 0;
    this.invincibleDur = CONFIG.dash.invincibleTime;
    this.cutCooldown = 0;
    this.spawnAge = 0;
    this.alpha = 1;
    this.updateTusk();
  }

  updateTusk() {
    const g = CONFIG.growth;
    this.tuskRatio = clamp(
      g.tuskBase + (this.size - g.baseSize) * g.tuskPerSize + this.upgrades.tusk * g.tuskPerUpgrade,
      0, 2
    );
  }

  setInput(dx, dy) {
    if (!Number.isFinite(dx)) dx = 0;                 // blindaje anti-NaN
    if (!Number.isFinite(dy)) dy = 0;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }   // el cliente ya normaliza a <=1, por las dudas
    this.inputX = dx;
    this.inputY = dy;
  }

  useDash(dx, dy) {
    if (this.curDash <= 0 || this.dashTime > 0) return false;
    this.curDash--;
    this.dashTime = CONFIG.physics.dashDuration;
    let m = Math.hypot(dx, dy);
    if (m < 1e-4) { dx = Math.cos(this.angle); dy = Math.sin(this.angle); m = 1; }
    this.dashDirX = dx / m; this.dashDirY = dy / m;
    return true;
  }

  useRetreat(dx, dy) {
    if (this.curDash <= 0 || this.retreatTime > 0) return false;
    this.curDash--;
    this.retreatTime = CONFIG.physics.retreatDuration;
    let m = Math.hypot(dx, dy);
    if (m < 1e-4) { dx = -Math.cos(this.angle); dy = -Math.sin(this.angle); m = 1; }
    this.retreatDirX = dx / m; this.retreatDirY = dy / m;
    return true;
  }

  update(dt) {
    if (!this.isAlive) return;
    const P = CONFIG.physics;
    this.spawnAge += dt;
    if (this.invincibleDur > 0) {
      this.invincibleDur -= dt;
      // Parpadeo mientras es invencible
      this.alpha = 0.45 + 0.55 * Math.abs(Math.sin(this.spawnAge * 12));
    } else {
      this.alpha = 1;
    }
    if (this.cutCooldown > 0) this.cutCooldown -= dt;

    // ---- Recarga de dash ----
    if (this.curDash < this.maxDash) {
      this.overDash += this.regenRate * dt;
      if (this.overDash >= 1) {
        this.overDash = 0;
        this.curDash++;
      }
    } else {
      this.overDash = 0;
    }

    // ---- Giro de la cabeza ----
    let turnRate = this.turnRate;
    if (this.dashTime > 0) turnRate *= 0.4;   // durante el dash gira menos
    const mag = Math.hypot(this.inputX, this.inputY);
    let newAngularVel = 0;
    if (mag > 1e-4) {
      const targetAngle = Math.atan2(this.inputY, this.inputX);
      const delta = wrapAngle(targetAngle - this.angle);
      newAngularVel = clamp(delta * 8, -turnRate, turnRate);
      this.angle = wrapAngle(this.angle + newAngularVel * dt);
    }
    this.angularVel = newAngularVel;

    // ---- Velocidad objetivo (casi constante entre snapshots => la
    //      extrapolación lineal del cliente funciona) ----
    let tx, ty, k;
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      tx = this.dashDirX * this.dashSpeed;
      ty = this.dashDirY * this.dashSpeed;
      k = P.dashK;
    } else if (this.retreatTime > 0) {
      this.retreatTime -= dt;
      tx = this.retreatDirX * P.retreatSpeed;
      ty = this.retreatDirY * P.retreatSpeed;
      k = P.dashK;
    } else {
      const throttle = Math.min(1, mag * 1.4);   // más lejos del cursor = más rápido
      tx = Math.cos(this.angle) * this.maxSpeed * throttle;
      ty = Math.sin(this.angle) * this.maxSpeed * throttle;
      k = P.accelK;
    }
    const blend = 1 - Math.exp(-k * dt);
    this.vx += (tx - this.vx) * blend;
    this.vy += (ty - this.vy) * blend;

    // ---- Integrar posición ----
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // ---- Paredes: clamp + rebote limpio ----
    const r = P.bodyRadius;
    if (this.x < r) { this.x = r; this.vx = Math.abs(this.vx) * P.wallBounce; }
    else if (this.x > this.room.width - r) { this.x = this.room.width - r; this.vx = -Math.abs(this.vx) * P.wallBounce; }
    if (this.y < r) { this.y = r; this.vy = Math.abs(this.vy) * P.wallBounce; }
    else if (this.y > this.room.height - r) { this.y = this.room.height - r; this.vy = -Math.abs(this.vy) * P.wallBounce; }

    // ---- Cadena (mismo integrador que el cliente) ----
    CHAIN.updateChain(this, dt);
  }

  applyUpgrade(id) {
    switch (id) {
      case 0: this.upgrades.tusk++; break;                    // Tusk Upgraded!
      case 1: this.upgrades.speed++; break;                   // Speed Up!
      case 2: this.upgrades.turn++; break;                    // Turn Rate Up!
      case 3: this.upgrades.dashSpeed++; break;               // Dash Speed Up!
      case 4: this.upgrades.staminaRegen++; break;            // Stamina Regen Up!
      case 5: this.upgrades.stamina++; this.maxDash++; break; // Stamina Up!
    }
    this.updateTusk();
  }

  grow(amount) {
    const g = CONFIG.growth;
    this.size = Math.min(this.size + amount, 250);
    this.updateTusk();
    const newLevel = Math.floor((this.size - g.baseSize) / g.levelStep) + 1;
    const earned = [];
    while (this.level < newLevel) {
      this.level++;
      const upg = Math.floor(Math.random() * 6);
      this.applyUpgrade(upg);
      earned.push(upg);
    }
    return earned;
  }

  // Corte en el segmento k (índice de la parte tocada por el colmillo)
  cutAt(k, pushX, pushY) {
    // k <= 2 (cerca de la cabeza) o quedaría con muy pocas partes -> muere
    if (k <= 2 || k < CONFIG.dash.minLivingParts) return this.die();

    this.breakPoint = k;
    const tail = this.parts.splice(k, 1)[0];   // el cliente hace el mismo splice
    // La cola cortada sale despedida con el empuje del golpe
    const idx = Math.min(k, this.parts.length - 1);
    this.parts[idx].vx = pushX;
    this.parts[idx].vy = pushY;
    this.cutCooldown = CONFIG.dash.cutCooldown;
    if (tail) { /* la parte eliminada desaparece; la cola queda anclada en idx */ }
  }

  die(killer) {
    if (!this.isAlive || this.invincibleDur > 0) return;
    this.isAlive = false;
    if (killer && killer !== this) {
      killer.kills++;
      killer.score += this.level * 100;
      const earned = killer.grow(CONFIG.growth.killGrow);
      if (earned.length) killer.sendPlayerInfo(earned);
    }
    this.sendRIP();
  }

  sendRIP() {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(Buffer.from([OPCODES.RIP]));
    }
  }

  sendPlayerInfo(upgrades) {
    const buf = Buffer.alloc(3 + upgrades.length); // opcode + level + count + ids
    let o = 0;
    buf.writeUInt8(OPCODES.PLAYER_INFO, o++);
    buf.writeUInt8(Math.min(this.level, 255), o++);
    buf.writeUInt8(upgrades.length, o++);
    for (const u of upgrades) buf.writeUInt8(u, o++);
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(buf);
  }
}

// ==================== SALA ====================
class GameRoom {
  constructor(id, name, width, height, desirablePlayerNum) {
    this.id = id;
    this.name = name;
    this.width = width;
    this.height = height;
    this.desirablePlayerNum = desirablePlayerNum;
    this.players = new Map();  // id -> Narwhal
  }

  add(p) { this.players.set(p.id, p); p.spawn(this); }
  remove(id) {
    const p = this.players.get(id);
    if (p) p.room = null;
    this.players.delete(id);
  }

  update(dt) {
    for (const p of this.players.values()) p.update(dt);
    this.collideBodies();
    this.collideTusks();
  }

  // ---- Cuerpo vs cuerpo: separación suave ----
  collideBodies() {
    const P = CONFIG.physics;
    const list = [...this.players.values()].filter(p => p.isAlive);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b];
        const liveA = Math.min(A.breakPoint, A.parts.length);
        const liveB = Math.min(B.breakPoint, B.parts.length);
        for (let i = 0; i < liveA; i++) {
          for (let j = 0; j < liveB; j++) {
            const pa = A.parts[i], pb = B.parts[j];
            const dx = pb.x - pa.x, dy = pb.y - pa.y;
            const d2 = dx * dx + dy * dy;
            const minD = P.bodyRadius * 2;
            if (d2 < minD * minD && d2 > 1e-6) {
              const d = Math.sqrt(d2);
              const nx = dx / d, ny = dy / d;
              const push = (minD - d) * 0.5 * 0.6; // 60% de corrección (suave)
              pa.x -= nx * push; pa.y -= ny * push;
              pb.x += nx * push; pb.y += ny * push;
              // Empuje de velocidad leve y simétrico
              const imp = 40;
              A.vx -= nx * imp * 0.016; A.vy -= ny * imp * 0.016;
              B.vx += nx * imp * 0.016; B.vy += ny * imp * 0.016;
            }
          }
        }
        // La cabeza autoritativa sigue a la parte 0 tras la separación
        A.x = A.parts[0].x; A.y = A.parts[0].y;
        B.x = B.parts[0].x; B.y = B.parts[0].y;
      }
    }
  }

  // ---- Colmillo vs cuerpo: corte / kill (mecánica original) ----
  collideTusks() {
    const list = [...this.players.values()].filter(p => p.isAlive);
    for (const atk of list) {
      if (atk.invincibleDur > 0 && atk.spawnAge > CONFIG.dash.invincibleTime) { /* puede cortar igual */ }
      const head = atk.parts[0];
      const len = atk.tuskLen;
      const tx = head.x + Math.cos(atk.angle) * len;
      const ty = head.y + Math.sin(atk.angle) * len;

      for (const vic of list) {
        if (vic === atk || !vic.isAlive) continue;
        if (vic.invincibleDur > 0) continue;          // spawn protegido
        const live = Math.min(vic.breakPoint, vic.parts.length);
        for (let k = 0; k < live; k++) {
          const part = vic.parts[k];
          // distancia punto-segmento (cabeza atacante -> punta del colmillo)
          const d = distToSegment(part.x, part.y, head.x, head.y, tx, ty);
          if (d < CONFIG.physics.bodyRadius + 4) {
            // Empuje del golpe sobre la víctima
            const ang = atk.angle;
            const power = 220 + (atk.dashTime > 0 ? 260 : 0);
            vic.vx += Math.cos(ang) * power;
            vic.vy += Math.sin(ang) * power;
            if (k <= 2) {
              vic.die(atk);                            // colmillo en la cabeza = muerte
            } else if (vic.cutCooldown <= 0) {
              vic.cutAt(k, Math.cos(ang) * 300, Math.sin(ang) * 300);
              const earned = atk.grow(CONFIG.growth.cutGrow);
              if (earned.length) atk.sendPlayerInfo(earned);
            }
            break;
          }
        }
      }
    }
  }

  // ==================== BROADCAST: SetElements ====================
  broadcastGameState() {
    const buf = Buffer.alloc(65536);
    let o = 0;
    buf.writeUInt8(OPCODES.SET_ELEMENTS, o++);
    buf.writeDoubleLE(simTime, o); o += 8;   // ¡SEGUNDOS monótonos!

    const alive = [...this.players.values()].filter(p => p.isAlive);
    for (const p of alive) {
      o = encodeElement(buf, o, p);
      if (o > 60000) break;
    }

    const packet = buf.slice(0, o);
    for (const p of this.players.values()) {
      if (p.socket.readyState === WebSocket.OPEN) p.socket.send(packet);
    }
  }

  broadcastLeaderboard() {
    const top = [...this.players.values()]
      .sort((a, b) => b.score - a.score || b.level - a.level)
      .slice(0, 10);
    if (!top.length) return;

    let size = 2;
    for (const p of top) size += 1 + stringToBytes(p.name).length;
    const buf = Buffer.alloc(size);
    let o = 0;
    buf.writeUInt8(OPCODES.LEADER_BOARD, o++);
    buf.writeUInt8(top.length, o++);
    for (const p of top) {
      buf.writeUInt8(Math.min(p.level, 255), o++);
      for (const b of stringToBytes(p.name)) buf.writeUInt8(b, o++);
    }
    const packet = buf.slice(0, o);
    for (const p of this.players.values()) {
      if (p.socket.readyState === WebSocket.OPEN) p.socket.send(packet);
    }
  }
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// ---- Codificador de un narval (formato EXACTO del parser del cliente) ----
function encodeElement(buf, o, p) {
  const head = p.parts[0];

  // id: U32LE — el cliente lee los 16 bits bajos (getUint16, avanza 4)
  buf.writeUInt32LE(p.id >>> 0, o); o += 4;

  // color RGB
  buf.writeUInt8((p.color >> 16) & 0xff, o++);
  buf.writeUInt8((p.color >> 8) & 0xff, o++);
  buf.writeUInt8(p.color & 0xff, o++);

  // nombre (encodeURIComponent + \0)
  for (const b of stringToBytes(p.name)) buf.writeUInt8(b, o++);

  buf.writeUInt8(Math.min(p.breakPoint, 255), o++);                    // breakPoint
  buf.writeUInt8(Math.round(clamp(p.alpha, 0, 1) * 255), o++);         // alpha
  buf.writeUInt8((p.maxDash & 0x0f) | ((p.curDash & 0x0f) << 4), o++); // dash
  buf.writeUInt8(Math.round(clamp(p.overDash, 0, 1) * 255), o++);      // overDash
  buf.writeUInt8(Math.round(clamp(p.tuskRatio / 2, 0, 1) * 255), o++); // tuskRatio (/255*2)
  buf.writeUInt8(p.decoration & 0xff, o++);                            // decoration

  // Cabeza: x, y, speed, velAngle, rot
  buf.writeFloatLE(head.x, o); o += 4;
  buf.writeFloatLE(head.y, o); o += 4;
  let speed = Math.hypot(head.vx, head.vy);
  if (!Number.isFinite(speed)) speed = 0;             // blindaje anti-NaN
  buf.writeUInt16LE(Math.min(Math.round(speed), 65535), o); o += 2;
  const velAng = speed > 1e-3 ? Math.atan2(head.vy, head.vx) : p.angle;
  buf.writeInt8(Math.round(clamp(velAng / Math.PI, -1, 1) * 127), o++);
  buf.writeInt8(Math.round(clamp(head.rot / Math.PI, -1, 1) * 127), o++);

  // Partes 1..f
  const f = p.parts.length - 1;
  buf.writeUInt8(f, o++);
  for (let i = 1; i < p.parts.length; i++) {
    const part = p.parts[i];
    if (i === p.breakPoint) {
      buf.writeFloatLE(part.x, o); o += 4;
      buf.writeFloatLE(part.y, o); o += 4;
      buf.writeFloatLE(part.vx, o); o += 4;
      buf.writeFloatLE(part.vy, o); o += 4;
    } else {
      buf.writeInt8(Math.round(clamp(part.rot / Math.PI, -1, 1) * 127), o++);
    }
  }
  return o;
}

// ==================== SERVIDOR ====================
let simTime = 0;             // reloj de simulación en SEGUNDOS (para SetElements)
let uidCounter = 1;

class NarwhaleServer {
  constructor() {
    this.players = new Map();   // uid -> Narwhal
    this.rooms = new Map();
    this.leaderboardAccum = 0;

    // ==================== TAMAÑOS DE SALA (originales del usuario) ====================
    // 6400 es 5 * 1280. 3840 es 3 * 1280. Todo son múltiplos.
    this.rooms.set(0, new GameRoom(0, 'Large 1', 6000, 6000, 25));
    this.rooms.set(1, new GameRoom(1, 'Large 2', 6000, 6000, 25));
    this.rooms.set(2, new GameRoom(2, 'Sparse', 6000, 6000, 15));
    this.rooms.set(3, new GameRoom(3, 'Small 1', 3840, 3840, 9));
    this.rooms.set(4, new GameRoom(4, 'Small 2', 3840, 3840, 9));
    this.rooms.set(5, new GameRoom(5, 'Mega Small', 1200, 1200, 9));
  }

  start() {
    const port = Number(process.env.NARWHALE_PORT) || CONFIG.port;

    // HTTP: sirve el cliente en el mismo puerto (abrir http://localhost:8080 y jugar)
    const httpServer = http.createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocket.Server({ server: httpServer, host: '0.0.0.0' });
    this.wss.on('connection', (socket) => this.onConnection(socket));

    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`🌊 Narwhale Classic — servidor en http://localhost:${port} (WS en el mismo puerto)`);
    });

    this.startLoop();
  }

  serveStatic(req, res) {
    const files = {
      '/': ['index.html', 'text/html'],
      '/index.html': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'application/javascript'],
      '/pixi.js': ['pixi.js', 'application/javascript'],
      '/main.css': ['main.css', 'text/css'],
    };
    const route = files[req.url.split('?')[0]];
    if (route) {
      fs.readFile(path.join(__dirname, route[0]), (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': route[1] });
        res.end(data);
      });
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }

  onConnection(socket) {
    socket.uid = 0;
    socket.roomId = null;
    socket.on('message', (data) => this.onMessage(socket, data));
    socket.on('close', () => this.onDisconnect(socket));
    socket.on('error', () => {});
  }

  onMessage(socket, data) {
    if (!data || !data.length) return;
    const op = data[0];
    switch (op) {
      case OPCODES.GET_LOBBIES: return this.handleGetLobbies(socket);
      case OPCODES.JOIN: return this.handleJoin(socket, data);
      case OPCODES.LEAVE: return this.handleLeave(socket);
      case OPCODES.START: return this.handleStart(socket, data);
      case OPCODES.UPDATE_TARGET: return this.handleTarget(socket, data);
      case OPCODES.SPLIT_UP: return this.handleDash(socket, data);
      case OPCODES.RETREAT: return this.handleRetreat(socket, data);
      case OPCODES.PING: return this.handlePing(socket, data);
    }
  }

  handleGetLobbies(socket) {
    const rooms = [...this.rooms.values()].map(r => ({
      id: r.id,
      name: r.name,
      area: 'Practice',
      playerCount: r.players.size,
      options: {
        width: r.width,
        height: r.height,
        cellWidth: 1200, // <-- clave: 640 en lugar de 1280 (original del usuario)
        hasIndicator: false,
        isPriority: r.id < 2,
        fieldType: 0,
        desirablePlayerNum: r.desirablePlayerNum,
        hasSlowFactor: false,
      },
    }));
    const json = JSON.stringify(rooms);
    socket.send(Buffer.concat([
      Buffer.from([OPCODES.GET_LOBBIES]),
      Buffer.from(json, 'utf8'),
      Buffer.from([0]),
    ]));
  }

  handleJoin(socket, data) {
    if (data.length < 5) return;
    const roomId = data.readUInt32LE(1);
    if (!this.rooms.has(roomId)) return;
    if (socket.roomId !== null && socket.roomId !== roomId) {
      const old = this.rooms.get(socket.roomId);
      if (old && socket.uid) old.remove(socket.uid);
    }
    socket.roomId = roomId;
  }

  handleLeave(socket) {
    if (socket.roomId !== null) {
      const room = this.rooms.get(socket.roomId);
      if (room && socket.uid) room.remove(socket.uid);
    }
    socket.roomId = null;
  }

  handleStart(socket, data) {
    const [, name] = parseStringBytes(data, 1);

    // (Re)spawn: el cliente manda START también para revivir tras el RIP
    let p = this.players.get(socket.uid);
    if (!p) {
      socket.uid = (uidCounter++) & 0xffff || (uidCounter = 1) & 0xffff; // UID 16 bits sin colisiones
      p = new Narwhal(socket.uid, socket, name);
      this.players.set(socket.uid, p);
    }
    p.socket = socket;
    p.name = (name || 'Narwhal').slice(0, 25);

    if (socket.roomId === null) socket.roomId = 0;
    const room = this.rooms.get(socket.roomId);
    if (!room) return;
    // Si venía de otra sala, sacarlo
    if (p.room && p.room !== room) p.room.remove(p.id);
    room.add(p);

    // Respuesta START: opcode + UID (U16LE) — debe casar con SetElements
    const res = Buffer.alloc(3);
    res.writeUInt8(OPCODES.START, 0);
    res.writeUInt16LE(p.id & 0xffff, 1);
    socket.send(res);

    console.log(`🐳 ${p.name} (uid ${p.id}) entró a ${room.name} — ${room.players.size} jugadores`);
  }

  handleTarget(socket, data) {
    if (data.length < 9) return;
    const p = this.players.get(socket.uid);
    if (p && p.isAlive) p.setInput(data.readFloatLE(1), data.readFloatLE(5));
  }

  handleDash(socket, data) {
    const p = this.players.get(socket.uid);
    if (!p || !p.isAlive) return;
    if (data.length >= 9) p.useDash(data.readFloatLE(1), data.readFloatLE(5));
    else p.useDash(Math.cos(p.angle), Math.sin(p.angle));
  }

  handleRetreat(socket, data) {
    const p = this.players.get(socket.uid);
    if (!p || !p.isAlive) return;
    if (data.length >= 9) p.useRetreat(data.readFloatLE(1), data.readFloatLE(5));
    else p.useRetreat(-Math.cos(p.angle), -Math.sin(p.angle));
  }

  handlePing(socket, data) {
    if (data.length < 5) return;
    const res = Buffer.alloc(5);
    res.writeUInt8(OPCODES.PING, 0);
    res.writeFloatLE(data.readFloatLE(1), 1);   // echo exacto (el cliente mide RTT)
    socket.send(res);
  }

  onDisconnect(socket) {
    if (socket.uid && this.players.has(socket.uid)) {
      const p = this.players.get(socket.uid);
      if (p.room) p.room.remove(socket.uid);
      this.players.delete(socket.uid);
    }
  }

  startLoop() {
    const dt = 1 / CONFIG.tickRate;          // dt FIJO: misma integración que el cliente
    let sinceSnapshot = 0;
    setInterval(() => {
      simTime += dt;

      for (const room of this.rooms.values()) {
        if (room.players.size) room.update(dt);
      }

      sinceSnapshot += dt;
      if (sinceSnapshot >= CONFIG.snapshotEvery * dt - 1e-9) {
        sinceSnapshot = 0;
        for (const room of this.rooms.values()) {
          if (room.players.size) room.broadcastGameState();
        }
      }

      this.leaderboardAccum += dt;
      if (this.leaderboardAccum >= CONFIG.leaderboardEvery) {
        this.leaderboardAccum = 0;
        for (const room of this.rooms.values()) {
          if (room.players.size) room.broadcastLeaderboard();
        }
      }
    }, 1000 / CONFIG.tickRate);
  }
}

// ==================== INICIAR ====================
const server = new NarwhaleServer();
server.start();

console.log(`
================================================================
   NARWHALE CLASSIC (2016) — SERVIDOR RECONSTRUIDO
================================================================
Puerto HTTP+WS: ${CONFIG.port}   |  Tick: ${CONFIG.tickRate} Hz   |  Snapshots: ${CONFIG.tickRate / CONFIG.snapshotEvery}/s

Física espejada con el cliente:
  ✓ time de SetElements en SEGUNDOS (bug del throttling corregido)
  ✓ cadena con segLen=36 + updaterel idéntico (damp 0.15+0.35i/N, maxAng 2π/3(i-1)/10)
  ✓ cabeza a velocidad ~constante entre snapshots (extrapolación lineal del cliente)
  ✓ corte por colmillo con breakPoint + splice sincronizado
  ✓ UID 16 bits consistente entre START y SetElements

Abrí http://localhost:${CONFIG.port} y jugá. Bots: node botardo.js
================================================================
`);
