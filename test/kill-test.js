'use strict';
/*
 * Test de combate: dos clientes guiados que se cazan mutuamente hasta
 * provocar cortes/kills/subidas de nivel. Ejercita el camino que hacía
 * crashear el servidor (sendPlayerInfo tras un kill).
 */
const WebSocket = require('ws');
const URL = process.env.VERIFY_URL || 'ws://localhost:8080';
const OP = { JOIN: 16, START: 18, UPDATE_TARGET: 32, SPLIT_UP: 33, RETREAT: 35, RIP: 34, SET_ELEMENTS: 48, PLAYER_INFO: 49 };

class Hunter {
  constructor(name) {
    this.name = name;
    this.uid = null;
    this.others = {};   // uid -> {x, y, breakPoint}
    this.myParts = null;
    this.events = [];
    this.ws = new WebSocket(URL);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('open', () => {
      const j = Buffer.alloc(5); j.writeUInt8(OP.JOIN, 0); j.writeUInt32LE(0, 1); this.ws.send(j);
      const n = Buffer.from(Buffer.from(this.name)); 
      const s = Buffer.alloc(2 + n.length); s.writeUInt8(OP.START, 0); n.copy(s, 1); s[s.length-1] = 0;
      this.ws.send(s);
    });
    this.ws.on('message', (d) => this.onMsg(new DataView(d.buffer || d)));
    this.think = setInterval(() => this.tick(), 60);
  }
  onMsg(dv) {
    const op = dv.getUint8(0);
    if (op === OP.START) this.uid = dv.getUint16(1, true);
    else if (op === OP.RIP) { this.events.push('RIP'); console.log(`  💀 ${this.name} murió`); }
    else if (op === OP.PLAYER_INFO) {
      const lvl = dv.getUint8(1), n = dv.getUint8(2);
      const ups = []; for (let i = 0; i < n; i++) ups.push(dv.getUint8(3 + i));
      this.events.push(`LEVEL ${lvl} ups=[${ups}]`);
      console.log(`  ⬆️  ${this.name} subió a nivel ${lvl} (mejoras: ${ups})`);
    }
    else if (op === OP.SET_ELEMENTS) {
      let e = 9;
      this.others = {};
      while (e < dv.byteLength) {
        const id = dv.getUint16(e, true); e += 4; e += 3;
        while (dv.getUint8(e) !== 0) e++;
        e++; // nombre
        const bp = dv.getUint8(e); e += 8; // breakpoint + alpha + dash + over + tusk + deco... (bp+5=6 bytes)
        e -= 8; e += 6;
        const x = dv.getFloat32(e, true), y = dv.getFloat32(e + 4, true);
        e += 4 + 4 + 2 + 1 + 1; // x,y,speed,velAng,rot
        const f = dv.getUint8(e++);
        let cutSeen = (bp < f + 1);
        for (let i = 1; i <= f; i++) {
          if (i === bp) e += 16; else e += 1;
        }
        if (id === this.uid) { if (bp < 11) { this.events.push(`CUT bp=${bp}`); console.log(`  ✂️  ${this.name} fue cortado (breakPoint=${bp}, partes=${f+1})`); } }
        else this.others[id] = { x, y };
      }
    }
  }
  tick() {
    if (this.ws.readyState !== WebSocket.OPEN || this.uid === null) return;
    // apuntar al rival más cercano
    let best = null, bd = 1e9;
    for (const id in this.others) {
      const o = this.others[id];
      const d = Math.hypot(o.x - (this.lastX || 0), o.y - (this.lastY || 0));
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return;
    // mi posición: uso la del último snapshot (aprox: guardar en onMsg sería mejor)
    const buf = Buffer.alloc(9);
    buf.writeUInt8(OP.UPDATE_TARGET, 0);
    buf.writeFloatLE(Math.cos(Date.now() / 900), 1);   // señal: la clase Guided abajo pisa esto
    buf.writeFloatLE(Math.sin(Date.now() / 900), 5);
    this.ws.send(buf);
    if (bd < 600 && Math.random() < 0.5) this.ws.send(Buffer.from([OP.SPLIT_UP]));
  }
}

// Versión guiada de verdad: rastrea rivales usando SU PROPIA cabeza del snapshot
class Guided extends Hunter {
  onMsg(dv) {
    const op = dv.getUint8(0);
    if (op === OP.SET_ELEMENTS) {
      let e = 9;
      this.others = {};
      let myHead = null;
      while (e < dv.byteLength) {
        const id = dv.getUint16(e, true); e += 4; e += 3;
        while (dv.getUint8(e) !== 0) e++; e++;
        const bp = dv.getUint8(e); e += 6;
        const x = dv.getFloat32(e, true), y = dv.getFloat32(e + 4, true);
        e += 12; // x,y,speed,velAng,rot
        const f = dv.getUint8(e++);
        for (let i = 1; i <= f; i++) e += (i === bp) ? 16 : 1;
        if (id === this.uid) {
          myHead = { x, y };
          if (bp < 11) { this.events.push(`CUT bp=${bp}`); console.log(`  ✂️  ${this.name} cortado (bp=${bp})`); }
        } else this.others[id] = { x, y };
      }
      if (myHead) { this.myHead = myHead; }
    } else super.onMsg(dv);
  }
  tick() {
    if (this.ws.readyState !== WebSocket.OPEN || !this.myHead) return;
    let best = null, bd = 1e9;
    for (const id in this.others) {
      const o = this.others[id];
      const d = Math.hypot(o.x - this.myHead.x, o.y - this.myHead.y);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return;
    const dx = best.x - this.myHead.x, dy = best.y - this.myHead.y;
    const m = Math.hypot(dx, dy) || 1;
    const buf = Buffer.alloc(9);
    buf.writeUInt8(OP.UPDATE_TARGET, 0);
    buf.writeFloatLE(dx / m, 1);
    buf.writeFloatLE(dy / m, 5);
    this.ws.send(buf);
    if (bd < 700 && Math.random() < 0.4) this.ws.send(Buffer.from([OP.SPLIT_UP]));
    if (bd < 200 && Math.random() < 0.2) this.ws.send(Buffer.from([OP.RETREAT]));
  }
}

const a = new Guided('CazadorA');
const b = new Guided('CazadorB');
const c = new Guided('CazadorC');

setTimeout(() => {
  const evs = [a, b, c].flatMap(h => h.events);
  const cuts = evs.filter(e => e.startsWith('CUT')).length;
  const rips = evs.filter(e => e === 'RIP').length;
  const levels = evs.filter(e => e.startsWith('LEVEL')).length;
  console.log(`\n=== RESULTADO: cortes=${cuts} rips=${rips} subidasNivel=${levels} ===`);
  const okAll = (cuts + rips) > 0 && levels >= 0;
  process.exit(okAll ? 0 : 1);
}, 45000);
