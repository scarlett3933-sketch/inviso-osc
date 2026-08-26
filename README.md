# Inviso with OSC control

![Controlling the Inviso listener head over OSC](docs/osc-demo.gif)

A cross-platform tool for designing interactive virtual soundscapes, extended with external control of the listener head over OSC.

Inviso lets you build 3D soundscapes in the browser: place sound objects, draw sound zones, animate them along trajectories, and move a listener head through the scene to hear the result binaurally or as 3rd-order ambisonics. An ACM UIST paper about Inviso, including a video figure, can be found [here](https://dl.acm.org/citation.cfm?doid=3126594.3126644).

This fork adds an OSC input path so the listener head can be driven from external software, alongside the existing keyboard and mouse controls.

For the original project documentation — build scripts, project structure, and ambisonics setup — see [`inviso_original_readme.md`](inviso_original_readme.md).

## Credits

Inviso is developed at the University of Michigan.

Project leader, primary developer: Anıl Çamcı [<acamci@umich.edu> • http://anilcamci.com]<br/>
Developers: [2025] Yun Ma <yunma@umich.edu>, [2024-2025] Michael Cella <mjcella@umich.edu>, [2019-2021] Tanya Lai <tanyalai@umich.edu>, Julia Xu <juliawxu@umich.edu>, [2016-2017] Kristine Lee <khlee2@uic.edu>, Cody J. Roberts <codyroberts@protonmail.com>, Angus Forbes <angus@ucsc.edu>

The OSC control described below was added on top of that work.

## What was added

Three things can be driven over OSC: the position and orientation of the listener head, the global transport, and playback of individual sound objects.

Browsers cannot receive raw OSC, because a web page is not allowed to open a listening socket. The feature is therefore split in two:

* **`osc-bridge/`** — a small Node relay that listens for OSC over UDP and forwards each message as JSON over a WebSocket on port 8081.
* **`src/js/app/managers/osc.js`** — a WebSocket client in the app that applies incoming messages.

Listener updates are buffered and the latest value is applied once per animation frame, so a fast sender cannot flood the render loop. They reuse the same code path as the W/A/S/D keys, which means OSC is additive: keyboard and mouse control keep working, and OSC yields to an active mouse drag or a running trajectory exactly as the keys do. Object commands are discrete events and so are applied on arrival instead.

A panel in the top bar toggles OSC on and off, sets the UDP port, and reports relay status. It also shows the last object command received and whether it matched an object, since a mistyped or deleted name would otherwise fail silently. The toggle and port persist between sessions.

The top bar's single play/pause toggle is now three controls — **Play**, **Pause** and **Reset** — with whichever of Play or Pause reflects the current state highlighted. Reset is new: there was previously no way to return to the start of a file.

Sound objects gain a **Name** field and a **Loop** toggle in their panel, both of which persist through scene export and import. Looping was previously always on; it can now be switched off per object, in which case a sound that reaches its end returns to the start and marks itself paused.

Everything in the interface is also addressable over OSC, and the two stay in step: a message sent from outside updates the buttons, and a button press behaves identically to the equivalent message.

## Requirements

* **Node 16.** The project builds with webpack 2, which calls the `md4` hash. OpenSSL 3 removed it, so builds fail on Node 17 and later with a `digital envelope routines::unsupported` error. Node 16 still ships OpenSSL 1.1 and needs no workaround.
* **A C++ toolchain.** `node-sass` publishes no prebuilt binary for Apple Silicon, so it is compiled from source. On macOS this needs the Xcode command line tools; on Debian/Ubuntu, `build-essential` and `python3`; on Windows, the Visual Studio Build Tools.
* **Python 3** with `python-osc`, only if you want to run the included test script.

## Setup

### Automated

From a fresh machine, `bootstrap.sh` clones the repository and sets everything up in one step:

```
./bootstrap.sh                    # clones into ./inviso-osc
./bootstrap.sh ~/projects/inviso  # or a directory of your choice
```

If the repository is already cloned, run the setup script from inside it instead:

```
./setup.sh      # macOS and Linux
.\setup.ps1     # Windows
```

Both scripts resolve paths from their own location, so the clone can live anywhere. They select Node 16 through nvm — offering to install nvm if it is missing — install dependencies for both the app and the relay, rebuild `node-sass` when no prebuilt binary loads, start the relay, and launch the app at `localhost:8080`.

Re-running either script is safe. Existing clones are updated rather than replaced, completed steps are skipped, and a relay that is already running is reused instead of starting a second one.

### Manual

The equivalent steps, if you would rather run them yourself:

```
# 1. toolchain (macOS shown; see Requirements for other platforms)
xcode-select --install

# 2. Node 16
brew install nvm
nvm install 16
nvm use 16

# 3. dependencies
npm install
cd osc-bridge && npm install && cd ..

# 4. node-sass, only if it fails to load on your platform
node -e "require('node-sass')" || npm rebuild node-sass --build-from-source
```

Then start the two processes in separate terminals:

```
npm run dev                     # app on localhost:8080
cd osc-bridge && npm start      # relay: WebSocket 8081, OSC over UDP
```

`npm run dev` runs three tasks in parallel: a `node-sass` watcher compiling `src/css` to `src/public/assets/css`, a webpack dev server, and a webpack watch build. Note that the repository ships with `node_modules` committed upstream, so the initial clone is around 80 MB and `npm install` often has nothing to do.

### Ports

| Port | Protocol | Used by |
| --- | --- | --- |
| 8080 | HTTP | webpack dev server |
| 8081 | WebSocket | relay to browser |
| configurable | UDP | OSC input, set in the app |

## Build and deploy

```
npm run build     # clean build/, copy src/public across, compile js and css
npm run deploy    # publish build/public to the gh-pages branch
```

`build/` is committed to the repository, so rebuild before deploying or you will publish a stale bundle. The full list of individual scripts is in [`inviso_original_readme.md`](inviso_original_readme.md).

A production build emits a minified bundle of roughly 1.6 MB, against 7 MB in development.

Two issues in the upstream build had to be fixed to make that work, both unrelated to OSC:

* The build scripts set `NODE_ENV` with `set VAR=value&&`, which only works on Windows. On macOS and Linux it silently did nothing, so webpack stayed in development mode and the build published an unminified bundle. The scripts now use `cross-env`.
* Forcing production mode then failed in UglifyJS with `Unexpected token: operator (*)`. The UglifyJS bundled with webpack 2 predates ES2016 and cannot parse the exponentiation operator that reaches the bundle from three.js. The config now uses `uglifyjs-webpack-plugin`, which is built on `uglify-es`.

OSC requires the relay to be running on the same machine as the browser, since a web page cannot open a listening socket. A deployed build loads and runs normally without it — the OSC panel simply reports that the relay is not running, and keyboard and mouse control are unaffected.

## Usage

1. Click **OSC** in the top bar to enable it.
2. Set the UDP port. The relay rebinds immediately — no restart required.
3. Confirm the status line reads *Listening on UDP \<port\>* in green.
4. Send OSC to that port on `127.0.0.1`.

The line beneath the port shows each transport or object command as it lands, and reports in orange when a name matched nothing.

To control an object by name, create it, load audio into it through **File | Input**, and type a name into its **Name** field. Audio can only be loaded through the interface, not over OSC.

### Controls in the interface

| Control | Where | Does |
| --- | --- | --- |
| **Play**, **Pause**, **Reset** | top bar | global transport, covering objects and zones |
| **Name** | object panel | the name the object answers to over OSC |
| **Loop** | object panel | looping for that object and its cones |
| **OSC** | top bar | enable OSC, set the UDP port, view status |

## Message schema

### Listener head

```
/inviso/listener/position     x y z             floats, normalized -1..1
/inviso/listener/orientation  yaw pitch roll    floats in radians
```

**Position** — all three arguments are normalized to the range -1..1:

| Argument | Axis | Negative to positive | Scene range |
| --- | --- | --- | --- |
| `x` | left/right | left to right | ±5000 units |
| `y` | height | down to up | ±300 units |
| `z` | forward/back | forward to back | ±5000 units |

Forward is negative `z`, following the convention already used throughout the app. Only `y` is clamped; values outside -1..1 on `x` and `z` will place the head off the visible grid. At the default zoom level roughly ±0.25 is visible on screen.

Height is not visible in the default aerial view. Tilt the camera into altitude view to see it.

**Orientation** — `yaw` is applied in radians and is unbounded. `pitch` and `roll` are accepted and ignored, as the listener head tracks orientation solely through its yaw everywhere else in the app.

### Transport

```
/inviso/transport/play
/inviso/transport/pause
/inviso/transport/reset
```

The global controls, matching the **Play**, **Pause** and **Reset** buttons in the top bar. These cover sound zones as well as objects, which the per-object commands do not.

`reset` sends everything back to the start of its file and leaves the transport where it is: what was playing keeps playing, from zero.

### Sound objects

```
/inviso/object/<name>/play
/inviso/object/<name>/pause
/inviso/object/<name>/reset
/inviso/object/<name>/loop     1 or 0, or no argument to toggle
```

`play` resumes from wherever the sound was paused; `reset` returns it to the start, continuing to play if it was playing. `loop` applies to the whole object, its cones included, and takes effect on anything already playing as well as on the next play.

An object answers to two names: whatever is typed in its **Name** field, and its position in the scene as `object-1`, `object-2` and so on. Both work at once, so a patch written against `object-1` keeps working after the object is renamed. Given names take precedence, and matching ignores case.

Audio files cannot be loaded over OSC, only controlled. Load them through **File | Input** in the object's panel first.

## Testing

Two scripts are included. Set the same port in the OSC panel before running either.

```
pip3 install python-osc
```

Listener head — position, height, yaw, and a continuous orbit:

```
python3 osc-bridge/test_osc.py          # port 7777
python3 osc-bridge/test_osc.py 9000     # or any other port
```

Playback — play, pause, resume, reset and loop for each object, then all together, then the global transport, finishing on a name that does not exist so the panel's unmatched-name reporting can be seen:

```
python3 osc-bridge/test_objects.py                    # port 7777, object-1 onwards
python3 osc-bridge/test_objects.py drums vocals       # address by given name
python3 osc-bridge/test_objects.py 9000 drums vocals  # both
```

Create a sound object for each file in `audio_test/` and load it before running this one.

## Troubleshooting

**Status reads "Relay not running"** — the relay is not up. Re-run `setup.sh`, which starts it.

**Status is green but nothing moves** — the port in the app and the port in your sender do not match.

**The head jumps off screen** — position values are normalized. Keep them within roughly ±0.2 while working at the default zoom.

**An object command says "no such object"** — the name in the message matches neither an object's **Name** field nor its `object-<n>` position. Check the panel for the name it received.

**An object command matched but nothing is heard** — the object has no audio loaded. Load a file through **File | Input** in its panel.
