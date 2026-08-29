const WebSocket = require('ws');
const osc = require('osc');

// ============================================================
// A THOUSAND CLOCKS — QUEST TO INVISO BRIDGE
//
// Meta Quest / WebXR
//     ↓ WebSocket JSON
// quest_bridge.js :8082
//     ↓ OSC UDP
// Inviso OSC relay :9000
//     ↓ WebSocket :8081
// Inviso browser
//
// Supported WebSocket message types:
//
// 1. pose
//    → /inviso/listener/position
//    → /inviso/listener/orientation
//
// 2. objectCommand
//    → /inviso/object/<name>/play
//    → /inviso/object/<name>/pause
//    → /inviso/object/<name>/reset
//    → /inviso/object/<name>/loop
//
// 3. transportCommand
//    → /inviso/transport/play
//    → /inviso/transport/pause
//    → /inviso/transport/reset
//
// 4. controller  (see CONTROLLER NOTE below — stock Inviso ignores these)
//    → /inviso/controller/<hand>/trigger
//
// NOTE ON HTTPS: this server speaks plain ws://. A page served over HTTPS
// cannot open a ws:// connection — the browser blocks it as mixed content.
// From the Quest, connect through the reverse proxy (Caddy) that terminates
// TLS and forwards wss:// to this port. See quest-bridge/README.md.
// ============================================================

// ------------------------------------------------------------
// CONFIG
//
// Every value can be overridden with an environment variable, so the studio
// machine does not need a code edit if a port is already taken:
//
//   QUEST_WS_PORT=8082 INVISO_OSC_PORT=9000 npm start
// ------------------------------------------------------------

const QUEST_WS_PORT = Number(process.env.QUEST_WS_PORT || 8082);

const INVISO_OSC_HOST = process.env.INVISO_OSC_HOST || '127.0.0.1';
const INVISO_OSC_PORT = Number(process.env.INVISO_OSC_PORT || 9000);

// ------------------------------------------------------------
// COORDINATE CONVERSION
//
// Inviso's OSC manager applies this to whatever it receives:
//
//     head.position.set(x * 5000, clamp(y * 300, ±300), z * 5000)
//
// So incoming values are NORMALIZED, not metres, and the horizontal and
// vertical axes do not share a divisor. Inviso clamps only y — x and z will
// happily place the head thousands of units off the visible grid.
//
// POSE_INPUT_UNITS declares what the WebXR app is sending:
//
//   'normalized'  the app already did the conversion and sends -1..1.
//   'metres'      the app sends Three.js world metres and this bridge
//                 converts, using the two extents below.
//
// Default is 'normalized' so existing behaviour is unchanged. If the clamp
// warnings below start firing, that is the signal the app is sending metres.
//
// The extents answer "how much of my virtual world should span Inviso's full
// range". They must match how the sound objects were laid out in the Inviso
// scene — a listener that moves twice as far as it should will hear the field
// as half its intended size. Pick these deliberately, don't leave them.
// ------------------------------------------------------------

const POSE_INPUT_UNITS = (process.env.POSE_INPUT_UNITS || 'normalized').toLowerCase();

// ±this many metres in the WebXR world maps to ±1 on Inviso's x and z.
const WORLD_HALF_EXTENT_METRES = Number(process.env.WORLD_HALF_EXTENT_METRES || 25);

// ±this many metres maps to ±1 on Inviso's y. Separate because Inviso's
// altitude range is ±300 units against ±5000 on the floor plane.
const WORLD_HALF_HEIGHT_METRES = Number(process.env.WORLD_HALF_HEIGHT_METRES || 10);

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

let udpReady = false;
let poseCount = 0;
let clampCount = 0;
let clampWarned = false;

const clients = new Set();

// ------------------------------------------------------------
// OSC OUTPUT
// ------------------------------------------------------------

