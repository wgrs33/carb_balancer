#pragma once

#include <Arduino.h>

#include "Frames.h"

static constexpr uint8_t kMaxCylinders = 4;

/**
 * @brief Manages WiFi AP credentials (NVS) and per-session runtime settings (RAM).
 *
 * Only WiFi credentials are persisted to NVS. All other settings (channel_mask,
 * reference_channel, update_interval_ms) are session-only: applied when the browser
 * connects and forgotten on disconnect.
 *
 * Calibration tables are stored in NVS for future use.
 */
class Settings {
public:
    static constexpr uint16_t kCalTableSize = 256;

    Settings();

    Settings(Settings& other) {
        data_ = other.data_;
        setApSsid(other.data().ap_ssid);
        setApPassword(other.data().ap_password);
    }

    void operator=(Settings& other) {
        data_ = other.data_;
        setApSsid(other.data().ap_ssid);
        setApPassword(other.data().ap_password);
    }

    /** @brief Load WiFi credentials and calibration tables from NVS. */
    void begin();

    /** @brief Persist WiFi credentials and calibration tables to NVS. */
    void save();

    /** @brief Persist only the calibration table for one channel (called after calibration). */
    void saveCalTable(uint8_t channel);

    // --- channel config ---
    uint8_t channelMask() const { return data_.channel_mask; }
    /** @brief Set active channels. Mask must have at least one bit set in [0:3].
     *  If the current reference channel is no longer active, resets to the lowest active channel. */
    void setChannelMask(uint8_t mask);

    /** @brief Set reference channel. Index must be set in channel_mask. */
    void setReferenceChannel(uint8_t index);

    // --- calibration table ---
    /** @brief Get calibration correction for a channel at ADC bin index (0..255). */
    int16_t calEntry(uint8_t channel, uint8_t index) const;
    void setCalEntry(uint8_t channel, uint8_t index, int16_t value);
    void clearCalTable(uint8_t channel);

    // --- broadcast ---
    void setUpdateIntervalMs(uint32_t ms);

    // --- WiFi AP ---
    void setApSsid(const String& ssid);

    void setApPassword(const String& password);

    SettingsFrame& data() { return data_; }

private:
    SettingsFrame data_;
    int16_t  cal_tables_[kMaxCylinders][kCalTableSize];  // 4 × 256 × 2 = 2 KB RAM

    void applyDefaults();
};
