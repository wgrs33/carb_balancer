#pragma once

#include <Arduino.h>
#include <esp_timer.h>

/**
 * @brief Controls the LED state to indicate system status:
 * kIdle       → solid ON
 * kMeasuring  → slow blink (500 ms)
 * kError      → fast blink (150 ms)
 */
class LedController {
public:
    enum class State { kIdle, kMeasuring, kError };

    explicit LedController(uint8_t led_pin);

    void begin();
    void setState(State state);

private:
    static constexpr uint32_t kSlowBlinkUs = 500'000;
    static constexpr uint32_t kFastBlinkUs = 150'000;

    static void timerCb(void* arg);

    uint8_t            led_pin_;
    State              state_;
    bool               led_on_;
    esp_timer_handle_t timer_ = nullptr;
};
