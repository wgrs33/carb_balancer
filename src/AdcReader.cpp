#include "AdcReader.h"

static AdcReader* g_adc_instance = nullptr;
static void IRAM_ATTR adcRdyISR() {
    if (g_adc_instance) g_adc_instance->onConversionReady();
}

AdcReader::AdcReader(const Settings& settings, uint8_t rdy_pin)
    : rdy_pin_(rdy_pin),
      channel_mask_(0x0F),
      running_(false),
      current_adc_channel_(0) {}

bool AdcReader::begin() {
    if (!ads_.begin()) return false;

    ads_.setDataRate(RATE_ADS1115_860SPS);
    ads_.setGain(GAIN_ONE);  // ±4.096 V range — safe for 3.3 V signals

    ads_.configureDataReady();
    pinMode(rdy_pin_, INPUT);
    g_adc_instance = this;
    attachInterrupt(digitalPinToInterrupt(rdy_pin_), adcRdyISR, FALLING);

    return true;
}

bool AdcReader::isRunning() const {
    return running_;
}

void AdcReader::start(uint8_t channel_mask) {
    channel_mask_ = channel_mask & 0x0F;
    if (channel_mask_ == 0) channel_mask_ = 0x0F; // fallback: all channels
    for (uint8_t i = 0; i < kMaxCylinders; i++) {
        if (channel_mask_ & (1 << i)) { current_adc_channel_ = i; break; }
    }
    conversion_ready_.store(false, std::memory_order_relaxed);
    running_ = true;
}

void AdcReader::stop() {
    conversion_ready_.store(false, std::memory_order_relaxed);
    running_ = false;
}

void AdcReader::onConversionReady() {
    // Store timestamp before setting the flag so update() always sees a valid value.
    conversion_timestamp_us_.store(micros(), std::memory_order_relaxed);
    conversion_ready_.store(true, std::memory_order_release);
}

void AdcReader::update() {
    if (!conversion_ready_.load(std::memory_order_acquire)) return;
    conversion_ready_.store(false, std::memory_order_relaxed);

    uint32_t ts  = conversion_timestamp_us_.load(std::memory_order_relaxed);
    int16_t  raw = ads_.getLastConversionResults();
    uint8_t  ch  = current_adc_channel_;

    if (on_sample_) {
        RawFrame frame{static_cast<uint16_t>(raw), ts};
        on_sample_(ch, frame);
    }

    for (uint8_t i = 0; i < kMaxCylinders; i++) {
        current_adc_channel_ = (current_adc_channel_ + 1) % kMaxCylinders;
        if (channel_mask_ & (1 << current_adc_channel_)) break;
    }
}

void AdcReader::startConversion() {
    // Sensor 1→AIN3, sensor 2→AIN2, sensor 3→AIN1, sensor 4→AIN0
    static constexpr uint16_t kMuxMap[kMaxCylinders] = {
        ADS1X15_REG_CONFIG_MUX_SINGLE_3,
        ADS1X15_REG_CONFIG_MUX_SINGLE_2,
        ADS1X15_REG_CONFIG_MUX_SINGLE_1,
        ADS1X15_REG_CONFIG_MUX_SINGLE_0,
    };
    ads_.startADCReading(kMuxMap[current_adc_channel_], /*continuous=*/false);
}
