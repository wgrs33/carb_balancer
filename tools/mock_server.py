#!/usr/bin/env python3
"""
tools/mock_server.py -- standalone WebSocket mock for Carb Balancer web UI dev.

Serves web/index.html and streams fake vacuum data over WebSocket.
No hardware or compiled binary required.

Signal: 10 Hz sine wave per channel, 90° phase offset each.
  Range:     40–100 kPa  (mid 70 kPa, amplitude 30 kPa)
  Imbalance: +5 % amplitude per channel beyond the reference
  RPM:       1200  (4-stroke: 120 000 / 100 ms cycle)

Usage:
    python3 tools/mock_server.py [--port 8080] [--cylinders 4]

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

_SIG_FREQ_HZ = 10.0   # 10 Hz → 1200 RPM (4-stroke: 120 000 / 100 ms)
_SIG_MID_KPA = 70.0   # midpoint vacuum
_SIG_AMP_KPA = 30.0   # half-range → 40–100 kPa at reference channel
_RPM         = 1200
_IMBALANCE   = 0.05   # extra amplitude per channel beyond reference


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class State:
    def __init__(self, num_cylinders: int) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.running: bool = False
        self.num_cylinders: int = num_cylinders
        self.settings: dict = {
            "cylinder_count":        num_cylinders,
            "reference_cylinder":    0,
            "damping":               8,
            "rpm_damping":           10,
            "update_interval_ms":    100,
            "ap_ssid":               "CarbBalancer",
            "ap_password":           "balance1",
        }


# ---------------------------------------------------------------------------
# Signal generation
# ---------------------------------------------------------------------------

def _generate(state: State) -> str:
    t   = time.monotonic()
    ref = 0

    kpa_values: list[float] = []
    for ch in range(state.num_cylinders):
        phase = 2.0 * math.pi * _SIG_FREQ_HZ * t + (math.pi / 2.0) * ch
        amp   = _SIG_AMP_KPA * (1.0 + _IMBALANCE * ch)
        kpa_values.append(round(_SIG_MID_KPA + amp * math.sin(phase), 1))

    ref_kpa = kpa_values[ref]
    cylinders = [
        {"kpa": kpa, "delta_kpa": 0.0 if ch == ref else round(kpa - ref_kpa, 2)}
        for ch, kpa in enumerate(kpa_values)
    ]

    return json.dumps({"rpm": _RPM, "ref": ref, "cylinders": cylinders})


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
        if state.running and state.clients:
            await _broadcast(state, _generate(state))
        await asyncio.sleep(0.1)  # 100 ms → 10 Hz


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
    _SETTINGS_KEYS = (
        "cylinder_count", "reference_cylinder", "damping",
        "rpm_damping",
        "update_interval_ms", "ap_ssid", "ap_password",
    )
    for key in _SETTINGS_KEYS:
        if key in data:
            state.settings[key] = data[key]
    state.num_cylinders = state.settings["cylinder_count"]
    return web.json_response({"ok": True})


async def handle_index(request: web.Request) -> web.Response:
    html = (ROOT / "web" / "index.html").read_text()
    return web.Response(text=html, content_type="text/html")


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
                if cmd.get("cmd") == "start":
                    state.running = True
                elif cmd.get("cmd") == "stop":
                    state.running = False
                elif cmd.get("cmd") == "get_settings":
                    payload = {"type": "settings", **state.settings}
                    await ws.send_str(json.dumps(payload))
                elif cmd.get("cmd") == "set_settings":
                    _SETTINGS_KEYS = (
                        "cylinder_count", "reference_cylinder", "damping",
                        "rpm_damping",
                        "update_interval_ms", "ap_ssid", "ap_password",
                    )
                    for key in _SETTINGS_KEYS:
                        if key in cmd:
                            state.settings[key] = cmd[key]
                    state.num_cylinders = state.settings["cylinder_count"]
                    await ws.send_str(json.dumps({"type": "settings_saved"}))
                # "serial" command is a no-op in the mock
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
    parser.add_argument("--port",      type=int, default=PORT,
                        help="HTTP / WebSocket port (default: 8080)")
    parser.add_argument("--cylinders", type=int, default=4, choices=[1, 2, 3, 4],
                        help="Number of simulated cylinders (default: 4)")
    args = parser.parse_args()

    state     = State(args.cylinders)
    app       = web.Application()
    app["state"] = state
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/",              handle_index)
    app.router.add_get("/ws",            handle_ws)
    app.router.add_get("/api/settings",  handle_api_settings_get)
    app.router.add_post("/api/settings", handle_api_settings_post)

    print(f"Mock server  ->  http://localhost:{args.port}/")
    print("Open the URL above, click Start, and watch the live data.")
    print("Press Ctrl-C to stop.")
    web.run_app(app, host="localhost", port=args.port, print=lambda *_: None)


if __name__ == "__main__":
    main()
