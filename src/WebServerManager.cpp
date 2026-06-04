#include "WebServerManager.h"

#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <WiFi.h>

#include "WebUI.h"
#include "WebCSS.h"
#include "WebJS.h"

#include <array>

WebServerManager::WebServerManager(Settings& settings, SPSCQueue<RawFrame, 256> (&adc_sample_queue)[kMaxCylinders])
    : settings_frame_(settings.data()),
      server_(80), ws_("/ws"),
      adc_sample_queue_(adc_sample_queue) {}

void WebServerManager::begin() {
    setupWifi();

    ws_.onEvent([this](AsyncWebSocket* s, AsyncWebSocketClient* c,
                       AwsEventType t, void* a, uint8_t* d, size_t l) {
        onWebSocketEvent(s, c, t, a, d, l);
    });
    server_.addHandler(&ws_);
    Serial.println("[web] Web server started");

    esp_timer_create_args_t timer_args = {};
    timer_args.callback        = [](void* arg) {
        WebServerManager* manager = static_cast<WebServerManager*>(arg);
        manager->update();
    };
    timer_args.arg             = this;
    timer_args.dispatch_method = ESP_TIMER_TASK;
    timer_args.name            = "webui_push";
    esp_timer_create(&timer_args, &webui_timer_);

    setupRoutes();
    server_.begin();
    esp_timer_start_periodic(webui_timer_, settings_frame_.update_interval_ms * 1'000);
}

void WebServerManager::update() {
    broadcastData();
}

void WebServerManager::broadcastData() {
    if (ws_.count() == 0) return;

    static std::array<RawFrame, 256> samples;
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
        for (uint8_t i = 0; i < n; i++) {
            arr.add(samples[i].value);
        }
    }
    doc["t0"] = t0;
    doc["dt"] = dt;

    String msg;
    serializeJson(doc, msg);
    ws_.textAll(msg);
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

void WebServerManager::buildSettingsJson(JsonDocument& doc) {
    doc["channel_mask"]          = settings_frame_.channel_mask;
    doc["reference_channel"]     = settings_frame_.reference_channel;
    doc["damping"]               = settings_frame_.damping;
    doc["update_interval_ms"]    = settings_frame_.update_interval_ms;
    doc["ap_ssid"]               = settings_frame_.ap_ssid;
    doc["ap_password"]           = settings_frame_.ap_password;
}

void WebServerManager::applySettingsDoc(const JsonDocument& doc) {
    if (!doc["channel_mask"].isNull()) {
        uint8_t mask = doc["channel_mask"].as<uint8_t>() & 0x0F;
        if (mask != 0) settings_frame_.channel_mask = mask;
    }
    if (!doc["reference_channel"].isNull()) {
        uint8_t ref = doc["reference_channel"].as<uint8_t>();
        if (ref < kMaxCylinders && (settings_frame_.channel_mask & (1 << ref)))
            settings_frame_.reference_channel = ref;
    }
    if (!doc["damping"].isNull())
        settings_frame_.damping = doc["damping"].as<uint8_t>();
    if (!doc["update_interval_ms"].isNull())
        esp_timer_stop(webui_timer_);
        settings_frame_.update_interval_ms = doc["update_interval_ms"].as<uint32_t>();
        esp_timer_start_periodic(webui_timer_, settings_frame_.update_interval_ms * 1'000);
    if (!doc["ap_ssid"].isNull()) {
        String s = doc["ap_ssid"].as<String>();
        const auto max_len = sizeof(settings_frame_.ap_ssid) - 1;
        if (s.length() > 0 && s.length() <= 55) s.toCharArray(settings_frame_.ap_ssid, max_len);
    }
    if (!doc["ap_password"].isNull()) {
        String s = doc["ap_password"].as<String>();
        const auto max_len = sizeof(settings_frame_.ap_password) - 1;
        if (s.length() >= 8 && s.length() <= 63) s.toCharArray(settings_frame_.ap_password, max_len);
    }
    WiFi.softAP(settings_frame_.ap_ssid, settings_frame_.ap_password);
    on_settings_update_(settings_frame_);
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

    server_.on("/api/settings", HTTP_GET, [this](AsyncWebServerRequest* request) {
        JsonDocument doc;
        buildSettingsJson(doc);
        String body;
        serializeJson(doc, body);
        request->send(200, "application/json", body);
    });

    server_.on("/api/settings", HTTP_POST,
        [](AsyncWebServerRequest* request) {
            request->send(200, "application/json", "{\"ok\":true}");
        },
        nullptr,
        [this](AsyncWebServerRequest* /*request*/, uint8_t* data, size_t len,
               size_t index, size_t total) {
            if (index == 0 && len == total) {
                JsonDocument doc;
                if (deserializeJson(doc, data, len) == DeserializationError::Ok)
                    applySettingsDoc(doc);
            }
        }
    );
}

void WebServerManager::handleCommand(const JsonDocument& doc, AsyncWebSocketClient* client) {
    const char* cmd = doc["cmd"] | "";

    if (strcmp(cmd, "start") == 0) {
        Serial.println("Calling on_start");
        if (on_start_) on_start_();
        Serial.println("Called on_start");
    } else if (strcmp(cmd, "stop") == 0) {
        Serial.println("Calling on_stop");
        if (on_stop_) on_stop_();
        Serial.println("Called on_stop");
        for (uint8_t ch = 0; ch < kMaxCylinders; ch++) {
            adc_sample_queue_[ch].clear();
        }
        Serial.println("Buffers cleared");
    } else if (strcmp(cmd, "get_settings") == 0) {
        JsonDocument reply;
        reply["type"] = "settings";
        buildSettingsJson(reply);
        String msg;
        serializeJson(reply, msg);
        if (client) client->text(msg);
    } else if (strcmp(cmd, "set_settings") == 0) {
        applySettingsDoc(doc);
        JsonDocument ack;
        ack["type"] = "settings_saved";
        String msg;
        serializeJson(ack, msg);
        ws_.textAll(msg);
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
        return;
    }
    if (type != WS_EVT_DATA || !data || len == 0) return;

    JsonDocument doc;
    if (deserializeJson(doc, data, len) != DeserializationError::Ok) return;

    handleCommand(doc, client);
}
