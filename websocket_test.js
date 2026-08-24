const WebSocket = require('ws');

// ==================== CONFIGURACIÓN 2016 ====================
const CONFIG = {
  port: 8080,
  tickRate: 60,
  worldWidth: 6000,
  worldHeight: 6000,
  
 // Física (ajustada para respuesta similar al original)
 friction: 200,        // menos fricción -> movimiento más fluido
 acceleration: 1000,      // más aceleración -> responde mejor al input
 dashPower: 45,        // potencia del dash
 retreatPower: 150,
 maxSpeed: 20,          // velocidad normal máxima
 dashMaxSpeed: 90,      // velocidad máxima durante dash
 
 // Colisiones
 hornDamageMultiplier: 1.5,
 pushForce: 200,        // mayor fuerza de empuje en colisiones
 
 // Crecimiento
 baseSize: 36,
 growthPerKill: 3,
 maxSize: 120,
 
 // Invincibilidad / respawn
 spawnInvincibleTime: 2.5,
 respawnDelay: 3.0,     // ya no se usa para respawn automático (server no auto-respawn)
};

// ==================== OPCODES 2016 ====================
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
function parseString(dataView, offset) {
  const bytes = [];
  while (true) {
    const byte = dataView.getUint8(offset++);
    if (byte === 0) break;
    bytes.push(byte);
  }
  const str = String.fromCharCode.apply(String, bytes);
  return [offset, decodeURIComponent(str)];
}

function stringToBytes(str) {
  const encoded = encodeURIComponent(str);
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    bytes.push(encoded.charCodeAt(i));
  }
  bytes.push(0);
  return bytes;
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

// ==================== JUGADOR 2016 ====================
class Player {
  constructor(id, socket, name = 'Narwhal') {
    this.id = id;
    this.socket = socket;
    this.name = name.substring(0, 25);
    
    this.color = this.randomColor();
    this.size = CONFIG.baseSize;
    this.level = 1;
    this.score = 0;
    this.kills = 0;

    // --- NUEVAS PROPIEDADES PARA MEJORAS ---
    this.upgrades = {
        tuskLevel: 0,
        speedLevel: 0,
        turnRateLevel: 0,
        dashSpeedLevel: 0,
        staminaRegenLevel: 0,
        staminaLevel: 0,
    };

    // --- AJUSTES INICIALES BASADOS EN CONFIG ---
    this.maxSpeed = CONFIG.maxSpeed;
    this.maxDash = 1; // Empezamos con 1 dash
    
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    
    this.parts = [];
    this.breakPoint = 11;
    for (let i = 0; i < 11; i++) {
      this.parts.push({ x: 0, y: 0, vx: 0, vy: 0, rot: 0, vt: 0 });
    }
    
        // antes estaba this.maxDash = 10; this.curDash = 1;
        this.maxDash = 1;      // máximo 5 dashes (visual clásico)
        this.curDash = 0;      // empezar con todos los dashes
        this.overDash = 0;
        this.tuskRatio = .5;
        this.decoration = 0;   // 1 => ojos/decoration normal. 2 => kebab.png
        this.invincibleDur = 0;    
    
    this.isDashing = false;
    this.dashCooldown = 0;
    this.isRetreating = false;
    this.retreatCooldown = 0;
    
    this.isAlive = true;
    this.currentRoom = null;
    this.respawnTimer = 0;
    
    this.inputDirX = 0;
    this.inputDirY = 0;
  }
  
  randomColor() {
    const h = Math.random();
    const s = 0.85 + Math.random() * 0.1;
    const l = 0.6 + Math.random() * 0.1;
    return hslToRgb(h, s, l);
  }
  
