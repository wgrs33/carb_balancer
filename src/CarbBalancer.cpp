#include "CarbBalancer.h"


static constexpr uint8_t kAdcRdyPin = A2;
static constexpr uint8_t kLedPin = 48;


CarbBalancer::CarbBalancer(Settings& settings, SPSCQueue<CommandFrame, 4>& command_queue)
    : settings_(settings),
      adc_reader_(settings_, kAdcRdyPin),
      led_(kLedPin),
      command_queue_(command_queue) {}

void CarbBalancer::begin() {
    Serial.println("[boot] CarbBalancer starting");

    led_.begin();
    led_.setState(LedController::State::kIdle);
    Serial.println("[boot] Led idle set");

    if (!adc_reader_.begin()) {
        Serial.println("[ERROR] ADS1115 not found — check wiring");
        led_.setState(LedController::State::kError);
        while (true) { delay(10); }
    }
    Serial.println("[boot] ADS1115 OK");

    esp_timer_create_args_t timer_args = {};
    timer_args.callback        = [](void* arg) {
        AdcReader* reader = static_cast<AdcReader*>(arg);
        reader->startConversion();
        reader->update();
    };
    timer_args.arg             = &adc_reader_;
    timer_args.dispatch_method = ESP_TIMER_TASK;
    timer_args.name            = "adc_conv";
    esp_timer_create(&timer_args, &adc_timer_);

    adc_reader_.setOnSample([this](uint8_t ch, const RawFrame& frame) {
        if (on_raw_frame_) on_raw_frame_(ch, frame);
    });

    Serial.println("[boot] ADC timer created");
}

void CarbBalancer::update() {
    static CommandFrame frame;
    if (command_queue_.pop(frame)) {
        handleCommand(frame);
    }
}

void CarbBalancer::handleCommand(CommandFrame& frame) {
    switch(frame.cmd) {
        case Command::StartMeasurement:
            adc_reader_.start();
            Serial.println("Adc started");
            led_.setState(LedController::State::kMeasuring);
            Serial.println("LED set");
            esp_timer_start_periodic(adc_timer_, 1250); // 800 Hz
            Serial.println("Timer started");
            break;
        case Command::StopMeasurement:
            esp_timer_stop(adc_timer_);
            Serial.println("Timer stopped");
            adc_reader_.stop();
            Serial.println("ADC stopped");
            led_.setState(LedController::State::kIdle);
            Serial.println("LED on idle");
            break;
        case Command::UpdateSettings:
            settings_.updateFromData(frame.params.settings);
            break;
        case Command::StartCalibration:
        case Command::StopCalibration:
        case Command::ClearCalibration:
        case Command::Unknown:
        default:
            break;
    }
}
