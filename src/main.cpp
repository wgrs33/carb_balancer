#include "CarbBalancer.h"
#include "Frames.h"
#include "Settings.h"
#include "SPSCQueue.h"
#include "WebServerManager.h"

#include <memory>

SPSCQueue<RawFrame, 256> adc_sample_queue[kMaxCylinders];
SPSCQueue<CommandFrame, 4> command_queue;

Settings settings;
std::unique_ptr<CarbBalancer> app;
std::unique_ptr<WebServerManager> web_server;

void webServerTask(void *pvParameters) {
    web_server->begin();
    web_server->setOnStart([]() {
        CommandFrame frame;
        frame.cmd = Command::StartMeasurement;
        command_queue.push(frame); // send command to start ADC
        Serial.println("Command: StartMeasurement");
    });

    web_server->setOnStop([]() {
        CommandFrame frame;
        frame.cmd = Command::StopMeasurement;
        command_queue.push(frame); // send command to stop ADC
        Serial.println("Command: StopMeasurement");
    });

    web_server->setOnSettingsUpdate([](SettingsFrame& data) {
        CommandFrame frame;
        frame.cmd = Command::UpdateSettings;
        frame.params.settings = data;
        command_queue.push(frame);
    });

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void carbTask(void *pvParameters) {
    app->begin();

    app->setOnRawFrame([](uint8_t channel, const RawFrame& frame) {
        adc_sample_queue[channel].push(frame);
    });

    for (;;) {
        app->update();
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

void setup() {
    Serial.begin(115200);
    // USB CDC needs time to re-enumerate after reset before prints are visible
    uint32_t t = millis();
    while (!Serial && (millis() - t) < 3000) { delay(10); }

    esp_reset_reason_t reason = esp_reset_reason();
    Serial.printf("[boot] reset reason: %d\n", (int)reason);

    settings.begin();
    Serial.println("[boot] Settings loaded");

    app = std::make_unique<CarbBalancer>(settings, command_queue);
    web_server = std::make_unique<WebServerManager>(settings, adc_sample_queue);

    xTaskCreatePinnedToCore(webServerTask, "WebServer",    8192, NULL, 1, NULL, 0);
    xTaskCreatePinnedToCore(carbTask,      "CarbBalancer", 4096, NULL, 2, NULL, 1);
}

void loop() {
}
