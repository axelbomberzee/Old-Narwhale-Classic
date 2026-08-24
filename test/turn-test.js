'use strict';
/*
 * Test de orientación: el hocico debe mirar al input.
 *  1) nada hacia 0 rad, luego gira el input a +PI/2 y a PI
 *  2) verifica: head.rot sigue al input y parts[1].rot ~= head.rot (nariz alineada)
 *  3) zona muerta: input casi nulo -> el narval frena
 */
const WebSocket = require('ws');
const URL = process.env.VERIFY_URL || 'ws://localhost:8080';
const OP = { JOIN: 16, START: 18, UPDATE_TARGET: 32, SET_ELEMENTS: 48 };

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ FALLO: ') + m); if (!c) fails++; };

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';
let uid = null, last = null, noseSamples = [], speedSamples = [];

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
  if (dv.getUint8(0) === OP.START) { uid = dv.getUint16(1, true); run(); }
  if (dv.getUint8(0) !== OP.SET_ELEMENTS) return;
  let e = 9;
  while (e < dv.byteLength) {
    const id = dv.getUint16(e, true); e += 4 + 3;
    while (dv.getUint8(e) !== 0) e++; e++;
    const bp = dv.getUint8(e); e += 6;
    const x = dv.getFloat32(e, true), y = dv.getFloat32(e + 4, true);
    const speed = dv.getUint16(e + 8, true);
    const velAng = dv.getInt8(e + 10) / 127 * Math.PI;
    const rot = dv.getInt8(e + 11) / 127 * Math.PI;
    e += 12;
    const f = dv.getUint8(e++);
    let p1rot = null;
    for (let i = 1; i <= f; i++) {
      if (i === bp) e += 16;
      else { if (i === 1) p1rot = dv.getInt8(e) / 127 * Math.PI; e += 1; }
    }
    if (id === uid) {
      last = { rot, p1rot, x, y, speed };
      if (p1rot !== null) noseSamples.push(Math.abs(wrap(p1rot - rot)));
    }
  }
});

function run() {
  const t0 = Date.now();
  const phase = (ms, fn) => setInterval(() => { if (Date.now() - t0 > ms) { clearInterval(phase); fn && fn(); } else fn && fn(); }, 50);
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    if (t < 1.2) sendInput(1, 0);                       // hacia 0 rad
    else if (t < 2.6) sendInput(0, 1);                  // gira a +PI/2
    else if (t < 4.0) sendInput(-1, 0.001);             // gira a PI
    else if (t < 6.0) sendInput(0.04, 0.01);            // zona muerta (mag~0.04)
    else {
      clearInterval(timer);
      // mediciones de la fase de giro (t 1.2..4.0): recortar samples previos
      const turnSamples = noseSamples.slice(-60);
      const maxNose = Math.max(...turnSamples);
      ok(Math.abs(wrap(last.rot - Math.PI)) < 0.3,
        `cabeza mirando al input y CONGELADA en zona muerta (rot=${last.rot.toFixed(2)} vs PI=3.14)`);
      ok(maxNose < 0.12,
        `nariz alineada con la cabeza durante giros (desvío máx ${maxNose.toFixed(3)} rad = ${(maxNose * 57.3).toFixed(1)}°)`);
      ok(last.speed < 40,
        `zona muerta frena (speed=${last.speed.toFixed(0)} px/s tras 2s con cursor casi al centro)`);
      console.log(fails === 0 ? '\n✅ ORIENTACIÓN OK' : `\n❌ ${fails} fallos`);
      process.exit(fails === 0 ? 0 : 1);
    }
  }, 50);
}
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