  // ==================== NUEVA FUNCIÓN applyUpgrade ====================
// En la clase Player
applyUpgrade(upgradeId) {
  let upgradeName = "Unknown";
  switch (upgradeId) {
      case 0: // Tusk Upgraded!
          this.upgrades.tuskLevel++;
          // El tuskRatio se actualiza en updateTuskAndKebab, pero podemos influir aquí
          break;
      case 1: // Speed Up!
          this.upgrades.speedLevel++;
          this.maxSpeed += 2; // Aumentar velocidad máxima en 2
          break;
      case 2: // Turn Rate Up!
          this.upgrades.turnRateLevel++;
          // Esto afectaría a cómo el `angle` sigue al input, podríamos añadir un multiplicador
          this.turnRateMultiplier = 1 + (this.upgrades.turnRateLevel * 0.05);
          break;
      case 3: // Dash Speed Up!
          this.upgrades.dashSpeedLevel++;
          // Esto se puede añadir al dashPower en el useDash
          break;
      case 4: // Stamina Regen Up!
          this.upgrades.staminaRegenLevel++;
          // Aumenta la velocidad de regeneración de overDash
          break;
      case 5: // Stamina Up!
          this.upgrades.staminaLevel++;
          this.maxDash++; // Aumenta el número máximo de dashes
          break;
  }
  return upgradeName;
}
// ==================== FUNCIÓN spawn CORREGIDA ====================
// En la clase Player
spawn(room) {
  this.isAlive = true;
  const margin = 1000; // Margen desde los bordes para spawnear
  // Genera una posición aleatoria dentro de los límites del mapa
  this.x = margin + Math.random() * (room.width - 2 * margin);
  this.y = margin + Math.random() * (room.height - 2 * margin);
  this.vx = 0;
  this.vy = 0;
  this.invincibleDur = CONFIG.spawnInvincibleTime;
  this.curDash = this.maxDash;
  this.size = CONFIG.baseSize;
  this.level = 1;
  this.alpha = 1.0;
  this.angle = 0; // Siempre mirando a la derecha al spawnear

  // --- LÓGICA DEL KEBAB Y TUSK ---
  // El kebab aparece si el tuskRatio es >= 0.79.
  // En spawn, el tuskRatio es base, así que no debería aparecer.
  // Se actualizará al crecer.
  this.updateTuskAndKebab();

  // --- INICIALIZACIÓN DE PARTES (CORREGIDO) ---
  // Ahora las partes se inicializan en la posición aleatoria (this.x, this.y)
  for (let i = 0; i < this.parts.length; i++) {
      const offsetX = Math.cos(this.angle) * i * 20;
      const offsetY = Math.sin(this.angle) * i * 20;
      // Usa this.x y this.y que ya tienen la posición aleatoria
      this.parts[i].x = this.x - offsetX;
      this.parts[i].y = this.y - offsetY;
      this.parts[i].vx = 0;
      this.parts[i].vy = 0;
      this.parts[i].rot = this.angle;
      this.parts[i].vt = 0;
  }

  // 🔒 Fijar suavizado inicial
this.vx = 0;
this.vy = 0;
}

// ==================== NUEVA FUNCIÓN updateTuskAndKebab ====================
// En la clase Player
// ==================== FUNCIÓN updateTuskAndKebab MEJORADA ====================
// En la clase Player
updateTuskAndKebab() {
  // 1. Calcular el tuskRatio BASE (basado solo en el tamaño)
  // Esto asegura que todos los narvales crezcan un poco con el tamaño.
  const baseTuskRatio = (this.size - CONFIG.baseSize) / (CONFIG.baseSize * 2) + 0.5;

  // 2. Añadir BONO por nivel de mejora de colmillo (Tusk Upgraded!)
  // Cada mejora de colmillo añade una cantidad fija al ratio.
  // Por ejemplo, 0.1 por cada nivel de mejora de colmillo.
  const tuskUpgradeBonus = this.upgrades.tuskLevel * 0.1;

  // 3. Calcular el tuskRatio FINAL
  this.tuskRatio = baseTuskRatio + tuskUpgradeBonus;

  // 4. Asegurarse de que el tuskRatio no sea exageradamente grande
  this.tuskRatio = Math.min(this.tuskRatio, 2.5); // Un máximo razonable

  // El cliente mostrará el kebab si this.tuskRatio >= 0.79
  // Ahora, un jugador puede alcanzar ese umbral antes si tiene suerte con las mejoras de colmillo.
}

update(dt, room) {
  if (!this.isAlive) return;

  // ======== RECARGA SEPARADA PARA ATAQUE / RETREAT ========
  if (this.curDash < this.maxDash) {
  // si usaste dash de ataque → recarga lenta
    if (this.usedAttackDashRecently) {
      this.overDash += dt / 2.0; // ~2.0 segundos por carga
  }
  // si usaste retreat → recarga rápida
  else if (this.usedRetreatRecently) {
      this.overDash += dt / 1.2; // ~1.2 segundos por carga
  }
  // si solo te estás moviendo → recarga normal
  else {
      this.overDash += dt / 2.0;
    }

    if (this.overDash >= 1) {
      this.curDash++;
      this.overDash = 0;
      this.usedAttackDashRecently = false;
      this.usedRetreatRecently = false;
    }
  }

  // ===================== FÍSICAS NARWHALE 2016 REALES =====================
  const dx = this.inputDirX;
  const dy = this.inputDirY;
  const dist = Math.hypot(dx, dy);
  
// ángulo al cursor
  if (dist > 0) {
    const targetAngle = Math.atan2(dy, dx);
    let delta = targetAngle - this.angle;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));

    const TURN_SPEED = 11.5; // ajustado para dt (0.22 * 60)
// ❗ Limitar giro de la cabeza según la cola
const headTurn = delta * TURN_SPEED * dt;

// máximo giro permitido por tick (evita spin y autopenetración)
const MAX_HEAD_TURN = 0.25; // 0.25 rad ≈ 14°
const clampedTurn = Math.max(-MAX_HEAD_TURN, Math.min(MAX_HEAD_TURN, headTurn));

// aplicar giro
this.angle += clampedTurn;
  }

