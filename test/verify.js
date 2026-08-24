'use strict';
/*
 * Harness de verificación: replica EXACTAMENTE el parser y la extrapolación
 * del cliente (traducidos de app.js) y comprueba que el servidor casa con
 * la interpolación visual del cliente.
 *
 *   node test/verify.js
 */
const WebSocket = require('ws');

const URL = process.env.VERIFY_URL || 'ws://localhost:8080';
const OPCODES = {
  JOIN: 16, START: 18, GET_LOBBIES: 19, UPDATE_TARGET: 32, SPLIT_UP: 33,
  RIP: 34, RETREAT: 35, PING: 37, SET_ELEMENTS: 48, PLAYER_INFO: 49, LEADER_BOARD: 50,
};

// ---------- Réplica del parser del cliente (SetElementsPacket.parseData) ----------
function parseString(dv, off) {
  const bytes = [];
  for (;;) {
    const b = dv.getUint8(off++);
    if (b === 0) break;
    bytes.push(b);
  }
  return [off, decodeURIComponent(String.fromCharCode.apply(null, bytes))];
}

function parseElement(dv, e) {
  const el = { parts: [] };
  el.id = dv.getUint16(e, true); e += 4;      // lee U16, AVANZA 4 (quirk del cliente)
  el.color = 0;
  for (let i = 0; i < 3; i++) { el.color = (el.color << 8) + dv.getUint8(e++); }
  let r = parseString(dv, e); e = r[0]; el.name = r[1];
  el.size = 36;                                // hardcodeado en el cliente
  el.breakPoint = dv.getUint8(e++);
  el.alpha = dv.getUint8(e++) / 255;
  const d = dv.getUint8(e++);
  el.maxDash = 15 & d; el.curDash = (d >> 4) & 15;
  el.overDash = dv.getUint8(e++) / 255;
  el.tuskRatio = dv.getUint8(e++) / 255 * 2;
  el.decoration = dv.getUint8(e++);
  const x = dv.getFloat32(e, true); e += 4;
  const y = dv.getFloat32(e, true); e += 4;
  const speed = dv.getUint16(e, true); e += 2;
  const velAng = dv.getInt8(e++) / 127 * Math.PI;
  const head = {
    x, y,
    vx: speed * Math.cos(velAng),
    vy: speed * Math.sin(velAng),
    rot: dv.getInt8(e++) / 127 * Math.PI,
    vt: 0,
  };
  el.parts.push(head);
  const f = dv.getUint8(e++);
  for (let i = 1; i < f + 1; i++) {
    const p = {};
    if (i !== el.breakPoint) {
      p.rot = dv.getInt8(e++) / 127 * Math.PI; p.vt = 0; p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
    } else {
      p.x = dv.getFloat32(e, true); e += 4;
      p.y = dv.getFloat32(e, true); e += 4;
      p.vx = dv.getFloat32(e, true); e += 4;
      p.vy = dv.getFloat32(e, true); e += 4;
      p.rot = 0; p.vt = 0;
    }
    el.parts.push(p);
  }
  return [e, el];
}

function parseSetElements(dv) {
  const pkt = { time: dv.getFloat64(1, true), elements: [] };
  let e = 9;
  while (e < dv.byteLength) {
    const r = parseElement(dv, e);
    e = r[0];
    pkt.elements.push(r[1]);
  }
  return pkt;
}

// ---------- Réplica de ChainElement.update del cliente (extrapolación visual) ----------
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function updaterel(part, px, py, prevRot, segLen, dt, damp, maxAngle) {
  part.vt -= part.vt * damp;
  part.rot += dt * part.vt;
  let a = wrap(part.rot - prevRot);
  if (a > maxAngle && part.vt > 0) part.vt *= 1 - 0.75 * dt * 60;
  else if (a < -maxAngle && part.vt < 0) part.vt *= 1 - 0.75 * dt * 60;
  part.x = px + Math.cos(part.rot + Math.PI) * segLen;
  part.y = py + Math.sin(part.rot + Math.PI) * segLen;
}
function chainUpdate(el, dt) {
  const N = el.parts.length;
  let prev;
  for (let r = 0; r < N; r++) {
    if (el.breakPoint === r) prev = undefined;
    const part = el.parts[r];
    if (prev) {
      const damp = 0.15 + ((N - r) / N) * 0.35;
      const maxAngle = (2 * Math.PI / 3) * (r - 1) / 10;
      updaterel(part, prev.x, prev.y, prev.rot, el.size, dt, damp, maxAngle);
    } else {
      part.x += part.vx * dt; part.y += part.vy * dt;
    }
    prev = part;
  }
}

