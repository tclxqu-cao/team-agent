#include "remote.hpp"

namespace remote {
void VideoEncoder::reset() { transform.Reset(); codec.Reset(); width=0; height=0; parameterSets.clear(); }
void VideoEncoder::open(int w, int h, const std::string& q) {
    reset();
    // The synchronous Microsoft encoder avoids vendor-specific async MFT protocols.
    check(CoCreateInstance(CLSID_CMSH264EncoderMFT,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&transform)), "Create Windows H264 encoder (Media Feature Pack required on Windows N)");
    check(transform->QueryInterface(IID_ICodecAPI, reinterpret_cast<void**>(codec.GetAddressOf())), "H264 codec settings");
    auto set = [&](const GUID& name, ULONG value) { VARIANT v{}; v.vt=VT_UI4;v.ulVal=value; return codec->SetValue(&name,&v); };
    set(CODECAPI_AVEncMPVDefaultBPictureCount,0);
    set(CODECAPI_AVEncMPVGOPSize,40);
    VARIANT latency{}; latency.vt=VT_BOOL;latency.boolVal=VARIANT_TRUE; codec->SetValue(&CODECAPI_AVLowLatencyMode,&latency);
    const UINT32 bitrate = q == "smooth" ? 2'000'000 : q == "hd" ? 6'000'000 : 12'000'000;
    ComPtr<IMFMediaType> output; check(MFCreateMediaType(&output), "Create H264 media type");
    check(output->SetGUID(MF_MT_MAJOR_TYPE,MFMediaType_Video), "Set video type");
    check(output->SetGUID(MF_MT_SUBTYPE,MFVideoFormat_H264), "Set H264 subtype");
    check(output->SetUINT32(MF_MT_AVG_BITRATE,bitrate), "Set bitrate");
    check(output->SetUINT32(MF_MT_INTERLACE_MODE,MFVideoInterlace_Progressive), "Set progressive video");
    check(output->SetUINT32(MF_MT_YUV_MATRIX,MFVideoTransferMatrix_BT601), "Set video color matrix");
    check(output->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,MFNominalRange_16_235), "Set limited video range");
    check(output->SetUINT32(MF_MT_MPEG2_PROFILE,66), "Set baseline profile");
    check(output->SetUINT32(MF_MT_MPEG2_LEVEL,52), "Set H264 level");
    check(MFSetAttributeSize(output.Get(),MF_MT_FRAME_SIZE,w,h), "Set H264 frame size");
    check(MFSetAttributeRatio(output.Get(),MF_MT_FRAME_RATE,20,1), "Set H264 frame rate");
    check(MFSetAttributeRatio(output.Get(),MF_MT_PIXEL_ASPECT_RATIO,1,1), "Set aspect ratio");
    check(transform->SetOutputType(0,output.Get(),0), "Configure H264 output");
    ComPtr<IMFMediaType> input; check(MFCreateMediaType(&input), "Create NV12 media type");
    check(input->SetGUID(MF_MT_MAJOR_TYPE,MFMediaType_Video), "Set input video type");
    check(input->SetGUID(MF_MT_SUBTYPE,MFVideoFormat_NV12), "Set NV12 input");
    check(input->SetUINT32(MF_MT_YUV_MATRIX,MFVideoTransferMatrix_BT601), "Set input color matrix");
    check(input->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,MFNominalRange_16_235), "Set limited input range");
    check(input->SetUINT32(MF_MT_INTERLACE_MODE,MFVideoInterlace_Progressive), "Set input progressive");
    check(MFSetAttributeSize(input.Get(),MF_MT_FRAME_SIZE,w,h), "Set NV12 size");
    check(MFSetAttributeRatio(input.Get(),MF_MT_FRAME_RATE,20,1), "Set input rate");
    check(MFSetAttributeRatio(input.Get(),MF_MT_PIXEL_ASPECT_RATIO,1,1), "Set input aspect");
    check(transform->SetInputType(0,input.Get(),0), "Configure NV12 input");
    check(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,0), "Begin H264 streaming");
    check(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM,0), "Start H264 stream");
    width=w; height=h; quality=q;
}
static uint8_t channel(int value) { return uint8_t(std::clamp(value,0,255)); }
Json VideoEncoder::encode(const Frame& frame, const std::string& q, bool keyframe) {
    auto [w,h] = dimensions(frame.width,frame.height,q);
    if (!transform || width!=w || height!=h || quality!=q) { open(w,h,q); keyframe=true; }
    if (keyframe) { VARIANT v{};v.vt=VT_UI4;v.ulVal=1;check(codec->SetValue(&CODECAPI_AVEncVideoForceKeyFrame,&v), "Request H264 keyframe"); }
    ComPtr<IMFMediaBuffer> buffer; DWORD size=DWORD(w*h*3/2); check(MFCreateMemoryBuffer(size,&buffer), "Allocate NV12");
    BYTE* bytes=nullptr; check(buffer->Lock(&bytes,nullptr,nullptr), "Lock NV12");
    for (int y=0;y<h;y+=2) for (int x=0;x<w;x+=2) {
        int rSum=0,gSum=0,bSum=0;
        for (int yy=0;yy<2;++yy) for (int xx=0;xx<2;++xx) {
            int sx=(x+xx)*frame.width/w, sy=(y+yy)*frame.height/h;
            const auto* pixel=frame.pixels.data()+(size_t(sy)*frame.width+sx)*4;
            int b=pixel[0],g=pixel[1],r=pixel[2]; rSum+=r;gSum+=g;bSum+=b;
            bytes[size_t(y+yy)*w+x+xx]=channel(((66*r+129*g+25*b+128)>>8)+16);
        }
        int r=rSum/4,g=gSum/4,b=bSum/4;
        size_t uv=size_t(w)*h+size_t(y/2)*w+x;
        bytes[uv]=channel(((-38*r-74*g+112*b+128)>>8)+128);
        bytes[uv+1]=channel(((112*r-94*g-18*b+128)>>8)+128);
    }
    check(buffer->Unlock(), "Unlock NV12"); check(buffer->SetCurrentLength(size), "Set NV12 length");
    ComPtr<IMFSample> sample; check(MFCreateSample(&sample), "Create video sample");check(sample->AddBuffer(buffer.Get()), "Attach NV12");
    static const auto epoch=std::chrono::steady_clock::now();
    timestamp=std::max(timestamp+1,LONGLONG(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-epoch).count()/100));
    check(sample->SetSampleTime(timestamp), "Set video time");check(sample->SetSampleDuration(500'000), "Set video duration");
    check(transform->ProcessInput(0,sample.Get(),0), "Encode H264 input");
    MFT_OUTPUT_STREAM_INFO info{};check(transform->GetOutputStreamInfo(0,&info), "H264 output info");
    ComPtr<IMFSample> encoded; ComPtr<IMFMediaBuffer> encodedBuffer;
    if (!(info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
        check(MFCreateSample(&encoded), "Create H264 sample");
        check(MFCreateMemoryBuffer(std::max(info.cbSize,DWORD(w*h*2)),&encodedBuffer), "Allocate H264 output");
        check(encoded->AddBuffer(encodedBuffer.Get()), "Attach H264 output");
    }
    MFT_OUTPUT_DATA_BUFFER output{};output.pSample=encoded.Get();DWORD flags=0;
    HRESULT hr=transform->ProcessOutput(0,1,&output,&flags);
    if (output.pEvents) output.pEvents->Release();
    if (hr==MF_E_TRANSFORM_NEED_MORE_INPUT) return nullptr;
    check(hr, "Read H264 output");
    if (!encoded) encoded.Attach(output.pSample);
    if (!encoded) throw std::runtime_error("H264 encoder returned no sample");
    check(encoded->ConvertToContiguousBuffer(&encodedBuffer), "Read H264 buffer");
    DWORD length=0;check(encodedBuffer->Lock(&bytes,nullptr,&length), "Lock H264 buffer");
    std::vector<std::vector<uint8_t>> nals;
    try { nals=annexBNals(bytes,length); } catch (...) { encodedBuffer->Unlock(); throw; }
    encodedBuffer->Unlock();
    // Some encoder versions emit SPS/PPS in the media type instead of each IDR.
    ComPtr<IMFMediaType> current;
    if (SUCCEEDED(transform->GetOutputCurrentType(0,&current))) {
        UINT32 headerSize=0;
        if (SUCCEEDED(current->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER,&headerSize)) && headerSize && headerSize<65536) {
            std::vector<uint8_t> header(headerSize);
            if (SUCCEEDED(current->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER,header.data(),headerSize,nullptr))) {
                try { parameterSets=annexBNals(header.data(),header.size()); } catch (...) {}
            }
        }
    }
    bool idr=false,sps=false;
    for (const auto& nal:nals) { idr|=(nal[0]&31)==5; sps|=(nal[0]&31)==7; }
    if (idr && !sps) nals.insert(nals.begin(),parameterSets.begin(),parameterSets.end());
    Json payload=Json::array();size_t total=0;
    for (const auto& nal:nals) { total+=nal.size(); if (total>5*1024*1024) throw std::runtime_error("H264 frame too large; select lower quality");payload.push_back(base64(nal.data(),nal.size())); }
    LONGLONG outputTime=timestamp;encoded->GetSampleTime(&outputTime);
    return {{"event","video"},{"timestamp",double(outputTime)/10'000'000},{"nals",payload}};
}
}