const udp = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: 0,
    remoteAddress: INVISO_OSC_HOST,
    remotePort: INVISO_OSC_PORT,
    metadata: false,
});

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function sendOsc(address, args = []) {
    // The WebSocket server starts accepting connections the moment it is
    // constructed, but udp.open() is asynchronous. Without this guard the
    // first few messages after startup are dropped inside node-osc with no
    // error — which looks exactly like a wrong port.
    if (!udpReady) {
        console.warn(`[OSC] Dropped ${address} — UDP socket not open yet.`);
        return;
    }

    try {
        udp.send({ address, args });
    } catch (error) {
        console.error(`[OSC] Send failed for ${address}:`, error.message);
    }
}

function sendObjectCommand(name, command, value) {
    if (!name) {
        console.warn('[Object Command] Missing object name.');
        return;
    }

    const validCommands = new Set(['play', 'pause', 'reset', 'loop']);

    if (!validCommands.has(command)) {
        console.warn(`[Object Command] Unsupported command: ${command}`);
        return;
    }

    // Inviso matches /inviso/object/([^/]+)/... so a slash in the name would
    // silently split the address and match nothing.
    if (name.includes('/')) {
        console.warn(`[Object Command] Name contains a slash, cannot address: ${name}`);
        return;
    }

    const address = `/inviso/object/${name}/${command}`;

    let args = [];

    if (command === 'loop') {
        const loopValue = value === true || value === 1 || value === '1' ? 1 : 0;

        args = [loopValue];
    }

    sendOsc(address, args);

    console.log('[Object Command]', address, args.length ? args[0] : '');
}

function sendTransportCommand(command) {
    const validCommands = new Set(['play', 'pause', 'reset']);

    if (!validCommands.has(command)) {
        console.warn(`[Transport Command] Unsupported command: ${command}`);
        return;
    }

    const address = `/inviso/transport/${command}`;

    sendOsc(address);

    console.log('[Transport Command]', address);
}

// ------------------------------------------------------------
// POSE CONVERSION
//
// Returns normalized -1..1 values plus whether anything had to be clamped.
// The clamp stays as a safety net, but it now reports itself: silently
// pinning the listener at the edge of the grid is the single worst failure
// mode here, because every status light stays green while it happens.
// ------------------------------------------------------------

function normalizePose(x, y, z) {
    let nx = x;
    let ny = y;
    let nz = z;

    if (POSE_INPUT_UNITS === 'metres' || POSE_INPUT_UNITS === 'meters') {
        nx = x / WORLD_HALF_EXTENT_METRES;
        ny = y / WORLD_HALF_HEIGHT_METRES;
        nz = z / WORLD_HALF_EXTENT_METRES;
    }

    const cx = clamp(nx, -1, 1);
    const cy = clamp(ny, -1, 1);
    const cz = clamp(nz, -1, 1);

    const clamped = cx !== nx || cy !== ny || cz !== nz;

    return { x: cx, y: cy, z: cz, clamped, raw: { x: nx, y: ny, z: nz } };
}

function reportClamp(pose, original) {
    clampCount++;

    if (clampWarned) {
        // Already explained once. Keep a periodic reminder so a run that is
        // clamping constantly is visible without flooding the terminal.
        if (clampCount % 200 === 0) {
            console.warn(`[Pose] Still clamping — ${clampCount} poses so far.`);
        }

        return;
    }

    clampWarned = true;

    console.warn('');
    console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.warn('[Pose] A position was clamped to the -1..1 range.');
    console.warn('');
    console.warn(`  received : x=${original.x} y=${original.y} z=${original.z}`);
    console.warn(`  after    : x=${pose.x.toFixed(3)} y=${pose.y.toFixed(3)} z=${pose.z.toFixed(3)}`);
    console.warn(`  units    : POSE_INPUT_UNITS=${POSE_INPUT_UNITS}`);
    console.warn('');
    console.warn('  Inviso expects normalized -1..1, not metres. Clamped values');
    console.warn('  pin the listener at the edge of the grid and stay there, so');
    console.warn('  the audio stops responding to head movement while every');
    console.warn('  status indicator remains green.');

    const magnitude = Math.max(
        Math.abs(original.x),
        Math.abs(original.y),
        Math.abs(original.z),
    );

    if (POSE_INPUT_UNITS !== 'metres' && magnitude > 1 && magnitude < 500) {
        console.warn('');
        console.warn('  These values look like Three.js world metres. Either convert');
        console.warn('  in InvisoClient.js before sending, or restart this bridge with:');
        console.warn('');
        console.warn('      POSE_INPUT_UNITS=metres npm start');
    }

    console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.warn('');
}

