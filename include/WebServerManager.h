#pragma once

#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <functional>
#include <esp_timer.h>

#include "AdcReader.h"
#include "Frames.h"
#include "LedController.h"
#include "SPSCQueue.h"

/**
 * @brief Sets up the WiFi AP, HTTP routes, and WebSocket for live data push.
 *
 * Commands received from the web UI (JSON over WebSocket):
 *   {"cmd":"start"}                  → onStart callback
 *   {"cmd":"stop"}                   → onStop callback
 *   {"cmd":"calibrate","channel":N}  → onCalibrate(channel) callback
 *   {"cmd":"cal_stop"}               → onCalStop callback
 *   {"cmd":"cal_clear","channel":N}  → onCalClear(channel) callback
 *   {"cmd":"serial","enabled":bool}  → onSerialToggle(enabled) callback
 *
 * Callbacks are registered by CarbBalancer in begin() to avoid circular dependencies.
 */
class WebServerManager {
public:
    WebServerManager(Settings& settings, SPSCQueue<RawFrame, 256> (&adc_sample_queue)[kMaxCylinders]);

    void begin();

    /** @brief Send a batch of pre-EMA waveform samples to all clients. */
    void broadcastData();

    void update(); // called periodically by timer to push data to clients

    // --- callback registration ---
    void setOnStart(std::function<void()> cb)                   { on_start_ = cb; }
    void setOnStop(std::function<void()> cb)                    { on_stop_ = cb; }
    void setOnSettingsUpdate(std::function<void(SettingsFrame&)> cb) { on_settings_update_ = cb; }

private:
    SettingsFrame   settings_frame_;
    AsyncWebServer  server_;
    AsyncWebSocket  ws_;

    SPSCQueue<RawFrame, 256> (&adc_sample_queue_)[kMaxCylinders];
    esp_timer_handle_t webui_timer_ = nullptr; //< Periodic timer driving data push at 10Hz

    std::function<void()>          on_start_;
    std::function<void()>          on_stop_;
    std::function<void(SettingsFrame&)> on_settings_update_;

    void setupWifi();
    void setupRoutes();
    void buildSettingsJson(JsonDocument& doc);
    void applySettingsDoc(const JsonDocument& doc);
    void handleCommand(const JsonDocument& doc, AsyncWebSocketClient* client);
    void onWebSocketEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
                          AwsEventType type, void* arg, uint8_t* data, size_t len);
};
