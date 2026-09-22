#include "remote.hpp"
#include <atomic>
#include <array>
#include <propvarutil.h>

namespace remote {
namespace {
enum AUDIOCLIENT_ACTIVATION_TYPE_LOCAL { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT_LOCAL, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK_LOCAL };
enum PROCESS_LOOPBACK_MODE_LOCAL { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE_LOCAL, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE_LOCAL };
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_LOCAL { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE_LOCAL ProcessLoopbackMode; };
struct AUDIOCLIENT_ACTIVATION_PARAMS_LOCAL {
    AUDIOCLIENT_ACTIVATION_TYPE_LOCAL ActivationType;
    union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_LOCAL ProcessLoopbackParams; };
};
constexpr wchar_t PROCESS_LOOPBACK_DEVICE[] = L"VAD\\Process_Loopback";

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
    std::atomic<ULONG> references{1};
public:
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IUnknown> activatedInterface;
    ~ActivationHandler() { if (done) CloseHandle(done); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
        if (!value) return E_POINTER;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *value = static_cast<IActivateAudioInterfaceCompletionHandler*>(this); AddRef(); return S_OK;
        }
        *value = nullptr; return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override { auto count = --references; if (!count) delete this; return count; }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activationResult = E_FAIL;
        HRESULT callResult = operation->GetActivateResult(&activationResult, activatedInterface.GetAddressOf());
        result = FAILED(callResult) ? callResult : activationResult;
        SetEvent(done);
        return S_OK;
    }
};

std::vector<uint8_t> decode64(const std::string& input) {
    static constexpr signed char invalid = -1;
    static const auto table = [] {
        std::array<signed char, 256> values{}; values.fill(invalid);
        const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int index = 0; alphabet[index]; ++index) values[uint8_t(alphabet[index])] = static_cast<signed char>(index);
        return values;
    }();
    if (input.empty() || input.size() % 4) throw std::runtime_error("Invalid microphone audio frame");
    std::vector<uint8_t> output; output.reserve(input.size() * 3 / 4);
    uint32_t bits = 0; int count = 0;
    for (char character : input) {
        if (character == '=') break;
        auto value = table[uint8_t(character)]; if (value == invalid) throw std::runtime_error("Invalid microphone audio frame");
        bits = (bits << 6) | uint32_t(value); count += 6;
        if (count >= 8) { count -= 8; output.push_back(uint8_t(bits >> count)); bits &= (uint32_t(1) << count) - 1; }
    }
    if (output.empty() || output.size() > 48'000) throw std::runtime_error("Microphone audio frame outside limit");
    return output;
}
}

Audio::~Audio() { stop(); }

void Audio::start() {
    if (captureClient) return;
    AUDIOCLIENT_ACTIVATION_PARAMS_LOCAL parameters{};
    parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK_LOCAL;
    parameters.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
    parameters.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE_LOCAL;
    PROPVARIANT variant{}; PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(parameters);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);
    auto* handler = new ActivationHandler();
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    HRESULT activation = ActivateAudioInterfaceAsync(PROCESS_LOOPBACK_DEVICE, __uuidof(IAudioClient), &variant, handler, &operation);
    if (FAILED(activation)) { handler->Release(); check(activation, "Start process loopback capture"); }
    DWORD wait = WaitForSingleObject(handler->done, 5000);
    HRESULT completion = handler->result;
    ComPtr<IUnknown> activated = handler->activatedInterface;
    handler->Release();
    if (wait != WAIT_OBJECT_0) throw std::runtime_error("Process loopback capture timed out");
    check(completion, "Activate process loopback capture");
    check(activated.As(&captureClient), "Open process loopback audio client");
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2; format.nSamplesPerSec = 48'000;
    format.wBitsPerSample = 16; format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    check(captureClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        1'000'000, 0, &format, nullptr), "Initialize process loopback capture");
    check(captureClient->GetService(IID_PPV_ARGS(&capture)), "Open loopback capture service");
    check(captureClient->Start(), "Start process loopback capture");
}

void Audio::reapPlayback() {
    while (!playback.empty() && (playback.front()->header.dwFlags & WHDR_DONE)) {
        waveOutUnprepareHeader(output, &playback.front()->header, sizeof(WAVEHDR));
        playback.pop_front();
    }
}

void Audio::closeOutput() {
    if (!output) return;
    waveOutReset(output);
    for (auto& item : playback) waveOutUnprepareHeader(output, &item->header, sizeof(WAVEHDR));
    playback.clear(); waveOutClose(output); output = nullptr; outputFormat = {};
}

void Audio::stop() {
    if (captureClient) captureClient->Stop();
    capture.Reset(); captureClient.Reset(); closeOutput();
}

void Audio::play(const Json& command) {
    int sampleRate = command.at("sampleRate").get<int>();
    int channels = command.at("channels").get<int>();
    if (sampleRate < 8'000 || sampleRate > 48'000 || channels < 1 || channels > 2) throw std::runtime_error("Invalid microphone audio format");
    auto bytes = decode64(command.at("data").get<std::string>());
    if (bytes.size() % (size_t(channels) * 2)) throw std::runtime_error("Invalid microphone audio frame size");
    if (!output || outputFormat.nSamplesPerSec != DWORD(sampleRate) || outputFormat.nChannels != WORD(channels)) {
        closeOutput();
        outputFormat.wFormatTag = WAVE_FORMAT_PCM; outputFormat.nChannels = WORD(channels); outputFormat.nSamplesPerSec = DWORD(sampleRate);
        outputFormat.wBitsPerSample = 16; outputFormat.nBlockAlign = WORD(channels * 2); outputFormat.nAvgBytesPerSec = DWORD(sampleRate * channels * 2);
        MMRESULT result = waveOutOpen(&output, WAVE_MAPPER, &outputFormat, 0, 0, CALLBACK_NULL);
        if (result != MMSYSERR_NOERROR) throw std::runtime_error("Open speaker output failed");
    }
    reapPlayback();
    auto item = std::make_unique<PlaybackBuffer>(); item->bytes = std::move(bytes);
    item->header.lpData = reinterpret_cast<LPSTR>(item->bytes.data()); item->header.dwBufferLength = DWORD(item->bytes.size());
    if (waveOutPrepareHeader(output, &item->header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR
        || waveOutWrite(output, &item->header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) throw std::runtime_error("Play microphone audio failed");
    playback.push_back(std::move(item));
}

std::vector<Json> Audio::poll() {
    reapPlayback();
    std::vector<Json> events;
    if (!capture) return events;
    UINT32 packets = 0;
    check(capture->GetNextPacketSize(&packets), "Read loopback packet size");
    while (packets) {
        BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
        check(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr), "Read loopback audio");
        std::vector<uint8_t> bytes(size_t(frames) * 4);
        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) memcpy(bytes.data(), data, bytes.size());
        capture->ReleaseBuffer(frames);
        if (!bytes.empty()) events.push_back({{"event","audio"},{"sequence",++sequence},{"sampleRate",48'000},{"channels",2},{"data",base64(bytes.data(),bytes.size())}});
        check(capture->GetNextPacketSize(&packets), "Read loopback packet size");
    }
    return events;
}
}
