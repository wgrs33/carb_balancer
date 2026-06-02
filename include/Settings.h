#pragma once

#include <Arduino.h>

#include "Frames.h"

static constexpr uint8_t kMaxCylinders = 4;

/**
 * @brief Manages all configurable settings and per-channel calibration tables with NVS persistence.
 *
 * Calibration model for each cylinder channel:
 *   - Master channel (reference_cylinder) is never calibrated — it is the reference standard.
 *   - Each non-master channel has a 256-entry int16_t lookup table.
 *   - Table index = raw_adc >> 7  (bin width ≈ 128 counts ≈ 1.2 kPa per bin).
 *   - Stored correction = master_adc - channel_adc, averaged across multiple samples at that bin.
 *   - Applied:  calibrated = raw + cal_table[channel][raw >> 7]
 *
 * EMA model for smoothing ADC readings:
 *   - Bit-shift factor (damping 0–16): ema_acc += (new_shifted - ema_acc) >> damping
 *   - damping=0 → no smoothing, damping=8 → α≈0.004 (default), damping=16 → extreme.
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

    /** @brief Load settings and calibration tables from NVS. Writes defaults on first boot. */
    void begin();

    /** @brief Persist all settings and calibration tables to NVS. */
    void save();

    /** @brief Persist only the calibration table for one channel (called after calibration). */
    void saveCalTable(uint8_t channel);

    // --- cylinder config ---
    uint8_t cylinderCount() const { return data_.cylinder_count; }
    void setCylinderCount(uint8_t count);

    void setReferenceCylinder(uint8_t index);

    // --- calibration table ---
    /** @brief Get calibration correction for a channel at ADC bin index (0..255). */
    int16_t calEntry(uint8_t channel, uint8_t index) const;
    void setCalEntry(uint8_t channel, uint8_t index, int16_t value);
    void clearCalTable(uint8_t channel);

    // --- EMA ---
    /** @brief Bit-shift damping factor (0–16). Higher = more smoothing. Default 8. */
    void setDamping(uint8_t factor);

    // --- broadcast ---
    void setUpdateIntervalMs(uint32_t ms);

    // --- WiFi AP ---
    void setApSsid(const String& ssid);

    void setApPassword(const String& password);

    void updateFromData(SettingsFrame& data);

    SettingsFrame& data() { return data_; }

private:
    SettingsFrame data_;
    int16_t  cal_tables_[kMaxCylinders][kCalTableSize];  // 4 × 256 × 2 = 2 KB RAM

    void applyDefaults();
};
