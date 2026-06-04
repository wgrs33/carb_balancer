#pragma once

#include <cstdint>

struct SettingsFrame {
    uint8_t  channel_mask;      ///< Active channels bitmask (bits 0-3 map to AIN0-AIN3)
    uint8_t  reference_channel; ///< Reference channel index; must be a set bit in channel_mask
    uint8_t  damping;
    uint32_t update_interval_ms;
    char ap_ssid[56];
    char ap_password[64];
} __attribute__((packed));

enum class Command : uint8_t {
    StartMeasurement = 0x01,
    StopMeasurement  = 0x02,
    StartCalibration = 0x03,
    StopCalibration  = 0x04,
    ClearCalibration = 0x05,
    UpdateSettings   = 0x06,
    Unknown          = 0x07,
};

struct CommandFrame {
    Command cmd;
    uint8_t dummy[7];
    union {
        uint8_t channel;
        bool enabled;
        SettingsFrame settings;
    } params;
} __attribute__((packed));

struct RawFrame {
    uint16_t value;
    unsigned long timestamp_us;
} __attribute__((packed));
