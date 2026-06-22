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
 * Delivers raw ADC samples to the on_sample_ callback with no processing applied.
 * All signal processing (EMA, RPM detection, unit conversion) is done in the Web UI.
 *
 * ISR sets a flag only — I2C reads happen in update() (main loop context).
 */
class AdcReader {
public:
    using SampleCallback = std::function<void(uint8_t channel, const RawFrame& frame)>;

    /**
     * @param settings  Application settings (channel_mask is read on each start()).
     * @param rdy_pin   GPIO connected to ADS1115 ALRT/RDY (active-low).
     */
    explicit AdcReader(const Settings& settings, uint8_t rdy_pin);

    /** @brief Initialise I2C and configure ADS1115. */
    bool begin();

    /** @brief Check if the ADC reader is running. */
    bool isRunning() const;

    /** @brief Start ADC conversions. Cycles through set bits in channel_mask. */
    void start(uint8_t channel_mask);

    /** @brief Stop ADC conversions. */
    void stop();

    /** @brief Register callback invoked from update() for each completed sample. */
    void setOnSample(SampleCallback cb) { on_sample_ = cb; }

    /** @brief Called by the ALRT/RDY ISR — captures timestamp and sets flag, no I2C. */
    void onConversionReady();

    /** @brief Call from the main loop — reads result via I2C, fires callback with raw value. */
    void update();

    /** @brief Start an ADC conversion on the current channel. */
    void startConversion();

private:
    Adafruit_ADS1115 ads_;
    uint8_t          rdy_pin_;
    uint8_t          channel_mask_;
    bool             running_;
    uint8_t          current_adc_channel_;

    std::atomic<bool>     conversion_ready_{false};
    std::atomic<uint32_t> conversion_timestamp_us_{0};

    SampleCallback on_sample_;
};