// aceleración basada en distancia al cursor
const ACCEL_FACTOR = 72;     // adaptado a dt (0.0035 * ~90000)
const ACCEL_MAX = 62; // estaba en 0.85
let accel = Math.min(dist * ACCEL_FACTOR, ACCEL_MAX);

  this.vx += Math.cos(this.angle) * accel;
  this.vy += Math.sin(this.angle) * accel;

  // ============ DASH (ATAQUE) ============
  if (this.isDashing) {
    this.vx += Math.cos(this.angle) * 1400 * dt;
    this.vy += Math.sin(this.angle) * 1400 * dt;
    this.isDashing = false;
  }

  // ============ RETREAT (DEFENSA) ============
  if (this.isRetreating) {
    this.vx -= Math.cos(this.angle) * 600 * dt;
    this.vy -= Math.sin(this.angle) * 600 * dt;
    this.isRetreating = false;
  }

  // ============ FRICCIÓN REALISTA ============
this.vx *= 0.90;
this.vy *= 0.90;

  // ============ ACTUALIZAR POSICIÓN ============
  this.x += this.vx * dt;
  this.y += this.vy * dt;

  // 💥 Colisión Narwhale realista 2016 (bug bueno + rebote + vibración)
  const softMargin = 70;   // zona permitida para entrar un poco
  const hardMargin = 25;   // límite absoluto del mapa
  const elasticity = 0.35; // rebote físico (0.45 - 0.65 da efectos lindos)
  const vibrationGain = 1.18; // cómo reacciona al empuje repetido 1.25

// velocidad actual
  const speed = Math.hypot(this.vx, this.vy);

// función para generar rebote + vibración
  function collide(axis, limitNeg, limitPos) {
    if (axis < limitNeg) {
      axis = limitNeg;
      if (speed > 170) {            // golpe fuerte → rebote fuerte
        this.vx *= -elasticity * vibrationGain;
        this.vy *= -elasticity * vibrationGain;
      } else if (speed > 60) {      // golpe moderado → rebote suave
        this.vx *= -elasticity * 0.6;
        this.vy *= -elasticity * 0.6;
      } else {                      // empuje suave → sin rebote grande
        this.vx *= 0.75;
        this.vy *= 0.75;
      }
    }
    else if (axis < limitNeg + softMargin) {
      // área donde puede entrar deformando cuerpo → vibración leve
      this.vx *= 0.93;
      this.vy *= 0.93;
    }

    if (axis > limitPos) {
      axis = limitPos;
      if (speed > 170) {
        this.vx *= -elasticity * vibrationGain;
        this.vy *= -elasticity * vibrationGain;
      } else if (speed > 60) {
        this.vx *= -elasticity * 0.6;
        this.vy *= -elasticity * 0.6;
      } else {
        this.vx *= 0.75;
        this.vy *= 0.75;
      }
    }
    else if (axis > limitPos - softMargin) {
      this.vx *= 0.93;
      this.vy *= 0.93;
    }

    return axis;
  }

  // aplicar a X & Y
  this.x = collide.call(this, this.x, hardMargin, room.width - hardMargin);
  this.y = collide.call(this, this.y, hardMargin, room.height - hardMargin);

  // ======== COLISIÓN DEL TUSK = REBOTE REALISTA ========
  const hornX = this.x + Math.cos(this.angle) * this.size * 0.9;
  const hornY = this.y + Math.sin(this.angle) * this.size * 0.9;

  const minX = 0, maxX = room.width;
  const minY = 0, maxY = room.height;

  let force = 0;

  // si la punta está afuera, aplica fuerza para devolverla
  if (hornX < minX) force = (minX - hornX);
  if (hornX > maxX) force = (hornX - maxX);
  if (hornY < minY) force = Math.max(force, (minY - hornY));
  if (hornY > maxY) force = Math.max(force, (hornY - maxY));

  if (force > 0) {
    // pequeña salida → fricción → se puede “apoyar”
    if (force < 20) {
      this.vx *= 0.88;
      this.vy *= 0.88;
    }
    // salida media → vibración con leve retroceso
    else if (force < 45) {
      this.vx *= -0.40;
      this.vy *= -0.40;
      this.angle += (Math.random() - 0.5) * 0.12; // micro-vibración realista
    }
    // salida grande → rebote fuerte (golpe contra la pared)
    else {
      this.vx *= -1.10;
      this.vy *= -1.10;
      this.angle += (Math.random() - 0.5) * 0.25; // vibración fuerte
    }
  }

  // ============ PARTES DEL CUERPO (SUAVES) ============
  this.updateParts(dt);
}

  // ==================== FUNCIÓN updateParts CORREGIDA ====================
// En la clase Player
updateParts(dt) {
  const head = this.parts[0];

  // Head sincronizada
  head.x = this.x;
  head.y = this.y;
  head.vx = this.vx;
  head.vy = this.vy;
  head.rot = this.angle;

  const segmentLength = 10;
  const followTightness = 0.65; // (0.3–0.45 ideal) cadena suave sin vibración

  for (let i = 1; i < this.parts.length; i++) {
      const part = this.parts[i];
      const prev = this.parts[i - 1];

      const dx = prev.x - part.x;
      const dy = prev.y - part.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 0) {
          // seguir flotando (no rígido)
          const correction = (dist - segmentLength) / dist;
          part.x += dx * correction * followTightness;
          part.y += dy * correction * followTightness;
      }

      // rot suave en vez de fija
      const targetRot = Math.atan2(prev.y - part.y, prev.x - part.x);
      part.rot += (targetRot - part.rot) * 1.5; // suaviza giros

      // velocidades más estables
      part.vx = prev.vx * 0.92;
      part.vy = prev.vy * 0.92;
      }


