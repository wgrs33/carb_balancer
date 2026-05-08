# Project Requirements — Carb Balancer

## Overview

A carburetor synchronization tool for up to 4 cylinders. Reads intake vacuum via analog
sensors, displays live balance on a web UI, and streams raw ADC data over USB serial.
All configuration is done through the web interface; no physical controls beyond a reset.

---

## Hardware

### Microcontroller
- **Board:** Arduino Nano ESP32
- **SoC:** ESP32-S3 (Xtensa LX7 dual-core)
- **Framework:** Arduino (via arduino-esp32)

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

### Firmware
- Language: C++ (Google C++ Style Guide, 4-space indent, 120-char line limit)
- Naming: camelCase functions, snake_case variables, snake_case_ private members,
  PascalCase classes
- Web server: ESPAsyncWebServer
- Web UI assets: embedded in firmware as PROGMEM (no LittleFS/SPIFFS); generated
  by build script from source files in `web/` — never hand-edited
- Real-time data push: WebSocket (server → browser)

### WiFi
- Mode: **Access Point only**
- SSID / password: configurable, stored in NVS
- Default SSID: `CarbBalancer`, default password: `balance1`

### Persistence (NVS)
Settings saved to NVS and restored on boot:
- Active cylinder count (1–4)
- Reference cylinder index (1–4)
- Per-channel calibration offsets and gain trim
- ADC sampling rate and averaging window
- WiFi AP credentials

---

## Web UI

Single-page app served from PROGMEM. Communicates with firmware over WebSocket.

### Live View (main screen)
- Bar graph / gauge per active cylinder showing current vacuum reading (in kPa or raw)
- Balance indicator: deviation of each cylinder from the reference cylinder
- Reference cylinder highlighted visually
- Update rate: driven by WebSocket push (≈ sampling rate)

### Settings Page
- Number of active cylinders (1–4)
- Reference cylinder selection (any active cylinder)
- Per-cylinder zero offset and gain trim (for calibration)
- ADC samples-per-average and update interval
- WiFi AP SSID and password
- Save button → writes all settings to NVS and applies immediately

### Web UI Development Workflow

Source files live in `web/` and are never deployed directly to the device:

```
web/
├── index.html
├── style.css
└── app.js

tools/
├── build_web.py      ← converts web/ → src/WebUI.h (PROGMEM arrays)
└── mock_server.py    ← local WebSocket mock that streams fake sensor data
```

**Development cycle:**
1. Run `python tools/mock_server.py` — serves fake ADC readings over WebSocket
2. Open `web/index.html` in browser — connects to mock server, no hardware needed
3. Edit HTML/CSS/JS freely; refresh browser to see changes
4. When UI is ready: `python tools/build_web.py` → regenerates `src/WebUI.h`
5. Recompile firmware and flash once

This means LittleFS/SPIFFS is **never used**. PROGMEM is the only deploy target.

---

## Sampling & Processing

### ADC acquisition
- ADS1115 runs in single-shot mode, cycling through active channels in round-robin
- ALRT/RDY pin (GPIO3 = A2) fires a falling-edge interrupt on each completed conversion
- ISR sets a flag only (no I2C in ISR context); `AdcReader::update()` performs the I2C read

### Signal processing pipeline (per sample)
```
Raw ADC sample
  → calibration  (offset + gain, integer fixed-point)
  → EMA smoothing (α configurable, stored as int ×1000; e.g. 100 = α 0.1)
  → ring buffer   (256 entries per channel, each entry: {value, timestamp_ms})
```

### RPM detection
- RPM is estimated from the vacuum signal itself — no separate tachometer input
- Firmware tracks the interval between successive vacuum minima on one reference channel
- For a 4-stroke engine: one engine cycle = 2 crankshaft revolutions
  → `cycle_ms = 120,000 / RPM`
- RPM is recalculated continuously and updated in the `AdcReader`

### Displayed value — minimum EMA within auto-calculated window
- `window_ms = cycle_ms × (1 + margin_percent / 100)`
- `margin_percent` is a small configurable value (default 20%, range 0–100)
- `minReading(channel)` scans the ring buffer backward and returns the lowest EMA value
  within the last `window_ms` milliseconds
- This captures the deepest vacuum pull of each cylinder's intake stroke
- Cylinders with a higher minimum (less vacuum) indicate a carb that is open too far or has a leak

### Broadcast
- `minReading()` values broadcast over WebSocket at the configured update interval
- Serial Plotter prints the same minimum values in Arduino Serial Plotter format

---

## Testing

### Firmware Unit Tests
- Framework: [Unity](https://github.com/ThrowTheSwitch/Unity) via
  [arduino-mock](https://github.com/ikeyasu/arduino-mock) or native C++ runner
  (no hardware required — tests run on the host machine)
- Test location: `test/`
- Coverage targets:
  - ADC value → kPa conversion (MPX4250AP transfer function + resistor divider scaling)
  - Calibration offset and gain application
  - Averaging logic (sliding window or accumulate-and-divide)
  - NVS settings serialization / deserialization (with mock NVS)
  - WebSocket JSON message formatting
  - Active cylinder mask logic (which channels are sampled)

### Web UI Tests
- Framework: plain browser-based or [Vitest](https://vitest.dev/) if a build step
  is introduced later
- Coverage targets:
  - WebSocket message parsing and gauge update logic
  - Settings form validation (cylinder count range, offset bounds, etc.)
  - Balance delta calculation (deviation from reference cylinder)
- UI behaviour tested against `tools/mock_server.py` during development

---

## Constraints & Non-Goals

- No LCD display
- No Bluetooth
- No OTA update (not in initial scope)
- No STA (client) WiFi mode
- Max 4 cylinders; fewer can be enabled at runtime
