# Old Narwhale Classic (2016) — Restauración

Restauración de **Narwhale.io** (agosto 2016): cliente original + servidor de juego reconstruido.

## Cómo jugar

```bash
npm install
npm start        # servidor de juego (HTTP + WebSocket en http://localhost:8080)
npm run bots     # (opcional) 10 bots en otra terminal
```

Abrí **http://localhost:8080**, elegí sala y a nadar. Clic/teclado: dash; clic derecho: retreat.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html`, `app.js`, `pixi.js`, `main.css` | Cliente original (intacto, solo SERVER_LIST dinámico) |
| `websocket_test.js` | **Servidor de juego reconstruido** (ver abajo) |
| `botardo.js` | Bot de prueba (10 bots) |
| `server.js` | Servidor estático viejo (obsoleto, queda por historia) |
| `test/verify.js` | Harness que valida el protocolo contra el parser del cliente |

## El servidor (websocket_test.js)

El protocolo y la física están extraídos del cliente minificado (`app.js`), así el
servidor es 100% autoritativo pero **respeta la interpolación visual del cliente**:

- `SetElements.time` en **segundos** (el cliente mide throttling contra `performance.now()/1000`;
  mandar ms degradaba el suavizado al mínimo → narval "de goma").
- Cadena simulada con el **mismo integrador** que el cliente usa para extrapolar:
  espaciado 36px (hardcodeado en el cliente), damping `0.15 + 0.35·(N-i)/N`,
  ángulo máximo `2π/3·(i-1)/10`, `vt` por segmento.
- Cabeza a velocidad ~constante entre snapshots → la extrapolación lineal del
  cliente (speed + velAngle) da error ~2px.
- Snapshots a 15 Hz estables, simulación a 60 Hz con dt fijo.
- Corte por colmillo real: `breakPoint` + `splice` sincronizado con el cliente
  (la cola cortada vuela con la inercia del golpe); colmillo en la cabeza = muerte.
- UID de 16 bits consistente entre `START` y `SetElements` (el cliente lee U16 y
  avanza 4 bytes).
- `LeaderBoard`, `PlayerInfo` (mejoras automáticas), `Ping` echo, `LEAVE` manejado.

## Verificación

```bash
npm start &     # en una terminal
npm run bots &  # bots para que haya movimiento
npm verify      # valida protocolo + error de extrapolación (cabeza <30px, cola <12°)
```