// 🔒 SANITIZADOR ANTI-GLITCH VISUAL (sin crasheos)
for (let p of this.parts) {

  // evitar NaN / Infinito
  if (!Number.isFinite(p.x)) p.x = this.x;
  if (!Number.isFinite(p.y)) p.y = this.y;
  if (!Number.isFinite(p.vx)) p.vx = 0;
  if (!Number.isFinite(p.vy)) p.vy = 0;
  if (!Number.isFinite(p.rot)) p.rot = this.angle;

  // limitar posición dentro del mapa
  const MAP_WIDTH = 10000;
const MAP_HEIGHT = 10000;
  p.x = Math.max(0, Math.min(p.x, MAP_WIDTH));
  p.y = Math.max(0, Math.min(p.y, MAP_HEIGHT));

  // velocidad máxima segura
  const MAX_VEL = 2000;
  p.vx = Math.max(-MAX_VEL, Math.min(p.vx, MAX_VEL));
  p.vy = Math.max(-MAX_VEL, Math.min(p.vy, MAX_VEL));

}
}



clampToWorld(room) {
  const margin = 50;
  const bounceStrength = 2; // frena rebote múltiple

  if (this.x < margin) {
      this.x = margin;
      this.vx = Math.abs(this.vx) * bounceStrength;
  } else if (this.x > room.width - margin) {
      this.x = room.width - margin;
      this.vx = -Math.abs(this.vx) * bounceStrength;
  }

  if (this.y < margin) {
      this.y = margin;
      this.vy = Math.abs(this.vy) * bounceStrength;
  } else if (this.y > room.height - margin) {
      this.y = room.height - margin;
      this.vy = -Math.abs(this.vy) * bounceStrength;
  }
}


  setInputDirection(dirX, dirY) {
    const magnitude = Math.sqrt(dirX * dirX + dirY * dirY);
    if (magnitude > 1.0) {
      this.inputDirX = dirX / magnitude;
      this.inputDirY = dirY / magnitude;
    } else {
      this.inputDirX = dirX;
      this.inputDirY = dirY;
    }
  }
  
  // ==================== FUNCIÓN useDash MODIFICADA ====================
// En la clase Player
useDash() {
  if (this.curDash > 0) {
    this.curDash--;
    this.isDashing = true;
    this.usedAttackDashRecently = true;
    return true;
  }
  return false;
}

useRetreat() {
  if (this.curDash > 0) {
    this.curDash--;
    this.isRetreating = true;
    this.usedRetreatRecently = true;
    return true;
  }
  return false;
}

  
  // ==================== FUNCIÓN die MODIFICADA ====================
// En la clase Player
die(killer = null) {
  if (!this.isAlive || this.invincibleDur > 0) return;
  this.isAlive = false;
  this.respawnTimer = CONFIG.respawnDelay;

  if (killer && killer !== this) {
      // 1. Calcular y añadir puntuación
      const scoreGain = this.level * 100;
      killer.score += scoreGain;

      // 2. Crecer (aumentar tamaño)
      killer.size = Math.min(CONFIG.maxSize, killer.size + CONFIG.growthPerKill);

      // 3. Comprobar subida de nivel y aplicar mejoras
      const oldLevel = killer.level;
      killer.level = Math.floor((killer.size - CONFIG.baseSize) / 10) + 1; // Fórmula de nivel

      if (killer.level > oldLevel) {
          const upgradesToGive = killer.level - oldLevel; // Por si sube más de un nivel de golpe
          const earnedUpgrades = [];

          for (let i = 0; i < upgradesToGive; i++) {
              // Elegir una mejora aleatoria (puedes hacer esto más inteligente)
              const randomUpgradeId = Math.floor(Math.random() * 6); // IDs del 0 al 5
              const upgradeName = killer.applyUpgrade(randomUpgradeId);
              earnedUpgrades.push(randomUpgradeId);
          }
          
          // 4. Enviar paquete PlayerInfo al cliente
          killer.sendPlayerInfo(earnedUpgrades);
      }

      // 5. Actualizar el estado visual (tuskRatio, etc.)
      killer.updateTuskAndKebab();
  }
  
  const ripBuffer = Buffer.from([OPCODES.RIP]);
  if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(ripBuffer);
  }
}


