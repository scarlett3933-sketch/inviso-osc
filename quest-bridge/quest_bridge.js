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
// ============================================================

const QUEST_WS_PORT = 8082;

const INVISO_OSC_HOST = '127.0.0.1';
const INVISO_OSC_PORT = 9000;

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
// WEBSOCKET SERVER
// ------------------------------------------------------------

const wss = new WebSocket.Server({
    port: QUEST_WS_PORT,
});

let poseCount = 0;

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function sendOsc(address, args = []) {
    udp.send({
        address,
        args,
    });
}

function sendObjectCommand(name, command, value) {
    if (!name) {
        console.warn(
            '[Object Command] Missing object name.',
        );
        return;
    }

    const validCommands = new Set([
        'play',
        'pause',
        'reset',
        'loop',
    ]);

    if (!validCommands.has(command)) {
        console.warn(
            `[Object Command] Unsupported command: ${command}`,
        );
        return;
    }

    const address =
        `/inviso/object/${name}/${command}`;

    let args = [];

    if (command === 'loop') {
        const loopValue =
            value === true ||
            value === 1 ||
            value === '1'
                ? 1
                : 0;

        args = [loopValue];
    }

    sendOsc(address, args);

    console.log(
        '[Object Command]',
        address,
        args.length ? args[0] : '',
    );
}

function sendTransportCommand(command) {
    const validCommands = new Set([
        'play',
        'pause',
        'reset',
    ]);

    if (!validCommands.has(command)) {
        console.warn(
            `[Transport Command] Unsupported command: ${command}`,
        );
        return;
    }

    const address =
        `/inviso/transport/${command}`;

    sendOsc(address);

    console.log(
        '[Transport Command]',
        address,
    );
}

// ------------------------------------------------------------
// SERVER STATUS
// ------------------------------------------------------------

wss.on('listening', () => {
    console.log('');
    console.log('========================================');
    console.log(' A Thousand Clocks Quest Bridge READY');
    console.log('========================================');
    console.log(
        `Quest WebSocket: ws://localhost:${QUEST_WS_PORT}`,
    );
    console.log(
        `Inviso OSC: ${INVISO_OSC_HOST}:${INVISO_OSC_PORT}`,
    );
    console.log('');
});

// ------------------------------------------------------------
// QUEST / WEBXR CONNECTION
// ------------------------------------------------------------

wss.on('connection', (socket, request) => {
    const clientAddress =
        request.socket.remoteAddress || 'unknown';

    console.log(
        `[Quest Bridge] WebSocket connected: ${clientAddress}`,
    );

    socket.send(
        JSON.stringify({
            type: 'bridgeStatus',
            connected: true,
        }),
    );

    socket.on('message', (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch (error) {
            console.warn(
                '[Quest Bridge] Ignoring invalid JSON.',
            );
            return;
        }

        if (!data || typeof data.type !== 'string') {
            return;
        }

        // ====================================================
        // INDIVIDUAL SOUND OBJECT COMMANDS
        // ====================================================

        if (data.type === 'objectCommand') {
            const name =
                String(data.name || '').trim();

            const command =
                String(data.command || '')
                    .trim()
                    .toLowerCase();

            sendObjectCommand(
                name,
                command,
                data.value,
            );

            return;
        }

        // ====================================================
        // GLOBAL TRANSPORT COMMANDS
        // ====================================================

        if (data.type === 'transportCommand') {
            const command =
                String(data.command || '')
                    .trim()
                    .toLowerCase();

            sendTransportCommand(command);

            return;
        }

        // ====================================================
        // QUEST CONTROLLER
        // ====================================================

        if (data.type === 'controller') {
            const hand =
                String(data.hand || '')
                    .trim()
                    .toLowerCase();

            const control =
                String(data.control || '')
                    .trim()
                    .toLowerCase();

            const value = Number(data.value);

            if (
                !['left', 'right'].includes(hand) ||
                control !== 'trigger' ||
                !Number.isFinite(value)
            ) {
                console.warn(
                    '[Quest Bridge] Invalid controller payload:',
                    data,
                );
                return;
            }

            const safeValue =
                value >= 0.5 ? 1 : 0;

            sendOsc(
                `/inviso/controller/${hand}/trigger`,
                [safeValue],
            );

            console.log(
                `[Quest Controller] ${hand} trigger=${safeValue}`,
            );

            return;
        }

        // ====================================================
        // LISTENER POSE
        // ====================================================

        if (data.type !== 'pose') {
            console.warn(
                `[Quest Bridge] Unknown message type: ${data.type}`,
            );
            return;
        }

        const x = Number(data.x);
        const y = Number(data.y);
        const z = Number(data.z);

        const yaw = Number(data.yaw);
        const pitch = Number(data.pitch ?? 0);
        const roll = Number(data.roll ?? 0);

        const values = [
            x,
            y,
            z,
            yaw,
            pitch,
            roll,
        ];

        if (!values.every(Number.isFinite)) {
            console.warn(
                '[Quest Bridge] Invalid pose payload:',
                data,
            );
            return;
        }

        // Protect Inviso from accidental large position values.

        const safeX = clamp(x, -1, 1);
        const safeY = clamp(y, -1, 1);
        const safeZ = clamp(z, -1, 1);

        sendOsc(
            '/inviso/listener/position',
            [
                safeX,
                safeY,
                safeZ,
            ],
        );

        sendOsc(
            '/inviso/listener/orientation',
            [
                yaw,
                pitch,
                roll,
            ],
        );

        poseCount++;

        // Avoid flooding the terminal with every XR frame.
        // Print approximately once every 30 received poses.

        if (poseCount % 30 === 0) {
            console.log(
                '[Quest Pose]',
                `x=${safeX.toFixed(3)}`,
                `y=${safeY.toFixed(3)}`,
                `z=${safeZ.toFixed(3)}`,
                `yaw=${yaw.toFixed(3)}`,
            );
        }
    });

    socket.on('close', () => {
        console.log(
            '[Quest Bridge] WebSocket disconnected.',
        );
    });

    socket.on('error', (error) => {
        console.error(
            '[Quest Bridge] WebSocket error:',
            error.message,
        );
    });
});

// ------------------------------------------------------------
// OSC STATUS
// ------------------------------------------------------------

udp.on('ready', () => {
    console.log(
        `[Quest Bridge] OSC output ready -> ` +
        `${INVISO_OSC_HOST}:${INVISO_OSC_PORT}`,
    );
});

udp.on('error', (error) => {
    console.error(
        '[Quest Bridge] OSC error:',
        error.message,
    );
});

udp.open();

// ------------------------------------------------------------
// CLEAN SHUTDOWN
// ------------------------------------------------------------

process.on('SIGINT', () => {
    console.log(
        '\n[Quest Bridge] Shutting down...',
    );

    try {
        udp.close();
    } catch (_) {}

    try {
        wss.close();
    } catch (_) {}

    process.exit(0);
});


