'use strict';
/*
 * Test del modelo RASTRO (path following):
 *  - la nariz (tangente del rastro) sigue el desplazamiento, no el rumbo interno
 *  - durante giros la nariz laguea acotada (curva del path)
 *  - en línea recta la nariz se alinea con el viaje
 *  - SIN MOVIMIENTO NO HAY MOVIMIENTO: frenado => TODAS las rots congeladas
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
let uid = null, last = null, prev = null, lastDelta = 0;
const noseDev = [];
const neckDev = [];
let phase = 'settle';
const frozenDeltas = [];

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
      prev = last;
      last = { rot, speed, rots };
      if (phase === 'turn' && prev) {
        noseDev.push(Math.abs(wrap((rots[5] || rot) - rot)));
      }
      if (phase === 'settle' && prev) {
        // en lín­ea recta la cabeza queda alineada con el cuerpo (path)
        neckDev.push(Math.abs(wrap((rots[1] || rot) - rot)));
      }
      if (phase === 'frozen' && prev && frozenStart > 0 && Date.now() - frozenStart > 1300) {
        let mx = Math.abs(wrap(rot - prev.rot));
        for (let i = 1; i <= 10; i++) {
          if (rots[i] !== undefined && prev.rots[i] !== undefined) {
            mx = Math.max(mx, Math.abs(wrap(rots[i] - prev.rots[i])));
          }
        }
        frozenDeltas.push(mx);
      }
    }
  }
});

let frozenStart = 0;
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });

setTimeout(() => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    if (t < 1.2) { phase = 'settle'; sendInput(1, 0); }             // recta
    else if (t < 2.6) { phase = 'turn'; sendInput(0, 1); }          // curva
    else if (t < 4.0) { phase = 'turn'; sendInput(-1, 0.001); }     // curva a PI
    else if (t < 4.5) { phase = 'settle'; sendInput(-1, 0.001); }   // recta, asentar
    else if (t < 6.5) { if (phase !== 'frozen') frozenStart = Date.now(); phase = 'frozen'; sendInput(0.04, 0.01); } // frenar y congelar
    else {
      clearInterval(timer);
      const maxNose = Math.max(...noseDev, 0);
      const maxNeck = Math.max(...neckDev, 0);
      const maxFrozen = Math.max(...frozenDeltas, 0);
      ok(Math.abs(wrap(last.rot - Math.PI)) < 0.2,
        `cabeza LIBRE llega al input directo (${(last.rot * 57.3).toFixed(0)}° vs 180°)`);
      ok(maxNeck < 0.3,
        `en recta la cabeza alineada con el cuerpo del path (desvío máx ${(maxNeck * 57.3).toFixed(1)}°)`);
      ok(maxNose > 0.2,
        `cuerpo sigue la curva del path con onda (medio-cuerpo máx ${(maxNose * 57.3).toFixed(0)}°)`);
      ok(last.speed < 40,
        `zona muerta frena (speed=${last.speed.toFixed(0)} px/s)`);
      ok(frozenDeltas.length > 5 && maxFrozen < 0.009,
        `SIN RECORRIDO NO HAY MOVIMIENTO: rots congeladas (Δmáx=${(maxFrozen * 57.3).toFixed(3)}° en ${frozenDeltas.length} snaps)`);
      console.log(fails === 0 ? '\n✅ MODELO RASTRO OK' : `\n❌ ${fails} fallos`);
      process.exit(fails === 0 ? 0 : 1);
    }
  }, 50);
}, 300);
