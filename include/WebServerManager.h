#pragma once

#include <ArduinoJson.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <functional>
#include <esp_timer.h>

#include "AdcReader.h"
#include "Frames.h"
#include "LedController.h"
#include "Settings.h"
#include "SPSCQueue.h"

/**
 * @brief Sets up the WiFi AP, HTTP routes, and WebSocket for live data push.
 *
 * Session lifecycle:
 *   - On connect:    browser sends set_session with channel_mask, reference_channel,
 *                    update_interval_ms (applied to RAM, not persisted).
 *   - On disconnect: ADC sampling is stopped automatically.
 *   - WiFi credentials are the only settings persisted to NVS, written only when
 *                    the browser explicitly sends set_wifi.
 *
 * WebSocket commands (browser → firmware):
 *   {"cmd":"start"}                                       → onStart callback
 *   {"cmd":"stop"}                                        → onStop callback
 *   {"cmd":"set_session","channel_mask":N,...}            → apply session settings to RAM
 *   {"cmd":"get_wifi"}                                    → reply with WiFi credentials
 *   {"cmd":"set_wifi","ap_ssid":"...","ap_password":"…"}  → save WiFi to NVS, reconfigure AP
 */
class WebServerManager {
public:
    WebServerManager(Settings& settings, SPSCQueue<RawFrame, 256> (&adc_sample_queue)[kMaxCylinders]);

    void begin();

    void broadcastData();

    void update();

    /// Services pending captive-portal DNS queries; call frequently from a task loop.
    void processDns() { dns_server_.processNextRequest(); }

    // --- callback registration ---
    void setOnStart(std::function<void()> cb) { on_start_ = cb; }
    void setOnStop(std::function<void()> cb)  { on_stop_  = cb; }

private:
    Settings&      settings_;
    SettingsFrame& settings_frame_;
    AsyncWebServer server_;
    AsyncWebSocket ws_;
    DNSServer      dns_server_;

    SPSCQueue<RawFrame, 256> (&adc_sample_queue_)[kMaxCylinders];
    esp_timer_handle_t webui_timer_ = nullptr;

    std::function<void()> on_start_;
    std::function<void()> on_stop_;

    void setupWifi();
    void setupRoutes();
    void handleSetSession(const JsonDocument& doc);
    void handleGetWifi(AsyncWebSocketClient* client);
    void handleSetWifi(const JsonDocument& doc);
    void handleCommand(const JsonDocument& doc, AsyncWebSocketClient* client);
    void onWebSocketEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
                          AwsEventType type, void* arg, uint8_t* data, size_t len);
};