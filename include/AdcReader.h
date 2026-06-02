#pragma once

#include <Adafruit_ADS1X15.h>

#include "Frames.h"
#include "Settings.h"

#include <array>
#include <atomic>
#include <functional>

/**
 * @brief Drives the ADS1115 in single-shot mode, cycling through active channels.
 *
 * Signal processing per sample (channel):
 *   raw ADC
 *     → calibration lookup  (cal_table[channel][raw >> 7] added to raw)
 *     → EMA bit-shift       (ema_acc += (new - ema_acc) >> damping, 32-bit accumulator)
 *     → on_sample_ callback (delivers {value, timestamp_us} to the consumer)
 *
 * RPM detection on reference channel:
 *   Valley detection with hysteresis: kRpmHysteresis consecutive samples must confirm each
 *   direction change before a valley is recorded. A valley is accepted only when the
 *   peak-to-valley amplitude ≥ kRpmMinAmplitudeAdc (20 kPa) to reject noise and idle signals.
 *   Interval between accepted valleys → RPM.  window_ms = cycle_ms × (1 + margin/100)
 *
 * ADC → kPa (MPX4250AP + 12kΩ/20kΩ divider + ADS1115 GAIN_ONE):
 *   P_kPa = adc × 0.01 + 10.0
 *
 * ISR sets a flag only — I2C reads happen in update() (main loop context).
 */
class AdcReader {
public:
    static constexpr uint8_t kEmaShift = 1;  ///< EMA smoothing: alpha = 1/2^kEmaShift

    using SampleCallback = std::function<void(uint8_t channel, const RawFrame& frame)>;

    /**
     * @param settings  Application settings (cylinder count, cal tables, damping, margin).
     * @param rdy_pin   GPIO connected to ADS1115 ALRT/RDY (active-low).
     */
    explicit AdcReader(const Settings& settings, uint8_t rdy_pin, uint8_t channel_count = 4);

    /** @brief Initialise I2C and configure ADS1115. */
    bool begin();

    /** @brief Check if the ADC reader is running. */
    bool isRunning() const;

    /** @brief Start ADC conversions. Resets EMA accumulators. */
    void start();

    /** @brief Stop ADC conversions. */
    void stop();

    /** @brief Register callback invoked from update() for each completed sample. */
    void setOnSample(SampleCallback cb) { on_sample_ = cb; }

    /** @brief Called by the ALRT/RDY ISR — captures timestamp and sets flag, no I2C. */
    void onConversionReady();

    /** @brief Call from the main loop — reads result via I2C, applies EMA, fires callback. */
    void update();

    /** @brief Start an ADC conversion on the current channel. */
    void startConversion();

private:
    Adafruit_ADS1115 ads_;
    uint8_t          rdy_pin_;
    uint8_t          channel_count_;
    bool             running_;
    uint8_t          current_adc_channel_;

    std::atomic<bool>     conversion_ready_{false};
    std::atomic<uint32_t> conversion_timestamp_us_{0};

    uint32_t     ema_acc_[kMaxCylinders]{};
    SampleCallback on_sample_;
};