// ---------- Prueba ----------
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ FALLO: ') + msg);
  if (!cond) fails++;
};

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';

let myUid = null;
let serverEls = null;        // elementos del último snapshot (extrapolados)
let lastSnapTime = null;     // time del servidor del último snapshot
let snapDeltas = [];
let exErrorsHead = [], exErrorsParts = [];
let gotLeaderboard = false, leaderboardOk = false, gotLobbies = false;

ws.on('open', () => {
  console.log('conectado a', URL);
  const join = Buffer.alloc(5);
  join.writeUInt8(OPCODES.JOIN, 0); join.writeUInt32LE(0, 1);
  ws.send(join);
  ws.send(Buffer.from([OPCODES.GET_LOBBIES]));
  const start = Buffer.from([OPCODES.START, 0x54, 0x65, 0x73, 0x74, 0x00]); // "Test"
  ws.send(start);
  // Moverse en círculos para estresar giro/extrapolación
  let t = 0;
  setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    t += 0.05;
    const buf = Buffer.alloc(9);
    buf.writeUInt8(OPCODES.UPDATE_TARGET, 0);
    buf.writeFloatLE(Math.cos(t * 1.5), 1);
    buf.writeFloatLE(Math.sin(t * 1.5), 5);
    ws.send(buf);
    if (Math.random() < 0.03) ws.send(Buffer.from([OPCODES.SPLIT_UP]));
  }, 50);
});

ws.on('message', (data) => {
  const dv = new DataView(data.buffer || data);
  const op = dv.getUint8(0);
  switch (op) {
    case OPCODES.START:
      myUid = dv.getUint16(1, true);
      console.log('START -> uid', myUid);
      break;
    case OPCODES.GET_LOBBIES: {
      gotLobbies = true;
      const [, json] = parseString(dv, 1);
      const rooms = JSON.parse(json);
      ok(Array.isArray(rooms) && rooms.length >= 1 && rooms[0].options && rooms[0].options.width > 0,
        `GetLobbies: ${rooms.length} salas, options ok`);
      break;
    }
    case OPCODES.SET_ELEMENTS: {
      const pkt = parseSetElements(dv);

      // 1) time en SEGUNDOS con delta ~estable
      if (lastSnapTime !== null) snapDeltas.push(pkt.time - lastSnapTime);
      lastSnapTime = pkt.time;

      // 2) medir error de extrapolación ANTES de reemplazar los elementos
      //    - cabeza: posición (el paquete trae x,y)
      //    - cola: ROTACIÓN (el paquete solo trae rot; x,y los reconstruye el cliente)
      if (serverEls) {
        for (const elNew of pkt.elements) {
          const elOld = serverEls[elNew.id];
          if (!elOld) continue;
          const h = elNew.parts[0];
          exErrorsHead.push(Math.hypot(h.x - elOld.parts[0].x, h.y - elOld.parts[0].y));
          for (let i = 1; i < Math.min(4, elNew.parts.length); i++) {
            const a = elNew.parts[i], b = elOld.parts[i];
            if (a && b && (i !== elNew.breakPoint)) {
              exErrorsParts.push(Math.abs(wrap(a.rot - b.rot)) * 180 / Math.PI);
            }
          }
        }
      }

      // 3) reemplazar (mezcla vt como el cliente) y seguir extrapolando
      const next = {};
      for (const el of pkt.elements) {
        const old = serverEls && serverEls[el.id];
        if (old) {
          // blend vt del cliente: d.vt = 0.8*old.vt + 0.2*(Δrot/Δt)
          for (const k in el.parts) {
            const part = el.parts[k];
            const prevPart = old.parts[k];
            if (part && prevPart && +k !== el.breakPoint && +k > 0) {
              const dr = wrap(part.rot - prevPart.rot);
              part.vt = 0.8 * prevPart.vt + 0.2 * (dr / 0.0667);
              part.x = prevPart.x; part.y = prevPart.y; // el cliente mantiene pos y lerpa en render
            } else if (+k === 0) {
              part.vt = 0;
            }
          }
        }
        next[el.id] = el;
      }
      serverEls = next;
      break;
    }
    case OPCODES.LEADER_BOARD: {
      gotLeaderboard = true;
      let e = 1;
      const count = dv.getUint8(e++);
      let parsed = 0;
      try {
        for (let i = 0; i < count; i++) {
          e++; // level
          const r = parseString(dv, e); e = r[0];
          if (typeof r[1] !== 'string') throw new Error('nombre');
          parsed++;
        }
        leaderboardOk = parsed === count;
      } catch (err) { leaderboardOk = false; }
      break;
    }
  }
});