// ==================== NUEVA FUNCIÓN sendPlayerInfo ====================
// En la clase Player
sendPlayerInfo(upgrades) {
  const buffer = Buffer.alloc(256); // Tamaño suficiente
  let offset = 0;

  // Opcode
  buffer.writeUInt8(OPCODES.PLAYER_INFO, offset++);
  
  // Level
  buffer.writeUInt8(this.level, offset++);
  
  // Número de mejoras
  buffer.writeUInt8(upgrades.length, offset++);

  // Array de mejoras (IDs)
  for (const upgradeId of upgrades) {
      buffer.writeUInt8(upgradeId, offset++);
  }

  const finalPacket = buffer.slice(0, offset);
  if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(finalPacket);
  }
}
}
// ==================== SALA 2016 ====================
class GameRoom {
  constructor(id, name, width, height, desirablePlayerNum) {
    this.id = id;
    this.name = name;
    this.width = width;
    this.height = height;
    this.desirablePlayerNum = desirablePlayerNum;
    this.players = new Map();
  }
  
  addPlayer(player) {
    this.players.set(player.id, player);
    player.currentRoom = this.id;
    player.spawn(this);
  }
  
  removePlayer(playerId) {
    this.players.delete(playerId);
  }
  
  update(dt) {
    for (const player of this.players.values()) {
      player.update(dt, this);
    }
    
    this.checkCollisions();
  }
  
  checkCollisions() {
    const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);
    
    for (let i = 0; i < alivePlayers.length; i++) {
      for (let j = i + 1; j < alivePlayers.length; j++) {
        this.checkPlayerCollision(alivePlayers[i], alivePlayers[j]);
      }
    }
  }
  
  checkPlayerCollision(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const collisionDist = p1.size * 0.6 + p2.size * 0.6;

    if (distance < collisionDist && distance > 0.0001) {
      const overlap = collisionDist - distance;
      const nx = dx / distance;
      const ny = dy / distance;

      // Empujar ambos jugadores fuera de superposición (impulso elástico aproximado)
      const totalMass = (p1.size + p2.size) || 1;
      const p1Ratio = p2.size / totalMass;
      const p2Ratio = p1.size / totalMass;

      // Aplicar corrección de posición (evitar 'atascarse')
      p1.x += nx * overlap * p1Ratio;
      p1.y += ny * overlap * p1Ratio;
      p2.x -= nx * overlap * p2Ratio;
      p2.y -= ny * overlap * p2Ratio;

      // Intercambio de velocidades proyectadas sobre la normal (simple rebote)
      const v1n = p1.vx * nx + p1.vy * ny;
      const v2n = p2.vx * nx + p2.vy * ny;

      // coeficiente de restitución (rebote)
      const restitution = 0.6;

      const newV1n = (v1n * (p1.size - p2.size) + 2 * p2.size * v2n) / (p1.size + p2.size);
      const newV2n = (v2n * (p2.size - p1.size) + 2 * p1.size * v1n) / (p1.size + p2.size);

      // aplicar componente normal actualizado
      p1.vx += (newV1n - v1n) * nx * restitution;
      p1.vy += (newV1n - v1n) * ny * restitution;
      p2.vx += (newV2n - v2n) * nx * restitution;
      p2.vy += (newV2n - v2n) * ny * restitution;

      // ligero empuje adicional (pushForce)
      p1.vx += nx * CONFIG.pushForce * 0.01;
      p1.vy += ny * CONFIG.pushForce * 0.01;
      p2.vx -= nx * CONFIG.pushForce * 0.01;
      p2.vy -= ny * CONFIG.pushForce * 0.01;

      // comprobar choque de colmillo tras el empuje
      this.checkHornCollision(p1, p2);
      this.checkHornCollision(p2, p1);
    }
  }

  // ==================== FUNCIÓN checkHornCollision CORREGIDA ====================
// En la clase GameRoom
checkHornCollision(attacker, victim) {
  if (victim.invincibleDur > 0) return;

  const hornTipX = attacker.x + Math.cos(attacker.angle) * attacker.size * 0.9;
  const hornTipY = attacker.y + Math.sin(attacker.angle) * attacker.size * 0.9;
  const distToVictimCenter = Math.sqrt((hornTipX - victim.x) ** 2 + (hornTipY - victim.y) ** 2);

  // 1. ¿La punta del colmillo está lo suficientemente cerca del cuerpo de la víctima?
  if (distToVictimCenter < victim.size * 0.6) {
      
      // 2. ¿El atacante está mirando hacia la víctima?
      const angleToVictim = Math.atan2(victim.y - attacker.y, victim.x - attacker.x);
      let angleDiff = Math.abs(angleToVictim - attacker.angle);
      // Normalizar la diferencia de ángulo a [0, PI]
      while (angleDiff > Math.PI) angleDiff = Math.abs(angleDiff - Math.PI * 2);

      if (angleDiff < Math.PI / 3) { // Zona de ataque frontal (~60 grados)
          
          // 3. Calcular el poder del empuje
          const sizeDiff = attacker.size - victim.size;
          const dashBonus = attacker.isDashing ? 15 : 0;
          
          // <-- LÍNEA FALTANTE AÑADIDA AQUÍ
          const pushStrength = Math.max(30, (sizeDiff + dashBonus) * CONFIG.pushForce * 0.01);
          
          const pushDirX = Math.cos(attacker.angle);
          const pushDirY = Math.sin(attacker.angle);

          // Aplicar el empuje a la víctima
          victim.vx += pushDirX * pushStrength;
          victim.vy += pushDirY * pushStrength;

          // 4. Comprobar si es suficiente para matar
          // La regla es: diferencia de tamaño + bonus de dash > umbral de muerte
          const killThreshold = 8; // Umbral de muerte
          if (sizeDiff + dashBonus > killThreshold) {
              victim.die(attacker);
          }
      }
  }
}

