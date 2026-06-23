# Project Requirements — Carb Balancer

## Overview

A carburetor synchronization tool for up to 4 cylinders. Reads intake vacuum via analog
sensors and displays live balance on a web UI. The microcontroller is responsible solely
for ADC data acquisition and communication; all signal processing is performed in the
Web UI. Configuration is done through the web interface; no physical controls beyond a reset.

---

## Hardware

### Microcontroller
- **Primary target:** Arduino Nano ESP32 (ESP32-S3, Xtensa LX7 dual-core)
- **Framework:** Arduino (via arduino-esp32)
- **Portability:** The codebase must remain portable to other Arduino-compatible platforms
  (e.g., Raspberry Pi Pico W). All platform-specific features must be abstracted behind
  platform-independent interfaces. See [Portability](#portability).

### Sensors
- **Model:** MPX4250AP — absolute pressure sensor, one per active cylinder (max 4)
- **Supply:** 5 V
- **Signal conditioning:** Resistor divider 10 kΩ / 20 kΩ on sensor output → scales
  signal to ≤ 3.3 V before ADC input

### ADC
- **Model:** ADS1115 (16-bit, 4 single-ended channels)
- **Count:** 1 module
- **Interface:** I2C, address `0x48`
- **Channels:** AIN0–AIN3 → Cylinder 1–4

### LED
- **Count:** 1
- **Behavior:**
  - Solid ON → device started up, WiFi AP active, idle
  - Blinking → ADC measurement running (synchronization in progress)

### USB / Serial
- **Purpose:** Optional raw ADC data stream for external plotting
- **Format:** Arduino Serial Plotter compatible
  - Tab-separated labeled values: `Cyl1:\t<val>\tCyl2:\t<val>\t...\n`
  - Only active cylinders are included in the output

---

## Software Architecture

### Firmware Responsibilities

The firmware runs on the microcontroller and is responsible for exactly three things:

1. **ADC acquisition** — continuously sample raw ADC values from all active channels
2. **Data streaming** — broadcast raw ADC data to connected Web UI clients over WebSocket
3. **Command handling** — receive and apply commands from the Web UI (e.g., settings updates)

The firmware performs **no signal processing**: no filtering, no unit conversion, no RPM
detection. All processing is delegated to the Web UI.

### Web UI Responsibilities

The Web UI runs in the browser and is responsible for:

1. **Signal processing** — EMA smoothing, RPM detection (peak detection on the
   reference channel), balance delta calculation
2. **Unit conversion** — raw ADC → engineering units (kPa) for display
3. **Live display** — cylinder cards and balance indicators updated in real time
4. **Settings management** — session settings (channels, reference, interval,
   damping) kept in the browser's `localStorage` and pushed to the firmware on
   connect; WiFi credentials read/written via WebSocket and persisted on-device
5. **Data export** — record per-channel kPa values to a downloadable CSV file

### Language & Style
- Language: C++ (Google C++ Style Guide, 4-space indent, 120-char line limit)
- Naming: camelCase functions, snake_case variables, snake_case_ private members,
  PascalCase classes
- Web server: ESPAsyncWebServer (or platform-equivalent)
- Web UI assets: embedded in firmware as PROGMEM (no LittleFS/SPIFFS); generated
  by build script from source files in `web/` — never hand-edited
- Real-time data push: WebSocket (server → browser)

### WiFi
- Mode: **Access Point only**
- SSID / password: configurable, stored in persistent storage
- Default SSID: `CarbBalancer`, default password: `balance1`

### Persistence
Only WiFi AP credentials (`ap_ssid`, `ap_password`) are persisted to non-volatile
storage. Everything else is session-only, kept in the browser's `localStorage`
and in firmware RAM, resent via `set_session` every time the browser connects:
- Active channels — bitmask (`uint8_t`, bits 0-3 map to AIN0-AIN3); at least one bit must be set
- Reference channel index (must be a set bit in the channel mask)
- WebSocket broadcast interval (ms)
- EMA / RPM damping factors (browser-side only — never sent to or stored on the firmware)

Disconnecting (or power-cycling the device) clears the RAM copy and stops ADC sampling.

---

## Web UI

Single-page app served from PROGMEM. Communicates with firmware over WebSocket.

### Live View (main screen)
- One card per active cylinder: current vacuum reading (kPa) and delta from
  the reference cylinder
- Reference cylinder highlighted visually, shows "ref" instead of a delta
- RPM readout in the header, derived from peak detection on the reference
  channel; reads `-- RPM` when not running or when the signal amplitude is
  too low to be a real pulse (engine off)
- Status bar: Synchronized / Almost Synchronized / Desynchronized, based on
  the largest delta among non-reference cylinders
- Card values refresh on a fixed timer, decoupled from the WebSocket push
  rate (refreshing on every message made the numbers unreadable)
- Optional waveform plot (raw per-sample kPa), started/stopped independently
  of the cards, with timebase/span/scroll controls
- Optional CSV recording of per-channel kPa values (no timestamp), available
  only while both ADC and the waveform plot are running; stops automatically
  when either stops, when Settings is opened, or when the page is closed

### Settings Panel
- Opened via the ⚙ button in the header; live view is hidden while open
- Opening the panel automatically stops any running measurement (plot and
  recording stop with it)
- Fields: per-channel enable toggle (independently enable/disable each of channels 0-3),
  reference channel selector (populated with only the currently active channels),
  EMA damping (0-16), RPM damping (0-16), WebSocket broadcast interval (ms),
  WiFi AP SSID and password
- On open, the channel/reference/damping/interval fields populate from the
  browser's `localStorage`; WiFi fields populate from the firmware (`get_wifi`)
- **Reference channel validation:** whenever the active channel selection changes, the
  reference selector is rebuilt to contain only active channels. If the previously selected
  reference channel has been deactivated, the selector is cleared and an inline warning is
  shown ("Reference channel deactivated — select a new one"). The Save button is blocked
  until a valid reference is chosen.
- Save is also blocked when no channels are active (at least one must be enabled)
- Save button persists channel/reference/damping/interval fields to `localStorage`
  and sends them to the firmware via `set_session` (RAM only, never persisted
  on-device); WiFi fields are sent via `set_wifi`, which writes to non-volatile
  storage and reconfigures the AP in-place
- "Saved" confirmation shown for 3 s after successful save

### Web UI Development Workflow

Source files live in `web/` and are never deployed directly to the device:

```
web/
├── index.html
├── styles.css
├── package.json / tsconfig.json
└── src/                ← TypeScript, bundled by esbuild into script.js
    ├── main.ts
    ├── ws_client.ts
    ├── signal_processor.ts
    ├── rpm_detector.ts
    ├── wave_renderer.ts
    ├── cylinder_view.ts
    ├── csv_recorder.ts
    └── settings_panel.ts

tools/
├── build_web.py      ← npm install/build, then converts web/{index.html,styles.css,script.js}
│                        into PROGMEM headers (WebUI.h, WebCSS.h, WebJS.h)
└── mock_server.py    ← local HTTP + WebSocket mock that serves web/ and streams fake sensor data
```

**Development cycle:**
1. `cd web && npm install` — first time only
2. Run `python tools/mock_server.py` — serves `web/` and streams fake ADC readings over WebSocket
3. Open `http://localhost:8080/` in browser — no hardware needed
4. Edit `web/src/*.ts` (or HTML/CSS); rebuild with `npm run build` (or `npm run dev` to watch), refresh browser
5. When ready: recompile and flash firmware — `tools/build_web.py` runs automatically as a
   PlatformIO pre-build step and regenerates the PROGMEM headers

LittleFS/SPIFFS is **never used**. PROGMEM is the only deploy target.

---

## Sampling & Data Streaming

### ADC Acquisition
- ADS1115 runs in single-shot mode, cycling through active channels in round-robin
- ALRT/RDY pin fires a falling-edge interrupt on each completed conversion
- ISR sets a flag only (no I2C in ISR context); the read is performed outside the ISR
- The firmware maintains a separate sample queue per channel
- Each sample stores a raw ADC value (uint16_t) and a timestamp (µs since boot, unsigned long)

### Broadcast (WebSocket JSON)

The firmware drains each active channel's queue and broadcasts all queued samples at the
configured interval. The `chs` array is always 4 elements long; position equals channel
index (0-3). Inactive channels are `null`. Timing is described by `t0` and `dt` derived
from the reference channel, so individual samples carry no per-sample timestamp:

```json
{
  "type": "wave",
  "t0": 1250000,
  "dt": 5000,
  "chs": [
    null,
    null,
    [18432, 18298, 18510],
    [18480, 18301, 18512]
  ]
}
```

- `t0` — µs timestamp (unsigned long) of the first sample of the reference channel in this batch
- `dt` — average sample interval in µs between consecutive samples (derived from reference channel)
- `chs[i]` — array of uint16_t raw ADC values for channel i, or `null` if channel i is inactive
- Broadcast at `update_interval_ms` (default 50 ms)

> **Forward-looking:** A future revision of the protocol may include processed values
> (e.g., kPa or mbar) in addition to or instead of raw ADC data, once unit conversion
> is validated and stable.

### WebSocket Commands (browser → firmware)

| Command | Payload | Firmware behavior |
|---|---|---|
| `start` | — | Start ADC sampling |
| `stop` | — | Stop ADC sampling, clear sample queues |
| `set_session` | `channel_mask`, `reference_channel`, `update_interval_ms` | Applied to RAM only; not persisted |
| `get_wifi` | — | Replies to the requesting client: `{"type":"wifi","ap_ssid":"...","ap_password":"..."}` |
| `set_wifi` | `ap_ssid`, `ap_password` | Saved to non-volatile storage, AP reconfigured in-place, broadcasts `{"type":"wifi_saved"}` to all clients |

`channel_mask` is a bitmask where bit _i_ enables channel _i_ (e.g. `13` = `0b1101` = channels 0, 2, 3 active).

EMA damping and RPM damping are **not** sent to the firmware — they are browser-side
parameters used only by the Web UI's signal processing.

ADC sampling stops automatically on WebSocket disconnect.

---

## Calibration (Future Requirement)

Calibration has been removed from the current implementation and is planned for future
reintroduction under the following constraints:

- Calibration must operate **only on raw ADC data** — it must not depend on or produce
  unit-converted values (kPa, mbar, etc.)
- Calibration adjustments are applied to raw ADC values, before any processing or conversion
- The calibration model, storage format, and UI workflow are to be defined when
  the feature is reintroduced
- No implementation details are prescribed at this stage

---

## Portability

The codebase must support multiple hardware targets without changes to shared logic:

- **Current target:** Arduino Nano ESP32 (ESP32-S3)
- **Planned target:** Raspberry Pi Pico W (RP2040)

All platform-specific dependencies must be isolated behind abstract interfaces:

- **Persistent storage** — NVS on ESP32, Flash/EEPROM on others
- **Hardware timers** — any platform-specific timer API
- **ADC driver** — platform-specific I2C or ADC peripheral access
- **Any other platform peripherals**

No platform-specific API (e.g., `esp_timer`, `nvs_flash`, `Preferences`) may appear
in shared firmware logic. Platform adapters are isolated in their own modules.

---

## Testing

### Web UI Tests
- Framework: [Vitest](https://vitest.dev/)
- Test location: `web/test/`
- Coverage targets:
  - WebSocket message parsing and cylinder card update logic
  - Active channel selection and `chs` array handling (including null entries)
  - Balance delta calculation (deviation from reference channel)
  - Signal processing: EMA smoothing (kPa and RPM), peak-detection RPM with amplitude gating
  - Settings form validation (valid channel combinations, reference channel must be active)
- UI behaviour verified against `tools/mock_server.py` during development

---

## Constraints & Non-Goals

- No LCD display
- No Bluetooth
- No OTA update (not in initial scope)
- No STA (client) WiFi mode
- Max 4 channels (AIN0-AIN3); any non-empty subset can be enabled independently at runtime
- No signal processing in firmware (all processing in Web UI)