// Extrapolar a 60fps entre mensajes (como hace el cliente con rAF)
setInterval(() => {
  if (serverEls) for (const id in serverEls) chainUpdate(serverEls[id], 1 / 60);
}, 1000 / 60);

setTimeout(() => {
  console.log('\n================ RESULTADOS ================');
  ok(myUid !== null, 'START recibido con uid U16');

  ok(snapDeltas.length > 20, `snapshots recibidos: ${snapDeltas.length}`);
  const avgDelta = snapDeltas.reduce((a, b) => a + b, 0) / (snapDeltas.length || 1);
  ok(avgDelta > 0.03 && avgDelta < 0.2,
    `time en SEGUNDOS (delta promedio ${avgDelta.toFixed(3)}s ~ ${(1 / avgDelta).toFixed(1)} snapshots/s)`);
  const jitter = snapDeltas.filter(d => Math.abs(d - avgDelta) > 0.05).length;
  ok(jitter / (snapDeltas.length || 1) < 0.2, `timing estable (${jitter}/${snapDeltas.length} fuera de rango)`);

  const mine = serverEls && serverEls[myUid];
  ok(!!mine, `mi uid (${myUid}) aparece en SetElements`);
  if (mine) {
    const fin = mine.parts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.rot));
    ok(fin && mine.parts.length === 11, `cadena íntegra (11 partes, sin NaN): ${mine.parts.length}`);
    const d01 = Math.hypot(mine.parts[1].x - mine.parts[0].x, mine.parts[1].y - mine.parts[0].y);
    ok(Math.abs(d01 - 36) < 8, `espaciado de segmentos ≈ 36px (medido ${d01.toFixed(1)})`);
  }

  const avgHead = exErrorsHead.reduce((a, b) => a + b, 0) / (exErrorsHead.length || 1);
  const p95Head = exErrorsHead.slice().sort((a, b) => a - b)[Math.floor(exErrorsHead.length * 0.95)] || 0;
  ok(avgHead < 30, `error extrapolación cabeza: promedio ${avgHead.toFixed(1)}px (p95 ${p95Head.toFixed(1)}px)`);
  const avgTail = exErrorsParts.reduce((a, b) => a + b, 0) / (exErrorsParts.length || 1);
  const p95Tail = exErrorsParts.slice().sort((a, b) => a - b)[Math.floor(exErrorsParts.length * 0.95)] || 0;
  ok(avgTail < 12, `error extrapolación cola (rotación): promedio ${avgTail.toFixed(1)}° (p95 ${p95Tail.toFixed(1)}°)`);

  ok(gotLeaderboard && leaderboardOk, 'LeaderBoard parsea limpio (sin bloque extra)');

  console.log('\n' + (fails === 0 ? '✅ TODO OK — el servidor casa con la interpolación del cliente'
    : `❌ ${fails} comprobaciones fallaron`));
  process.exit(fails === 0 ? 0 : 1);
}, 12000);

ws.on('error', (e) => { console.error('error ws:', e.message); process.exit(1); });
