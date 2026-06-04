#!/usr/bin/env python3
"""
tools/mock_server.py -- standalone WebSocket mock for Carb Balancer web UI dev.

Serves web/index.html and streams fake raw ADC data over WebSocket.
No hardware or compiled binary required.

Signal: 10 Hz sine wave per channel (≈1200 RPM, 4-stroke), 90° phase offset each.
  Raw ADC range: 3000–9000 (uint16_t, simulating ADS1115 output)
  Imbalance:     +5 % amplitude per channel beyond the reference

Usage:
    python3 tools/mock_server.py [--port 8080] [--mask 0xF]

Requirements:
    pip install aiohttp
"""

import argparse
import asyncio
import json
import math
import time
from pathlib import Path

try:
    import aiohttp
    from aiohttp import web
except ImportError:
    import sys
    sys.exit("aiohttp not found.  Install with:  pip install aiohttp")

ROOT = Path(__file__).resolve().parent.parent
PORT = 8080
K_MAX_CHANNELS = 4

_SIG_FREQ_HZ       = 10.0    # 10 Hz → 1200 RPM (4-stroke: 2 rotations per cycle)
_SIG_MID           = 6000    # ADC midpoint
_SIG_AMP           = 3000    # half-range → 3000–9000 raw ADC
_IMBALANCE         = 0.05    # extra amplitude per channel beyond reference
_DT_US             = 5_000   # simulated sample interval µs (200 Hz per channel)
_SAMPLES_PER_BATCH = 10      # samples per channel per broadcast


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def _lowest_active(mask: int) -> int:
    for i in range(K_MAX_CHANNELS):
        if mask & (1 << i):
            return i
    return 0


class State:
    def __init__(self, channel_mask: int) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.running: bool = False
        self.settings: dict = {
            "channel_mask":       channel_mask & 0x0F,
            "reference_channel":  _lowest_active(channel_mask),
            "damping":            8,
            "update_interval_ms": 50,
            "ap_ssid":            "CarbBalancer",
            "ap_password":        "balance1",
        }


# ---------------------------------------------------------------------------
# Signal generation
# ---------------------------------------------------------------------------

def _generate(state: State) -> str:
    t    = time.monotonic()
    mask = state.settings["channel_mask"]
    now_us = int(time.monotonic() * 1_000_000)
    t0 = now_us - (_SAMPLES_PER_BATCH - 1) * _DT_US

    chs: list = []
    for ch in range(K_MAX_CHANNELS):
        if not (mask & (1 << ch)):
            chs.append(None)
            continue
        samples = []
        for i in range(_SAMPLES_PER_BATCH):
            sample_t = t + (i - _SAMPLES_PER_BATCH + 1) * (_DT_US / 1_000_000.0)
            phase = 2.0 * math.pi * _SIG_FREQ_HZ * sample_t + (math.pi / 2.0) * ch
            amp   = _SIG_AMP * (1.0 + _IMBALANCE * ch)
            raw   = int(_SIG_MID + amp * math.sin(phase))
            samples.append(max(0, min(65535, raw)))
        chs.append(samples)

    return json.dumps({"type": "wave", "t0": t0, "dt": _DT_US, "chs": chs})


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

def _apply_settings(state: State, data: dict) -> None:
    if "channel_mask" in data:
        mask = int(data["channel_mask"]) & 0x0F
        if mask != 0:
            state.settings["channel_mask"] = mask
            cur_ref = state.settings["reference_channel"]
            if not (mask & (1 << cur_ref)):
                state.settings["reference_channel"] = _lowest_active(mask)
    for key in ("reference_channel", "damping", "update_interval_ms", "ap_ssid", "ap_password"):
        if key in data:
            state.settings[key] = data[key]


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------

async def _broadcast(state: State, text: str) -> None:
    dead: set[web.WebSocketResponse] = set()
    for ws in set(state.clients):
        try:
            await ws.send_str(text)
        except Exception:
            dead.add(ws)
    state.clients -= dead


async def broadcast_loop(app: web.Application) -> None:
    state: State = app["state"]
    while True:
        interval = state.settings["update_interval_ms"] / 1000.0
        if state.running and state.clients:
            await _broadcast(state, _generate(state))
        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# HTTP / WebSocket handlers
# ---------------------------------------------------------------------------

async def handle_api_settings_get(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    return web.json_response(state.settings)


async def handle_api_settings_post(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    try:
        data = await request.json()
    except Exception:
        raise web.HTTPBadRequest()
    _apply_settings(state, data)
    return web.json_response({"ok": True})


async def handle_index(request: web.Request) -> web.Response:
    html = (ROOT / "web" / "index.html").read_text()
    return web.Response(text=html, content_type="text/html")


async def handle_static(request: web.Request) -> web.Response:
    name = request.match_info["name"]
    path = ROOT / "web" / name
    ctype = "text/css" if name.endswith(".css") else "application/javascript"
    return web.Response(text=path.read_text(), content_type=ctype)


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    state: State = request.app["state"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    state.clients.add(ws)
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    cmd = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                c = cmd.get("cmd")
                if c == "start":
                    state.running = True
                elif c == "stop":
                    state.running = False
                elif c == "get_settings":
                    await ws.send_str(json.dumps({"type": "settings", **state.settings}))
                elif c == "set_settings":
                    _apply_settings(state, cmd)
                    await ws.send_str(json.dumps({"type": "settings_saved"}))
            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break
    finally:
        state.clients.discard(ws)
    return ws


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

async def on_startup(app: web.Application) -> None:
    app["broadcast_task"] = asyncio.create_task(broadcast_loop(app))


async def on_shutdown(app: web.Application) -> None:
    if task := app.get("broadcast_task"):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Carb Balancer WebSocket mock server")
    parser.add_argument("--port", type=int, default=PORT,
                        help="HTTP / WebSocket port (default: 8080)")
    parser.add_argument("--mask", type=lambda x: int(x, 0), default=0xF,
                        help="Active channel bitmask hex or decimal (default: 0xF = all 4)")
    args = parser.parse_args()

    if not (0x1 <= (args.mask & 0xF) <= 0xF):
        parser.error("--mask must have at least one of bits 0-3 set")

    state        = State(args.mask)
    app          = web.Application()
    app["state"] = state
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/",              handle_index)
    app.router.add_get("/{name:(styles\\.css|script\\.js)}", handle_static)
    app.router.add_get("/ws",            handle_ws)
    app.router.add_get("/api/settings",  handle_api_settings_get)
    app.router.add_post("/api/settings", handle_api_settings_post)

    print(f"Mock server  ->  http://localhost:{args.port}/")
    print(f"Active mask:     0x{args.mask & 0xF:X}")
    print("Open the URL above, click Start, and watch the live data.")
    print("Press Ctrl-C to stop.")
    web.run_app(app, host="localhost", port=args.port, print=lambda *_: None)


if __name__ == "__main__":
    main()
