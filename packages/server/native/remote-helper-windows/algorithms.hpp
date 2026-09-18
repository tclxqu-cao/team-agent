#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace remote {
inline std::pair<int, int> dimensions(int width, int height, const std::string& quality) {
    if (width < 2 || height < 2 || width > 16384 || height > 16384) throw std::runtime_error("Invalid screen dimensions");
    if (quality != "smooth" && quality != "hd" && quality != "original") throw std::runtime_error("Unknown quality");
    const int limit = quality == "smooth" ? 1280 : quality == "hd" ? 2560 : 16384;
    const double scale = std::min(1.0, double(limit) / std::max(width, height));
    return {std::max(2, int(width * scale) & ~1), std::max(2, int(height * scale) & ~1)};
}
inline int absoluteCoordinate(double value, int origin, int extent) {
    if (!std::isfinite(value) || extent < 2) throw std::runtime_error("Invalid pointer coordinate");
    return int(std::round(std::clamp((value - origin) / (extent - 1), 0.0, 1.0) * 65535));
}
inline std::string base64(const uint8_t* data, size_t size) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result; result.reserve((size + 2) / 3 * 4);
    for (size_t i = 0; i < size; i += 3) {
        uint32_t n = uint32_t(data[i]) << 16;
        if (i + 1 < size) n |= uint32_t(data[i + 1]) << 8;
        if (i + 2 < size) n |= data[i + 2];
        result += alphabet[n >> 18]; result += alphabet[(n >> 12) & 63];
        result += i + 1 < size ? alphabet[(n >> 6) & 63] : '=';
        result += i + 2 < size ? alphabet[n & 63] : '=';
    }
    return result;
}
inline std::vector<std::vector<uint8_t>> annexBNals(const uint8_t* bytes, size_t size) {
    std::vector<std::vector<uint8_t>> result;
    size_t start = size;
    for (size_t i = 0; i + 2 < size;) {
        size_t prefix = 0;
        if (bytes[i] == 0 && bytes[i + 1] == 0) {
            if (bytes[i + 2] == 1) prefix = 3;
            else if (i + 3 < size && bytes[i + 2] == 0 && bytes[i + 3] == 1) prefix = 4;
        }
        if (!prefix) { ++i; continue; }
        if (start < i) result.emplace_back(bytes + start, bytes + i);
        start = i + prefix; i = start;
    }
    if (start < size) result.emplace_back(bytes + start, bytes + size);
    if (result.empty() && size) throw std::runtime_error("Encoder did not produce Annex B H264");
    return result;
}
// Rotation is applied before any scaling; all input coordinates use desktop pixels.
inline std::pair<int, int> sourcePixel(int x, int y, int sourceWidth, int sourceHeight, int rotation) {
    switch (rotation) {
    case 90: return {y, sourceHeight - 1 - x};
    case 180: return {sourceWidth - 1 - x, sourceHeight - 1 - y};
    case 270: return {sourceWidth - 1 - y, x};
    default: return {x, y};
    }
}
inline void algorithmSelfTest() {
    auto require = [](bool ok) { if (!ok) throw std::runtime_error("Algorithm self-test failed"); };
    require(dimensions(3840, 2160, "hd") == std::make_pair(2560, 1440));
    require(dimensions(1440, 2560, "smooth") == std::make_pair(720, 1280));
    require(dimensions(1024, 768, "hd") == std::make_pair(1024, 768));
    require(absoluteCoordinate(-1920, -1920, 3840) == 0);
    require(absoluteCoordinate(1919, -1920, 3840) == 65535);
    require(absoluteCoordinate(-9999, -1920, 3840) == 0);
    require(sourcePixel(0, 0, 3, 2, 90) == std::make_pair(0, 1));
    require(sourcePixel(1, 2, 3, 2, 90) == std::make_pair(2, 0));
    require(sourcePixel(0, 0, 3, 2, 270) == std::make_pair(2, 0));
    const uint8_t sample[] = {0, 0, 0, 1, 0x67, 2, 0, 0, 1, 0x65, 3};
    auto nals = annexBNals(sample, sizeof(sample));
    require(nals.size() == 2 && nals[0][0] == 0x67 && nals[1][0] == 0x65);
    require(base64(reinterpret_cast<const uint8_t*>("foo"), 3) == "Zm9v");
}
}