// ------------------------------------------------------------
// WEBSOCKET SERVER
// ------------------------------------------------------------

const wss = new WebSocket.Server({ port: QUEST_WS_PORT });

wss.on('listening', () => {
    console.log('');
    console.log('========================================');
    console.log(' A Thousand Clocks Quest Bridge READY');
    console.log('========================================');
    console.log(`Quest WebSocket: ws://localhost:${QUEST_WS_PORT}`);
    console.log(`Inviso OSC     : ${INVISO_OSC_HOST}:${INVISO_OSC_PORT}`);
    console.log(`Pose units     : ${POSE_INPUT_UNITS}`);

    if (POSE_INPUT_UNITS === 'metres' || POSE_INPUT_UNITS === 'meters') {
        console.log(
            `World extents  : ±${WORLD_HALF_EXTENT_METRES} m horizontal, ` +
            `±${WORLD_HALF_HEIGHT_METRES} m vertical`,
        );
    }

    console.log('');
    console.log('Note: /inviso/controller/... is not handled by stock Inviso.');
    console.log('Those messages are forwarded but currently do nothing.');
    console.log('');
});

// A port collision otherwise crashes with a bare stack trace that says
// EADDRINUSE and nothing about which process to stop.
wss.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error('');
        console.error(`[Quest Bridge] Port ${QUEST_WS_PORT} is already in use.`);
        console.error('  Another copy of this bridge is probably still running.');
        console.error(`  Find it with:  lsof -i :${QUEST_WS_PORT}`);
        console.error(`  Or use a different port:  QUEST_WS_PORT=8083 npm start`);
        console.error('');
        process.exit(1);
    }

    console.error('[Quest Bridge] Server error:', error.message);
});

// ------------------------------------------------------------
// QUEST / WEBXR CONNECTION
// ------------------------------------------------------------

