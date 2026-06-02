#pragma once

#include "AdcReader.h"
#include "Frames.h"
#include "LedController.h"
#include "Settings.h"
#include "WebServerManager.h"

#include <esp_timer.h>

/**
 * @brief Top-level application class. Owns all subsystems and drives the main loop.
 *
 * Calibration state machine:
 *   Idle → startCalibration(ch) → Calibrating → stopCalibration() → Idle
 *   Each update() cycle in Calibrating state:
 *     correction = reading(ref) − reading(target)
 *     cal_acc[bin] += ((correction << kCalShift) − cal_acc[bin]) >> kCalFactor
 *   On stop: right-shift accumulators, save to Settings/NVS, notify web UI.
 */
class CarbBalancer {
public:
    CarbBalancer(Settings& settings, SPSCQueue<CommandFrame, 4>& command_queue);

    /** @brief Initialise all subsystems and register WebSocket command callbacks. */
    void begin();

    /** @brief Run one iteration of the main loop. Call from Arduino loop(). */
    void update();

    Settings& getSettings() { return settings_; }

    void setOnRawFrame(std::function<void(uint8_t channel, const RawFrame& frame)> cb) { on_raw_frame_ = cb; }

private:
    Settings&        settings_;
    AdcReader        adc_reader_;
    LedController    led_;
    esp_timer_handle_t adc_timer_ = nullptr; //< Periodic timer driving adc conversions at 800 Hz

    std::function<void(uint8_t channel, const RawFrame& frame)> on_raw_frame_;

    SPSCQueue<CommandFrame, 4>& command_queue_;

    void handleCommand(CommandFrame& frame);
};