#include "WebServerManager.h"

#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <WiFi.h>

#include "WebUI.h"
#include "WebCSS.h"
#include "WebJS.h"

#include <array>

WebServerManager::WebServerManager(Settings& settings, SPSCQueue<RawFrame, 256> (&adc_sample_queue)[kMaxCylinders])
    : settings_(settings),
      settings_frame_(settings.data()),
      server_(80), ws_("/ws"),
      adc_sample_queue_(adc_sample_queue) {}

void WebServerManager::begin() {
    setupWifi();

    ws_.onEvent([this](AsyncWebSocket* s, AsyncWebSocketClient* c,
                       AwsEventType t, void* a, uint8_t* d, size_t l) {
        onWebSocketEvent(s, c, t, a, d, l);
    });
    server_.addHandler(&ws_);

    esp_timer_create_args_t timer_args = {};
    timer_args.callback        = [](void* arg) {
        static_cast<WebServerManager*>(arg)->update();
    };
    timer_args.arg             = this;
    timer_args.dispatch_method = ESP_TIMER_TASK;
    timer_args.name            = "webui_push";
    esp_timer_create(&timer_args, &webui_timer_);

    setupRoutes();
    server_.begin();
    Serial.println("[web] Web server started");
    esp_timer_start_periodic(webui_timer_, settings_frame_.update_interval_ms * 1'000);
}

void WebServerManager::update() {
    broadcastData();
}

void WebServerManager::broadcastData() {
    ws_.cleanupClients();
    if (ws_.count() == 0) return;

    static std::array<RawFrame, 64> samples;  // cap at 64 — avoids oversized messages
    static char buf[3072];
    const uint8_t mask = settings_frame_.channel_mask;
    const uint8_t ref  = settings_frame_.reference_channel;

    JsonDocument doc;
    doc["type"] = "wave";

    uint32_t t0 = 0, dt = 5;
    JsonArray chs = doc["chs"].to<JsonArray>();
    for (uint8_t ch = 0; ch < kMaxCylinders; ch++) {
        if (!(mask & (1 << ch))) {
            chs.add(nullptr);
            continue;
        }
        auto n = adc_sample_queue_[ch].read_n(samples.data(), samples.size());
        if (n == 0) {
            chs.add(nullptr);
            continue;
        }
        if (ch == ref) {
            t0 = samples[0].timestamp_us;
            dt = n > 1 ? (samples[n - 1].timestamp_us - samples[0].timestamp_us) / (n - 1) : 0;
        }
        JsonArray arr = chs.add<JsonArray>();
        for (size_t i = 0; i < n; i++) arr.add(samples[i].value);
    }
    doc["t0"] = t0;
    doc["dt"] = dt;

    size_t len = serializeJson(doc, buf, sizeof(buf));
    ws_.textAll(buf, len);
}

void WebServerManager::setupWifi() {
    WiFi.softAP(settings_frame_.ap_ssid, settings_frame_.ap_password);
    Serial.print("[wifi] AP started: ");
    Serial.print(settings_frame_.ap_ssid);
    Serial.print("  IP: ");
    Serial.println(WiFi.softAPIP());

    if (MDNS.begin("carb")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("[mdns] carb.local registered");
    } else {
        Serial.println("[mdns] failed to start");
    }
}

void WebServerManager::setupRoutes() {
    server_.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send_P(200, "text/html", HTML);
    });

    server_.on("/styles.css", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send_P(200, "text/css", CSS);
    });

    server_.on("/script.js", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send_P(200, "application/javascript", JS);
    });
}

void WebServerManager::handleSetSession(const JsonDocument& doc) {

    if (!doc["channel_mask"].isNull()) {
        uint8_t mask = doc["channel_mask"].as<uint8_t>() & 0x0F;
        if (mask != 0) {
            settings_frame_.channel_mask = mask;
            if (!(mask & (1 << settings_frame_.reference_channel))) {
                for (uint8_t i = 0; i < kMaxCylinders; i++) {
                    if (mask & (1 << i)) { settings_frame_.reference_channel = i; break; }
                }
            }
        }
    }
    if (!doc["reference_channel"].isNull()) {
        uint8_t ref = doc["reference_channel"].as<uint8_t>();
        if (ref < kMaxCylinders && (settings_frame_.channel_mask & (1 << ref)))
            settings_frame_.reference_channel = ref;
    }
    if (!doc["update_interval_ms"].isNull()) {
        uint32_t ms = doc["update_interval_ms"].as<uint32_t>();
        if (ms >= 20) {
            esp_timer_stop(webui_timer_);
            settings_frame_.update_interval_ms = ms;
            esp_timer_start_periodic(webui_timer_, ms * 1'000);
        }
    }
}

void WebServerManager::handleGetWifi(AsyncWebSocketClient* client) {
    JsonDocument reply;
    reply["type"]        = "wifi";
    reply["ap_ssid"]     = settings_frame_.ap_ssid;
    reply["ap_password"] = settings_frame_.ap_password;
    String msg;
    serializeJson(reply, msg);
    if (client) client->text(msg);
}

void WebServerManager::handleSetWifi(const JsonDocument& doc) {
    if (!doc["ap_ssid"].isNull()) {
        String s = doc["ap_ssid"].as<String>();
        if (s.length() > 0 && s.length() <= 55)
            s.toCharArray(settings_frame_.ap_ssid, sizeof(settings_frame_.ap_ssid));
    }
    if (!doc["ap_password"].isNull()) {
        String s = doc["ap_password"].as<String>();
        if (s.length() >= 8 && s.length() <= 63)
            s.toCharArray(settings_frame_.ap_password, sizeof(settings_frame_.ap_password));
    }
    settings_.save();
    WiFi.softAP(settings_frame_.ap_ssid, settings_frame_.ap_password);

    JsonDocument ack;
    ack["type"] = "wifi_saved";
    String msg;
    serializeJson(ack, msg);
    ws_.textAll(msg);
}

void WebServerManager::handleCommand(const JsonDocument& doc, AsyncWebSocketClient* client) {
    const char* cmd = doc["cmd"] | "";

    if (strcmp(cmd, "start") == 0) {
        if (on_start_) on_start_();
    } else if (strcmp(cmd, "stop") == 0) {
        if (on_stop_) on_stop_();
        for (uint8_t ch = 0; ch < kMaxCylinders; ch++) adc_sample_queue_[ch].clear();
    } else if (strcmp(cmd, "set_session") == 0) {
        handleSetSession(doc);
    } else if (strcmp(cmd, "get_wifi") == 0) {
        handleGetWifi(client);
    } else if (strcmp(cmd, "set_wifi") == 0) {
        handleSetWifi(doc);
    }
}

void WebServerManager::onWebSocketEvent(AsyncWebSocket* /*server*/,
                                         AsyncWebSocketClient* client,
                                         AwsEventType type, void* /*arg*/,
                                         uint8_t* data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.print("[ws] client connected: ");
        Serial.println(client->remoteIP().toString());
        return;
    }
    if (type == WS_EVT_DISCONNECT) {
        Serial.println("[ws] client disconnected");
        if (on_stop_) on_stop_();
        for (uint8_t ch = 0; ch < kMaxCylinders; ch++) adc_sample_queue_[ch].clear();
        return;
    }
    if (type != WS_EVT_DATA || !data || len == 0) return;

    JsonDocument doc;
    if (deserializeJson(doc, data, len) != DeserializationError::Ok) return;

    handleCommand(doc, client);
}