wss.on('connection', (socket, request) => {
    const clientAddress = request.socket.remoteAddress || 'unknown';

    clients.add(socket);
    socket.isAlive = true;

    console.log(`[Quest Bridge] WebSocket connected: ${clientAddress} (${clients.size} client(s))`);

    // Two senders both driving the listener head is not an error the OSC layer
    // can detect — the head just jitters between two positions. Usually this
    // is a stale connection from a previous headset session that never closed.
    if (clients.size > 1) {
        console.warn('');
        console.warn(`[Quest Bridge] ${clients.size} clients are connected at once.`);
        console.warn('  They will fight over the listener head position.');
        console.warn('  This is usually a stale connection from an earlier session.');
        console.warn('');
    }

    socket.send(JSON.stringify({ type: 'bridgeStatus', connected: true }));

    socket.on('pong', () => {
        socket.isAlive = true;
    });

    socket.on('message', (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch (error) {
            console.warn('[Quest Bridge] Ignoring invalid JSON.');
            return;
        }

        if (!data || typeof data.type !== 'string') return;

        // ====================================================
        // INDIVIDUAL SOUND OBJECT COMMANDS
        // ====================================================

        if (data.type === 'objectCommand') {
            const name = String(data.name || '').trim();
            const command = String(data.command || '').trim().toLowerCase();

            sendObjectCommand(name, command, data.value);
            return;
        }

        // ====================================================
        // GLOBAL TRANSPORT COMMANDS
        // ====================================================

        if (data.type === 'transportCommand') {
            const command = String(data.command || '').trim().toLowerCase();

            sendTransportCommand(command);
            return;
        }

        // ====================================================
        // QUEST CONTROLLER
        //
        // CONTROLLER NOTE: Inviso's osc.js matches only /inviso/listener/...,
        // /inviso/object/... and /inviso/transport/... — there is no controller
        // namespace. These messages reach Inviso and are discarded. Kept as a
        // round-trip test signal; do not build behaviour on them without
        // adding a handler to Inviso first.
        // ====================================================

        if (data.type === 'controller') {
            const hand = String(data.hand || '').trim().toLowerCase();
            const control = String(data.control || '').trim().toLowerCase();
            const value = Number(data.value);

            if (
                !['left', 'right'].includes(hand) ||
                control !== 'trigger' ||
                !Number.isFinite(value)
            ) {
                console.warn('[Quest Bridge] Invalid controller payload:', data);
                return;
            }

            const safeValue = value >= 0.5 ? 1 : 0;

            sendOsc(`/inviso/controller/${hand}/trigger`, [safeValue]);

            console.log(`[Quest Controller] ${hand} trigger=${safeValue}`);
            return;
        }

        // ====================================================
        // LISTENER POSE
        // ====================================================

        if (data.type !== 'pose') {
            console.warn(`[Quest Bridge] Unknown message type: ${data.type}`);
            return;
        }

        const x = Number(data.x);
        const y = Number(data.y);
        const z = Number(data.z);

        const yaw = Number(data.yaw);
        const pitch = Number(data.pitch ?? 0);
        const roll = Number(data.roll ?? 0);

        if (![x, y, z, yaw, pitch, roll].every(Number.isFinite)) {
            console.warn('[Quest Bridge] Invalid pose payload:', data);
            return;
        }

        const pose = normalizePose(x, y, z);

        if (pose.clamped) {
            reportClamp(pose, { x, y, z });
        }

        sendOsc('/inviso/listener/position', [pose.x, pose.y, pose.z]);

        // Inviso applies yaw only; pitch and roll are accepted and discarded.
        sendOsc('/inviso/listener/orientation', [yaw, pitch, roll]);

        poseCount++;

        // Avoid flooding the terminal with every XR frame.
        if (poseCount % 30 === 0) {
            console.log(
                '[Quest Pose]',
                `x=${pose.x.toFixed(3)}`,
                `y=${pose.y.toFixed(3)}`,
                `z=${pose.z.toFixed(3)}`,
                `yaw=${yaw.toFixed(3)}`,
            );
        }
    });

    socket.on('close', () => {
        clients.delete(socket);
        console.log(`[Quest Bridge] WebSocket disconnected. (${clients.size} remaining)`);
    });

    socket.on('error', (error) => {
        console.error('[Quest Bridge] WebSocket error:', error.message);
    });
});

// ------------------------------------------------------------
// HEARTBEAT
//
// A headset that goes to sleep, drops off wifi, or is yanked out of range
// does not send a close frame. Without this the socket sits in the client
// set forever, and the next session's connection trips the "2 clients"
// warning for no reason. Ping every 10s, drop anything that misses one.
// ------------------------------------------------------------

const heartbeat = setInterval(() => {
    wss.clients.forEach((socket) => {
        if (socket.isAlive === false) {
            console.warn('[Quest Bridge] Client stopped responding — terminating.');
            clients.delete(socket);
            return socket.terminate();
        }

        socket.isAlive = false;
        socket.ping();
    });
}, 10000);

// ------------------------------------------------------------
// OSC STATUS
// ------------------------------------------------------------

udp.on('ready', () => {
    udpReady = true;
    console.log(`[Quest Bridge] OSC output ready -> ${INVISO_OSC_HOST}:${INVISO_OSC_PORT}`);
});

udp.on('error', (error) => {
    console.error('[Quest Bridge] OSC error:', error.message);
});

udp.open();

// ------------------------------------------------------------
// CLEAN SHUTDOWN
// ------------------------------------------------------------

function shutdown() {
    console.log('\n[Quest Bridge] Shutting down...');

    clearInterval(heartbeat);

    try { udp.close(); } catch (_) {}
    try { wss.close(); } catch (_) {}

    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
