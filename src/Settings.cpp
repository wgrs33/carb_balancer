#include "Settings.h"

#include <Preferences.h>

static constexpr uint8_t  kDefaultChannelMask       = 0x0F; // all four channels active
static constexpr uint8_t  kDefaultReferenceChannel  = 0;
static constexpr uint8_t  kDefaultDamping           = 8;
static constexpr uint32_t kDefaultUpdateIntervalMs  = 50;
static constexpr char     kDefaultApSsid[]           = "CarbBalancer";
static constexpr char     kDefaultApPassword[]       = "balance1";

static constexpr char kNvsNamespace[] = "carb";

Settings::Settings() {
    applyDefaults();
}

void Settings::begin() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, /*readOnly=*/true);
    if (!prefs.isKey("init")) {
        prefs.end();
        save();
        return;
    }
    data_.channel_mask          = prefs.getUChar("ch_mask",      kDefaultChannelMask);
    data_.reference_channel     = prefs.getUChar("ref_ch",       kDefaultReferenceChannel);
    data_.damping               = prefs.getUChar("damping",      kDefaultDamping);
    data_.update_interval_ms    = prefs.getULong("upd_interval", kDefaultUpdateIntervalMs);

    setApSsid(prefs.getString("ap_ssid",     kDefaultApSsid));
    setApPassword(prefs.getString("ap_pass", kDefaultApPassword));

    for (uint8_t ch = 0; ch < kMaxCylinders; ch++) {
        char key[16];
        snprintf(key, sizeof(key), "cal_%d", ch);
        size_t len = kCalTableSize * sizeof(int16_t);
        if (prefs.getBytesLength(key) == len) {
            prefs.getBytes(key, cal_tables_[ch], len);
        } else {
            memset(cal_tables_[ch], 0, len);
        }
    }
    prefs.end();
    Serial.println("Settings:");
    Serial.printf(" - channel_mask: 0x%02X\n", data_.channel_mask);
    Serial.printf(" - reference_channel: %hhu\n", data_.reference_channel);
    Serial.printf(" - update_interval_ms: %u\n", data_.update_interval_ms);
    Serial.printf(" - ap_ssid_: %s\n", data_.ap_ssid);
    Serial.printf(" - ap_password_: %s\n", data_.ap_password);
}

void Settings::save() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, /*readOnly=*/false);
    prefs.putUChar("init",        1);
    prefs.putUChar("ch_mask",     data_.channel_mask);
    prefs.putUChar("ref_ch",      data_.reference_channel);
    prefs.putUChar("damping",     data_.damping);
    prefs.putULong("upd_interval",data_.update_interval_ms);
    prefs.putString("ap_ssid",    data_.ap_ssid);
    prefs.putString("ap_pass",    data_.ap_password);
    for (uint8_t ch = 0; ch < kMaxCylinders; ch++) {
        char key[16];
        snprintf(key, sizeof(key), "cal_%d", ch);
        prefs.putBytes(key, cal_tables_[ch], kCalTableSize * sizeof(int16_t));
    }
    prefs.end();
}

void Settings::saveCalTable(uint8_t channel) {
    if (channel >= kMaxCylinders) return;
    Preferences prefs;
    prefs.begin(kNvsNamespace, /*readOnly=*/false);
    char key[16];
    snprintf(key, sizeof(key), "cal_%d", channel);
    prefs.putBytes(key, cal_tables_[channel], kCalTableSize * sizeof(int16_t));
    prefs.end();
}

void Settings::applyDefaults() {
    data_.channel_mask          = kDefaultChannelMask;
    data_.reference_channel     = kDefaultReferenceChannel;
    data_.damping               = kDefaultDamping;
    data_.update_interval_ms    = kDefaultUpdateIntervalMs;
    setApSsid(kDefaultApSsid);
    setApPassword(kDefaultApPassword);
    memset(cal_tables_, 0, sizeof(cal_tables_));
}

void Settings::setChannelMask(uint8_t mask) {
    uint8_t valid = mask & 0x0F;
    if (valid == 0) return;
    data_.channel_mask = valid;
}

void Settings::setReferenceChannel(uint8_t index) {
    if (index < kMaxCylinders && (data_.channel_mask & (1 << index)))
        data_.reference_channel = index;
}

int16_t Settings::calEntry(uint8_t channel, uint8_t index) const {
    if (channel >= kMaxCylinders) return 0;
    return cal_tables_[channel][index];
}

void Settings::setCalEntry(uint8_t channel, uint8_t index, int16_t value) {
    if (channel < kMaxCylinders) cal_tables_[channel][index] = value;
}

void Settings::clearCalTable(uint8_t channel) {
    if (channel < kMaxCylinders) memset(cal_tables_[channel], 0, kCalTableSize * sizeof(int16_t));
}

void Settings::setDamping(uint8_t factor) {
    data_.damping = (factor <= 16) ? factor : data_.damping;
}

void Settings::setUpdateIntervalMs(uint32_t ms) {
    data_.update_interval_ms = (ms >= 20) ? ms : data_.update_interval_ms;
}

void Settings::setApSsid(const String& ssid) {
    memset(data_.ap_ssid, '\0', sizeof(data_.ap_ssid));
    ssid.toCharArray(data_.ap_ssid, sizeof(data_.ap_ssid));
}

void Settings::setApPassword(const String& p) {
    memset(data_.ap_password, '\0', sizeof(data_.ap_password));
    p.toCharArray(data_.ap_password, sizeof(data_.ap_password));
}

void Settings::updateFromData(SettingsFrame& data) {
    data_ = data;
    save();
}
