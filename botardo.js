const WebSocket = require("ws");

const SERVER_URL = "ws://localhost:443";
const NUM_BOTS = 10;

const OPCODES = {
    JOIN: 16,
    START: 18,
    UPDATE_TARGET: 32,
    SPLIT_UP: 33,
    RIP: 34,
    RETREAT: 35
};

const ROOM_ID = 0;

// Convierte string ASCII puro → Buffer sin UTF8 ni Unicode
function toByteString(str) {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
    return Buffer.from(arr);
}

function createBot(id) {
    const ws = new WebSocket(SERVER_URL);

    ws.binaryType = "arraybuffer";

    ws.on("open", () => {
        console.log(`🤖 Bot ${id} conectado`);

        // ======== JOIN PACKET ========
        const join = Buffer.alloc(5);
        join.writeUInt8(OPCODES.JOIN, 0);
        join.writeUInt32LE(ROOM_ID, 1);
        ws.send(join);

        // ======== START PACKET ========
        const name = "Bot" + id;
        const nameBytes = toByteString(name);

        const start = Buffer.alloc(1 + nameBytes.length + 1);
        start[0] = OPCODES.START;
        nameBytes.copy(start, 1);
        start[start.length - 1] = 0; // null terminator

        ws.send(start);

        startMovement(ws, id);
    });

    ws.on("message", (data) => {
        const opcode = data[0];

        // RIP → respawn inmediato
        if (opcode === OPCODES.RIP) {
            console.log(`💀 Bot ${id} murió, respawn...`);

            setTimeout(() => {
                const name = "Bot" + id;
                const nameBytes = toByteString(name);

                const start = Buffer.alloc(1 + nameBytes.length + 1);
                start[0] = OPCODES.START;
                nameBytes.copy(start, 1);
                start[start.length - 1] = 0;

                ws.send(start);
            }, 300);
        }
    });

    ws.on("close", () => console.log(`🔴 Bot ${id} desconectado`));
    ws.on("error", () => console.log(`⚠️ Error bot ${id}`));
}

function startMovement(ws, id) {
    setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;

        // dirección random normalizada
        let dx = Math.random() * 2 - 1;
        let dy = Math.random() * 2 - 1;
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;

        // ===== UPDATE_TARGET =====
        const buf = Buffer.alloc(1 + 4 + 4);
        buf.writeUInt8(OPCODES.UPDATE_TARGET, 0);
        buf.writeFloatLE(dx, 1);
        buf.writeFloatLE(dy, 5);
        ws.send(buf);

        // Dash aleatorio
        if (Math.random() < 0.02) {
            ws.send(Buffer.from([OPCODES.SPLIT_UP]));
        }

        // Retreat aleatorio
        if (Math.random() < 0.02) {
            ws.send(Buffer.from([OPCODES.RETREAT]));
        }

    }, 50);
}

// Crear bots
for (let i = 1; i <= NUM_BOTS; i++) {
    createBot(i);
}

console.log(`🐳 Lanzando ${NUM_BOTS} bots hacia ${SERVER_URL}`);
