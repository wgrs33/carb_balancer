#include "LedController.h"

LedController::LedController(uint8_t led_pin)
    : led_pin_(led_pin), state_(State::kIdle), led_on_(false) {}

void LedController::begin() {
    pinMode(led_pin_, OUTPUT);
    digitalWrite(led_pin_, LOW);
    led_on_ = true;

    esp_timer_create_args_t args = {};
    args.callback        = &LedController::timerCb;
    args.arg             = this;
    args.dispatch_method = ESP_TIMER_TASK;
    args.name            = "led_blink";
    esp_timer_create(&args, &timer_);
}

void LedController::setState(State state) {
    state_ = state;
    esp_timer_stop(timer_);

    if (state_ == State::kIdle) {
        led_on_ = true;
        digitalWrite(led_pin_, LOW);
        return;
    }

    uint32_t period_us = (state_ == State::kError) ? kFastBlinkUs : kSlowBlinkUs;
    esp_timer_start_periodic(timer_, period_us);
}

void LedController::timerCb(void* arg) {
    auto* self = static_cast<LedController*>(arg);
    self->led_on_ = !self->led_on_;
    digitalWrite(self->led_pin_, self->led_on_ ? LOW : HIGH);
}
