#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include <optional>
#include <cstring>

namespace remote {
struct StaticVideoAdmission {
    double submittedAt = -1;
    bool shouldSubmit(bool changed, bool forced, double nowMs) const {
        return changed || forced || submittedAt < 0 || nowMs - submittedAt >= 1000;
    }
    void submitted(double nowMs) { submittedAt = nowMs; }
    void reset() { submittedAt = -1; }
};
struct PixelScrollCopy { int sourceX,sourceY,x,y,width,height; };
inline std::optional<PixelScrollCopy> findPixelScroll(const std::vector<uint8_t>& old,const std::vector<uint8_t>& next,int width,int height) {
    if(width<64||height<64||width>4096||height>4096||old.size()!=size_t(width)*height*4||old.size()!=next.size())return std::nullopt;
    auto score=[&](int dx,int dy){int matches=0,w=width-abs(dx),h=height-abs(dy),x0=std::max(0,dx),y0=std::max(0,dy);
        for(int r=1;r<=6;r++)for(int c=1;c<=8;c++){int x=x0+c*w/9,y=y0+r*h/7;
            matches+=memcmp(old.data()+(size_t(y-dy)*width+x-dx)*4,next.data()+(size_t(y)*width+x)*4,4)==0;}return matches;};
    int best=score(0,0),dx=0,dy=0;if(best>=46)return std::nullopt;
    for(int axis=0;axis<2;axis++){int radius=std::min(256,(axis?height:width)/2);for(int n=-radius;n<=radius;n++)if(n){int value=score(axis?0:n,axis?n:0);if(value>best){best=value;dx=axis?0:n;dy=axis?n:0;}}}
    if(best!=48)return std::nullopt;
    int x=std::max(0,dx),y=std::max(0,dy),w=width-abs(dx),h=height-abs(dy);
    for(int row=y;row<y+h;row++)if(memcmp(old.data()+(size_t(row-dy)*width+x-dx)*4,next.data()+(size_t(row)*width+x)*4,size_t(w)*4))return std::nullopt;
    return PixelScrollCopy{x-dx,y-dy,x,y,w,h};
}
inline std::pair<int, int> dimensions(int width, int height, const std::string& quality, int maxEdge = 0) {
    if(maxEdge<0||(maxEdge>0&&(maxEdge<640||maxEdge>8192)))throw std::runtime_error("Invalid adaptive dimensions");
    if (width < 2 || height < 2 || width > 16384 || height > 16384) throw std::runtime_error("Invalid screen dimensions");
    if (quality != "smooth" && quality != "hd" && quality != "original") throw std::runtime_error("Unknown quality");
    const int limit = quality == "smooth" ? 1280 : quality == "hd" ? 2560 : 16384;
    const double scale = std::min(1.0, double(maxEdge>0?std::min(limit,maxEdge):limit) / std::max(width, height));
    return {std::max(2, int(width * scale) & ~1), std::max(2, int(height * scale) & ~1)};
}
inline std::pair<int,int> adaptiveVideoDimensions(int width,int height,const std::string& quality,int maxEdge) {
    return dimensions(width,height,quality,maxEdge);
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