broadcastGameState() {
    const buffer = Buffer.alloc(16384);
  let offset = 0;

    // Opcode SetElements
  buffer.writeUInt8(OPCODES.SET_ELEMENTS, offset++);
    // Time (double LE)
    buffer.writeDoubleLE(Date.now(), offset); offset += 8;

    // --- NO escribir bytes extras aquí (antes había: 1, 32767, 32767) ---
    // Ahora vienen directamente los elementos

  const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);

  for (const player of alivePlayers) {
      offset = this.encodeFishElement(buffer, offset, player);
      if (offset > 15000) break;
      }

  const finalPacket = buffer.slice(0, offset);
  for (const player of this.players.values()) {
      if (player.socket.readyState === WebSocket.OPEN) {
          player.socket.send(finalPacket);
      }
  }
}

  encodeFishElement(buffer, offset, player) {
    const head = player.parts[0];

    // <-- IMPORTANTE: quitar el byte marcador inicial -->
    // Antes hacías: buffer.writeUInt8(0, offset++);
    // Empezamos directamente con el id (UInt32LE), que es lo que el cliente espera

    // id como UInt32LE (4 bytes)
    buffer.writeUInt32LE(player.id >>> 0, offset); offset += 4;

    // Escribir color en orden R, G, B (cliente reconstruye como (r<<16)|(g<<8)|b)
    buffer.writeUInt8((player.color >> 16) & 0xFF, offset++); // R
    buffer.writeUInt8((player.color >> 8) & 0xFF, offset++);  // G
    buffer.writeUInt8(player.color & 0xFF, offset++);         // B

    // Nombre (null-terminated)
    const nameBytes = stringToBytes(player.name);
    for (let i = 0; i < nameBytes.length; i++) {
      buffer.writeUInt8(nameBytes[i], offset++);
    }

    // breakpoint
    buffer.writeUInt8(player.breakPoint & 0xFF, offset++);

    // alpha
    buffer.writeUInt8(Math.floor(player.alpha * 255), offset++);

    // maxDash/curDash empaquetado
    buffer.writeUInt8((player.maxDash & 0xF) | ((player.curDash & 0xF) << 4), offset++);

    // overDash
    buffer.writeUInt8(Math.floor(Math.min(player.overDash, 1) * 255), offset++);

    // tuskRatio (cliente hace byte/255*2)
    buffer.writeUInt8(Math.floor(Math.max(0, Math.min(player.tuskRatio, 2)) / 2 * 255), offset++);

    // decoration
    buffer.writeUInt8(player.decoration & 0xFF, offset++);

    // head position
    buffer.writeFloatLE(head.x, offset); offset += 4;
    buffer.writeFloatLE(head.y, offset); offset += 4;

    // speed (UInt16)
    const speed = Math.sqrt(head.vx * head.vx + head.vy * head.vy);
    buffer.writeUInt16LE(Math.min(Math.floor(speed), 65535), offset); offset += 2;

    // velocityAngle -> int8 scaled (/Math.PI * 127)
    const velocityAngle = Math.atan2(head.vy, head.vx);
    buffer.writeInt8(Math.round(Math.max(-1, Math.min(1, velocityAngle / Math.PI)) * 127), offset++);

    // head.rot -> int8
    buffer.writeInt8(Math.round(Math.max(-1, Math.min(1, head.rot / Math.PI)) * 127), offset++);

    // 'f' = número de partes remanentes (head ya contado)
    const f = player.parts.length - 1;
    buffer.writeUInt8(f & 0xFF, offset++);

    // Ahora los datos de las partes: r=1..f
    for (let i = 1; i < player.parts.length; i++) {
      const part = player.parts[i];
      if (i === player.breakPoint) {
        // full: x,y,vx,vy (float32 cada uno)
        buffer.writeFloatLE(part.x, offset); offset += 4;
        buffer.writeFloatLE(part.y, offset); offset += 4;
        buffer.writeFloatLE(part.vx, offset); offset += 4;
        buffer.writeFloatLE(part.vy, offset); offset += 4;
      } else {
        // rot as int8 scaled
        buffer.writeInt8(Math.round(Math.max(-1, Math.min(1, part.rot / Math.PI)) * 127), offset++);
      }
    }

    return offset;
  }
  
  
  broadcastLeaderboard() {
    const topPlayers = Array.from(this.players.values())
      .filter(p => p.isAlive)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    
    if (topPlayers.length === 0) return;
    
    const buffer = Buffer.alloc(1024);
    let offset = 0;
    
    buffer.writeUInt8(OPCODES.LEADER_BOARD, offset++);
    buffer.writeUInt8(topPlayers.length, offset++);
    
    for (const player of topPlayers) {
      buffer.writeUInt8(player.level, offset++);
      const nameBytes = stringToBytes(player.name);
      for (let i = 0; i < Math.min(nameBytes.length, 26); i++) {
        buffer.writeUInt8(nameBytes[i], offset++);
      }
    }
    
    buffer.writeUInt8(topPlayers.length, offset++);
    for (const player of topPlayers) {
      buffer.writeUInt8(Math.min(player.level, 255), offset++);
    }
    
    this.broadcastToAll(buffer.slice(0, offset));
  }
  
  broadcastToAll(data) {
    for (const player of this.players.values()) {
      if (player.socket.readyState === WebSocket.OPEN) {
        player.socket.send(data);
      }
    }
  }
}

