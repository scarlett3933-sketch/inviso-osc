# A Thousand Clocks — Quest to Inviso Bridge

This directory contains the WebSocket-to-OSC bridge used by **A Thousand Clocks** when running with Inviso.

It receives tracking and playback-control messages from the WebXR application running on Meta Quest and forwards them to the local Inviso OSC relay.

## Signal Flow

```text
Meta Quest / WebXR
        |
        | WebSocket JSON
        v
Quest Bridge :8082
        |
        | OSC UDP
        v
Inviso OSC Relay :9000
        |
        v
Inviso
        |
        v
Spatial audio system
```

## Requirements

* Node.js 16.20.2
* Inviso running locally
* Inviso OSC relay listening on UDP port 9000

If `nvm` is installed:

```bash
nvm use
```

Install dependencies:

```bash
npm install
```

## Run

From this directory:

```bash
npm start
```

A successful startup should print:

```text
========================================
 A Thousand Clocks Quest Bridge READY
========================================
Quest WebSocket: ws://localhost:8082
Inviso OSC: 127.0.0.1:9000
```

The bridge listens for WebSocket messages on port `8082` and forwards OSC messages to:

```text
127.0.0.1:9000
```

## Supported WebSocket Messages

### Listener Pose

Example:

```json
{
  "type": "pose",
  "x": 0.1,
  "y": 0,
  "z": -0.2,
  "yaw": 0.5,
  "pitch": 0,
  "roll": 0
}
```

OSC output:

```text
/inviso/listener/position x y z
/inviso/listener/orientation yaw pitch roll
```

Position values are clamped to the normalized Inviso range `[-1, 1]`.

### Individual Sound Object Control

Play:

```json
{
  "type": "objectCommand",
  "name": "Clock_01",
  "command": "play"
}
```

Pause:

```json
{
  "type": "objectCommand",
  "name": "Clock_01",
  "command": "pause"
}
```

Reset:

```json
{
  "type": "objectCommand",
  "name": "Clock_01",
  "command": "reset"
}
```

Enable looping:

```json
{
  "type": "objectCommand",
  "name": "Clock_01",
  "command": "loop",
  "value": 1
}
```

Disable looping:

```json
{
  "type": "objectCommand",
  "name": "Clock_01",
  "command": "loop",
  "value": 0
}
```

These messages are translated to:

```text
/inviso/object/Clock_01/play
/inviso/object/Clock_01/pause
/inviso/object/Clock_01/reset
/inviso/object/Clock_01/loop 1
/inviso/object/Clock_01/loop 0
```

To restart a sound object from the beginning, send:

```text
reset
play
```

in sequence.

## Global Transport

The bridge also supports global Inviso transport commands.

Example:

```json
{
  "type": "transportCommand",
  "command": "play"
}
```

Supported commands:

```text
play
pause
reset
```

OSC output:

```text
/inviso/transport/play
/inviso/transport/pause
/inviso/transport/reset
```

## Ports

| Port   | Purpose                                     |
| ------ | ------------------------------------------- |
| `8082` | Quest/WebXR → Quest Bridge WebSocket        |
| `9000` | Quest Bridge → Inviso OSC                   |
| `8081` | Inviso OSC relay → Inviso browser WebSocket |

The Quest bridge and the original Inviso OSC relay are separate processes.

## Development Setup

For the A Thousand Clocks Michigan runtime, the WebXR application connects through the Vite WebSocket proxy:

```text
/inviso-ws
    ↓
ws://127.0.0.1:8082
```

During Quest development, the WebXR page must be served from a secure context. A temporary Cloudflare HTTPS tunnel may be used for development.

The final venue setup should use a stable local network and local HTTPS configuration rather than depending on a temporary public tunnel.

## Verified Functionality

The following functionality has been tested successfully with the current Inviso build:

* Meta Quest head position → Inviso listener position
* Meta Quest head orientation → Inviso listener orientation
* Individual sound-object play
* Individual sound-object pause
* Resume from paused position
* Reset to beginning
* Loop on
* Loop off

## Syntax Check

Before running:

```bash
npm run check
```

## Troubleshooting

### Port 8082 is already in use

Check which process is using the port:

```bash
lsof -nP -iTCP:8082 -sTCP:LISTEN
```

Stop the old bridge process before starting another instance.

### WebXR does not connect to the bridge

Confirm that the bridge prints:

```text
Quest WebSocket: ws://localhost:8082
```

For Michigan development mode, also confirm that the Vite `/inviso-ws` proxy points to:

```text
ws://127.0.0.1:8082
```

### OSC commands are logged but Inviso does not respond

Confirm that Inviso reports:

```text
Listening on UDP 9000
```

Also verify that the Inviso sound-object name exactly matches the name in the WebSocket command.

For example:

```text
Clock_01
```

is different from:

```text
clock_01
```


