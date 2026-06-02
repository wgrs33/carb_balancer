#pragma once

#include <atomic>
#include <stddef.h>

template<typename T, size_t N>
class SPSCQueue {
    static_assert((N & (N - 1)) == 0, "N must be a power of 2");
    static constexpr size_t MASK = N - 1;

    T _buf[N];

    // Ensure head and tail are on separate cache lines to avoid false sharing
    alignas(32) std::atomic<size_t> _head{0};  // written by producer only
    alignas(32) std::atomic<size_t> _tail{0};  // written by consumer only

public:
    // Called from PRODUCER core only
    bool push(const T& item) {
        // Relaxed: only the producer writes _head, so no race reading it
        size_t head = _head.load(std::memory_order_relaxed);
        size_t next = (head + 1) & MASK;

        // Acquire: sync with consumer's release store to _tail
        if (next == _tail.load(std::memory_order_acquire)) {
            return false;  // full
        }

        _buf[head] = item;

        // Release: makes the buffer write visible before _head advances
        _head.store(next, std::memory_order_release);
        return true;
    }

    // Called from CONSUMER core only
    bool pop(T& item) {
        size_t tail = _tail.load(std::memory_order_relaxed);

        // Acquire: sync with producer's release store to _head
        if (tail == _head.load(std::memory_order_acquire)) {
            return false;  // empty
        }

        item = _buf[tail];

        // Release: makes the buffer read visible before _tail advances
        _tail.store((tail + 1) & MASK, std::memory_order_release);
        return true;
    }

    bool isEmpty() const {
        return _head.load(std::memory_order_acquire) ==
               _tail.load(std::memory_order_acquire);
    }

    size_t size() const {
        size_t h = _head.load(std::memory_order_acquire);
        size_t t = _tail.load(std::memory_order_acquire);
        return (h - t + N) & MASK;
    }

    size_t read_n(T* out, size_t max_items) {
        size_t count = 0;
        while (count < max_items) {
            T item;
            if (!pop(item)) break;
            out[count++] = item;
        }
        return count;
    }

    void clear() {
        // Reset head and tail to empty the queue
        _head.store(0, std::memory_order_release);
        _tail.store(0, std::memory_order_release);
    }
};