// ==================== SERVIDOR 2016 ====================
class NarwhaleServer2016 {
  constructor() {
    this.wss = null;
    this.players = new Map();
    this.rooms = new Map();
    this.lastTick = Date.now();
    
    this.initializeRooms();
  }
  
  // ==================== TAMAÑOS DE SALA CORREGIDOS ====================
// En la clase NarwhaleServer2016

initializeRooms() {
  // 6400 es 5 * 1280. 3840 es 3 * 1280. Todo son múltiplos.
  this.rooms.set(0, new GameRoom(0, 'Large 1', 6000, 6000, 25));
  this.rooms.set(1, new GameRoom(1, 'Large 2', 6000, 6000, 25));
  this.rooms.set(2, new GameRoom(2, 'Sparse', 6000, 6000, 15));
  this.rooms.set(3, new GameRoom(3, 'Small 1', 3840, 3840, 9));
  this.rooms.set(4, new GameRoom(4, 'Small 2', 3840, 3840, 9));
  this.rooms.set(5, new GameRoom(5, 'Mega Small', 1200, 1200, 9));
}
  
  start() {
    this.wss = new WebSocket.Server({ port: CONFIG.port, host: '0.0.0.0' });
    
    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });
    
    this.startGameLoop();
    
    console.log(`🌊 Servidor Narwhale.io 2016 iniciado en puerto ${CONFIG.port}`);
    console.log(`🎮 Salas: Large 1, Large 2, Sparse, Small 1, Small 2`);
  }
  
  handleConnection(socket, request) {
    const playerId = Date.now() + Math.floor(Math.random() * 10000);
    socket.playerId = playerId;
    socket.currentRoom = null;
    
    console.log(`➕ Conexión: ${playerId}`);
    
    socket.on('message', (data) => this.handleMessage(socket, data));
    socket.on('close', () => this.handleDisconnection(socket));
    socket.on('error', (err) => console.error(`Error: ${err.message}`));
  }
  
  handleMessage(socket, data) {
    if (!data || data.length === 0) return;
    const opcode = data[0];
    
    switch (opcode) {
      case OPCODES.GET_LOBBIES:
        this.handleGetLobbies(socket);
        break;
      case OPCODES.JOIN:
        this.handleJoin(socket, data);
        break;
      case OPCODES.START:
        this.handleStart(socket, data);
        break;
      case OPCODES.UPDATE_TARGET:
        this.handleUpdateTarget(socket, data);
        break;
      case OPCODES.SPLIT_UP:
        this.handleSplitUp(socket);
        break;
      case OPCODES.RETREAT:
        this.handleRetreat(socket);
        break;
      case OPCODES.PING:
        this.handlePing(socket, data);
        break;
    }
  }
  
  // ==================== cellWidth CORREGIDO ====================
// En la clase NarwhaleServer2016, dentro de handleGetLobbies

