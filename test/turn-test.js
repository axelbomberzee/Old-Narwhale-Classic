'use strict';
/*
 * Test de orientación con inercia:
 *  - la cabeza sigue el input (gradual) y congela rumbo en zona muerta
 *  - durante giros la nariz puede laguear (inercia) pero acotado
 *  - al asentarse, la nariz se realinea con la cabeza
 *  - la cola hace látigo (desvío de segmentos medios >> nariz)
 *  - zona muerta frena
 */
const WebSocket = require('ws');
const URL = process.env.VERIFY_URL || 'ws://localhost:8080';
const OP = { JOIN: 16, START: 18, UPDATE_TARGET: 32, SET_ELEMENTS: 48 };

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ FALLO: ') + m); if (!c) fails++; };

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';
let uid = null, last = null;
const noseDev = [], midDev = [], tailDev = [];

function sendInput(x, y) {
  const b = Buffer.alloc(9);
  b.writeUInt8(OP.UPDATE_TARGET, 0);
  b.writeFloatLE(x, 1); b.writeFloatLE(y, 5);
  ws.send(b);
}

ws.on('open', () => {
  const j = Buffer.alloc(5); j.writeUInt8(OP.JOIN, 0); j.writeUInt32LE(0, 1); ws.send(j);
  ws.send(Buffer.from([OP.START, 0x54, 0x75, 0x72, 0x6e, 0x00])); // "Turn"
});

ws.on('message', (d) => {
  const dv = new DataView(d.buffer || d);
  if (dv.getUint8(0) === OP.START) { uid = dv.getUint16(1, true); return; }
  if (dv.getUint8(0) !== OP.SET_ELEMENTS) return;
  let e = 9;
  while (e < dv.byteLength) {
    const id = dv.getUint16(e, true); e += 4 + 3;
    while (dv.getUint8(e) !== 0) e++; e++;
    const bp = dv.getUint8(e); e += 6;
    const x = dv.getFloat32(e, true), y = dv.getFloat32(e + 4, true);
    const speed = dv.getUint16(e + 8, true);
    const rot = dv.getInt8(e + 11) / 127 * Math.PI;
    e += 12;
    const f = dv.getUint8(e++);
    const rots = {};
    for (let i = 1; i <= f; i++) {
      if (i === bp) e += 16;
      else { rots[i] = dv.getInt8(e) / 127 * Math.PI; e += 1; }
    }
    if (id === uid) {
      last = { rot, speed, x, y, rots, phase };
      if (rots[1] !== undefined && phase === 'turn') {
        noseDev.push(Math.abs(wrap(rots[1] - rot)));
        midDev.push(Math.abs(wrap((rots[4] || rot) - rot)));
        tailDev.push(Math.abs(wrap((rots[9] || rot) - rot)));
      }
    }
  }
});

let phase = 'settle';

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });

setTimeout(() => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    if (t < 1.2) { phase = 'settle'; sendInput(1, 0); }
    else if (t < 2.6) { phase = 'turn'; sendInput(0, 1); }          // giro +PI/2
    else if (t < 4.0) { phase = 'turn'; sendInput(-1, 0.001); }     // giro a PI
    else if (t < 4.4) { phase = 'settle'; sendInput(-1, 0.001); }   // mantener y asentar
    else if (t < 6.4) { phase = 'dead'; sendInput(0.04, 0.01); }    // zona muerta
    else {
      clearInterval(timer);
      const maxNose = Math.max(...noseDev, 0);
      const maxMid = Math.max(...midDev, 0);
      const maxTail = Math.max(...tailDev, 0);
      const noseEnd = last && last.rots[1] !== undefined
        ? Math.abs(wrap(last.rots[1] - last.rot)) : 99;

      ok(Math.abs(wrap(last.rot - Math.PI)) < 0.35,
        `cabeza llegó al input y congeló rumbo (rot=${last.rot.toFixed(2)} vs PI=3.14)`);
      ok(maxNose < 0.6,
        `nariz laguea acotado durante giros (máx ${(maxNose * 57.3).toFixed(1)}° < 34°)`);
      ok(noseEnd < 0.12,
        `al asentarse la nariz se realinea (desvío final ${(noseEnd * 57.3).toFixed(1)}°)`);
      ok(maxTail > maxNose + 0.25 && maxTail > 0.7,
        `cola hace látigo (máx cola ${(maxTail * 57.3).toFixed(0)}° > nariz+14°)`);
      ok(last.speed < 40,
        `zona muerta frena (speed=${last.speed.toFixed(0)} px/s)`);

      console.log(fails === 0 ? '\n✅ ORIENTACIÓN+INERCIA OK' : `\n❌ ${fails} fallos`);
      process.exit(fails === 0 ? 0 : 1);
    }
  }, 50);
}, 300);
