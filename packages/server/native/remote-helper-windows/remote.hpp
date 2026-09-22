#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <strmif.h>
#include <codecapi.h>
#include <wmcodecdsp.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmsystem.h>
#include <wrl/client.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include "algorithms.hpp"

namespace remote {
using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;
inline void check(HRESULT result, const char* operation) {
    if (FAILED(result)) throw std::runtime_error(std::string(operation) + " (HRESULT " + std::to_string(uint32_t(result)) + ")");
}
std::string utf8(const std::wstring& value);
std::wstring wide(const std::string& value);
bool desktopAvailable();
bool sessionLocked();
struct Frame { int width = 0, height = 0, x = 0, y = 0; std::vector<uint8_t> pixels; };
struct Display { std::string id; RECT bounds; bool primary; ComPtr<IDXGIAdapter1> adapter; ComPtr<IDXGIOutput1> output; };
class Capture {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIOutputDuplication> duplication;
    ComPtr<ID3D11Texture2D> staging;
    Frame cached;
    std::string selected;
    DXGI_MODE_ROTATION rotation = DXGI_MODE_ROTATION_IDENTITY;
    bool separateCursor = false;
    void open(const Display& display);
public:
    std::vector<Display> displays();
    Json displayList();
    void select(const std::string& id);
    void reset();
    Frame frame();
    Json preview(const Frame& frame, const std::string& quality);
};
class VideoEncoder {
    ComPtr<IMFTransform> transform;
    ComPtr<ICodecAPI> codec;
    int width = 0, height = 0;
    std::string quality;
    LONGLONG timestamp = 0;
    std::vector<std::vector<uint8_t>> parameterSets;
    void open(int w, int h, const std::string& q);
public:
    void reset();
    Json encode(const Frame& frame, const std::string& q, bool keyframe);
};
class Input {
    std::set<WORD> heldKeys;
    std::set<std::string> heldButtons;
    void key(WORD code, bool up);
    void button(const std::string& name, bool up);
public:
    void release();
    Json command(const Json& command);
};
/** Lock / wake / display keep-alive. Power requests live on a dedicated
 *  thread because SetThreadExecutionState(ES_CONTINUOUS) is per-thread, and
 *  these ops must run even while the secure desktop blocks input injection. */
class Power {
public:
    ~Power();
    Json command(const Json& command);
private:
    std::thread keeper;
    std::mutex mutex;
    std::condition_variable signal;
    bool held = false;
    bool stop = false;
    void hold(bool on);
};
class Audio {
    ComPtr<IAudioClient> captureClient;
    ComPtr<IAudioCaptureClient> capture;
    HWAVEOUT output = nullptr;
    WAVEFORMATEX outputFormat{};
    struct PlaybackBuffer { WAVEHDR header{}; std::vector<uint8_t> bytes; };
    std::deque<std::unique_ptr<PlaybackBuffer>> playback;
    uint64_t sequence = 0;
    void closeOutput();
    void reapPlayback();
public:
    ~Audio();
    void start();
    void stop();
    void play(const Json& command);
    std::vector<Json> poll();
};
}