handleGetLobbies(socket) {
  const roomsData = Array.from(this.rooms.values()).map(room => ({
      id: room.id,
      name: room.name,
      area: 'Practice',
      playerCount: room.players.size,
      options: {
          width: room.width,
          height: room.height,
          cellWidth: 1200, // <--- CAMBIO CLAVE: 640 en lugar de 1280
          hasIndicator: false,
          isPriority: room.id < 2,
          fieldType: 0,
          desirablePlayerNum: room.desirablePlayerNum,
          hasSlowFactor: false
      }
  }));
  // ... (resto de la función igual) ...
  const jsonData = JSON.stringify(roomsData);
  const response = Buffer.concat([
      Buffer.from([OPCODES.GET_LOBBIES]),
      Buffer.from(jsonData, 'utf8'),
      Buffer.from([0x00])
  ]);
  socket.send(response);
}
    
  
handleJoin(socket, data) {
  const roomId = data.readUInt32LE(1);
  const room = this.rooms.get(roomId);
  if (!room) return;

    // Si estaba en otra sala, sacarlo
    if (socket.currentRoom !== null) {
      const oldRoom = this.rooms.get(socket.currentRoom);
      if (oldRoom && socket.playerId) {
        oldRoom.removePlayer(socket.playerId);
      }
    }
  
    // Guardamos la sala en la que quedó el socket, NO enviamos paquetes inventados
    // El cliente no espera un paquete JOIN de vuelta; si enviamos uno, lo rompe.
    socket.currentRoom = roomId;
  
    // Opcional: si querés que al unirse inmediatamente reciba la lista de elementos/estado
    // podés forzar un spawn / enviar START o esperar a que el cliente emita START.
    // Pero nunca enviar un opcode JOIN desde el servidor hacia el cliente.
  }
  
  handleStart(socket, data) {
    // Extraer nombre (bytes null-terminated empezando en offset 1)
    const nameBytes = [];
    for (let i = 1; i < data.length && data[i] !== 0; i++) {
      nameBytes.push(data[i]);
    }
    // nameBytes son bytes de una cadena encodeURIComponent(...), así que:
    const playerName = decodeURIComponent(String.fromCharCode(...nameBytes));

    // Buscar o crear jugador
    let player = this.players.get(socket.playerId);
    if (!player) {
      player = new Player(socket.playerId, socket, playerName);
      this.players.set(socket.playerId, player);
    } else {
      player.name = playerName;
      player.socket = socket;
    }

    if (socket.currentRoom === null) {
      socket.currentRoom = 0;
    }

    const room = this.rooms.get(socket.currentRoom);
    if (room) {
      room.addPlayer(player);
    }

    // Responder con paquete START: 1 byte opcode + 2 bytes UID (UInt16LE)
    const response = Buffer.alloc(3);
    response.writeUInt8(OPCODES.START, 0);
    response.writeUInt16LE(player.id & 0xFFFF, 1);
    socket.send(response);

    console.log(`🐳 ${playerName} spawneó en ${room ? room.name : '??'}`);
  }

  
  handleUpdateTarget(socket, data) {
    if (data.length >= 9) {
      const dirX = data.readFloatLE(1);
      const dirY = data.readFloatLE(5);
      
      const player = this.players.get(socket.playerId);
      if (player && player.isAlive) {
        player.setInputDirection(dirX, dirY);
      }
    }
  }
  
  handleSplitUp(socket) {
    const player = this.players.get(socket.playerId);
    if (player && player.isAlive) {
      player.useDash();
    }
  }
  
  handleRetreat(socket) {
    const player = this.players.get(socket.playerId);
    if (player && player.isAlive) {
      player.useRetreat();
    }
  }
  
  handlePing(socket, data) {
    if (data.length >= 5) {
      const timestamp = data.readFloatLE(1);
      const response = Buffer.alloc(5);
      response.writeUInt8(OPCODES.PING, 0);
      response.writeFloatLE(timestamp, 1);
      socket.send(response);
    }
  }
  
  handleDisconnection(socket) {
    const player = this.players.get(socket.playerId);
    if (player && player.currentRoom !== null) {
      const room = this.rooms.get(player.currentRoom);
      if (room) {
        room.removePlayer(socket.playerId);
      }
    }
    this.players.delete(socket.playerId);
    console.log(`➖ Desconexión: ${socket.playerId}`);
  }
  
  startGameLoop() {
    const targetFrameTime = 1000 / CONFIG.tickRate;
    let frameCount = 0;
    
    setInterval(() => {
      const now = Date.now();
      const dt = Math.min((now - this.lastTick) / 1000, 0.05);
      this.lastTick = now;
      frameCount++;
  
      for (const room of this.rooms.values()) {
        room.update(dt);
      }
  
      this.sendUpdates();
      
      if (frameCount % (CONFIG.tickRate * 2) === 0) {
        for (const room of this.rooms.values()) {
          if (room.players.size > 0) {
            room.broadcastLeaderboard();
          }
        }
      }
    }, targetFrameTime);
  }
  
  // DENTRO DE LA CLASE NarwhaleGameServer
// REEMPLAZA el método sendUpdates() completo por este:

sendUpdates() {
  // Itera sobre cada sala
  for (const room of this.rooms.values()) {
      // Solo procesa y envía actualizaciones si la sala tiene jugadores
      if (room.players.size > 0) {
          // Llama al método de la sala para que construya y envíe el paquete
          // Este método ya se encarga de enviarlo solo a los jugadores de 'room'
          room.broadcastGameState();
      }
  }
}
}

// ==================== INICIAR ====================
const server = new NarwhaleServer2016();
server.start();

console.log(`
================================================================
   SERVIDOR NARWHALE.IO 2016 - VERSIÓN CLÁSICA MINIMALISTA
================================================================
Puerto: ${CONFIG.port}
Tick Rate: ${CONFIG.tickRate} FPS

Física implementada:
  ✓ Movimiento básico
  ✓ Colisiones con cuerno
  ✓ Dash (ataque)
  ✓ Retreat (retroceso)
  ✓ Sistema de crecimiento
  ✓ Invincibilidad al spawn

Salas disponibles (2016):
  - Large 1 (6400x6400, 25 jugadores)
  - Large 2 (6400x6400, 25 jugadores)
  - Sparse (6400x6400, 15 jugadores)
  - Small 1 (3840x3840, 9 jugadores)
  - Small 2 (3840x3840, 9 jugadores)
================================================================
`);
