#include "remote.hpp"

namespace remote {
std::vector<Display> Capture::displays() {
    ComPtr<IDXGIFactory1> factory;
    check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "Create DXGI factory");
    std::vector<Display> result;
    for (UINT a = 0;; ++a) {
        ComPtr<IDXGIAdapter1> adapter;
        HRESULT hr = factory->EnumAdapters1(a, &adapter);
        if (hr == DXGI_ERROR_NOT_FOUND) break;
        check(hr, "Enumerate adapters");
        for (UINT o = 0;; ++o) {
            ComPtr<IDXGIOutput> output;
            hr = adapter->EnumOutputs(o, &output);
            if (hr == DXGI_ERROR_NOT_FOUND) break;
            check(hr, "Enumerate outputs");
            DXGI_OUTPUT_DESC desc{}; check(output->GetDesc(&desc), "Read display");
            if (!desc.AttachedToDesktop) continue;
            ComPtr<IDXGIOutput1> one; check(output.As(&one), "Desktop duplication interface");
            MONITORINFO monitor{}; monitor.cbSize=sizeof(monitor); GetMonitorInfoW(desc.Monitor, &monitor);
            result.push_back({utf8(desc.DeviceName),desc.DesktopCoordinates,(monitor.dwFlags & MONITORINFOF_PRIMARY) != 0,adapter,one});
        }
    }
    std::stable_sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.primary && !b.primary; });
    return result;
}
Json Capture::displayList() {
    auto items = displays(); Json result = Json::array();
    for (size_t i = 0; i < items.size(); ++i) result.push_back({{"id",items[i].id},{"label","屏幕 " + std::to_string(i + 1)},
        {"primary",items[i].primary},{"selected", selected.empty() ? i == 0 : selected == items[i].id}});
    return result;
}
void Capture::select(const std::string& id) {
    auto items = displays();
    if (std::none_of(items.begin(), items.end(), [&](const auto& d) { return d.id == id; })) throw std::runtime_error("Display disconnected; refresh display list");
    if (id != selected) { reset(); selected = id; }
}
void Capture::reset() { duplication.Reset(); staging.Reset(); context.Reset(); device.Reset(); cached = {}; separateCursor = false; }
void Capture::open(const Display& display) {
    reset(); selected = display.id;
    check(D3D11CreateDevice(display.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "Create D3D11 device");
    check(display.output->DuplicateOutput(device.Get(), &duplication), "Duplicate desktop output");
    DXGI_OUTDUPL_DESC desc{}; duplication->GetDesc(&desc); rotation = desc.Rotation;
    cached.width = display.bounds.right - display.bounds.left; cached.height = display.bounds.bottom - display.bounds.top;
    cached.x = display.bounds.left; cached.y = display.bounds.top;
}
static void cursor(Frame& frame) {
    CURSORINFO info{}; info.cbSize=sizeof(info);
    if (!GetCursorInfo(&info) || !(info.flags & CURSOR_SHOWING)) return;
    ICONINFO icon{}; if (!GetIconInfo(info.hCursor, &icon)) return;
    HDC dc = CreateCompatibleDC(nullptr); void* pixels = nullptr;
    BITMAPINFO bitmap{}; bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bitmap.bmiHeader.biWidth = frame.width;
    bitmap.bmiHeader.biHeight = -frame.height; bitmap.bmiHeader.biPlanes = 1; bitmap.bmiHeader.biBitCount = 32;
    HBITMAP dib = CreateDIBSection(dc, &bitmap, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (dc && dib && pixels) {
        auto previous = SelectObject(dc, dib); memcpy(pixels, frame.pixels.data(), frame.pixels.size());
        DrawIconEx(dc, info.ptScreenPos.x - frame.x - int(icon.xHotspot), info.ptScreenPos.y - frame.y - int(icon.yHotspot), info.hCursor, 0, 0, 0, nullptr, DI_NORMAL);
        memcpy(frame.pixels.data(), pixels, frame.pixels.size()); SelectObject(dc, previous);
    }
    if (dib) DeleteObject(dib);
    if (dc) DeleteDC(dc);
    if (icon.hbmMask) DeleteObject(icon.hbmMask);
    if (icon.hbmColor) DeleteObject(icon.hbmColor);
}
Frame Capture::frame() {
    if (!desktopAvailable()) { reset(); throw std::runtime_error("Desktop paused: unlock Windows and dismiss UAC locally"); }
    auto items = displays();
    if (items.empty()) { reset(); throw std::runtime_error("No active display"); }
    auto target = std::find_if(items.begin(), items.end(), [&](const auto& d) { return d.id == selected; });
    if (target == items.end()) target = items.begin();
    if (!duplication || selected != target->id || cached.x != target->bounds.left || cached.y != target->bounds.top ||
        cached.width != target->bounds.right - target->bounds.left || cached.height != target->bounds.bottom - target->bounds.top) open(*target);
    DXGI_OUTDUPL_FRAME_INFO info{}; ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication->AcquireNextFrame(cached.pixels.empty() ? 500 : 0, &info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        if (cached.pixels.empty()) throw std::runtime_error("Waiting for first desktop frame");
    } else {
        if (FAILED(hr)) { reset(); check(hr, "Acquire desktop frame"); }
        struct Release { IDXGIOutputDuplication* d; ~Release(){ d->ReleaseFrame(); } } release{duplication.Get()};
        ComPtr<ID3D11Texture2D> texture; check(resource.As(&texture), "Read desktop texture");
        D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
        if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) throw std::runtime_error("Unsupported desktop pixel format");
        if (!staging) {
            auto stage = desc; stage.BindFlags = 0; stage.MiscFlags = 0; stage.Usage = D3D11_USAGE_STAGING; stage.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            check(device->CreateTexture2D(&stage, nullptr, &staging), "Create desktop readback");
        }
        context->CopyResource(staging.Get(), texture.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{}; check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map desktop pixels");
        struct Unmap { ID3D11DeviceContext* c; ID3D11Texture2D* t; ~Unmap(){ c->Unmap(t,0); } } unmap{context.Get(),staging.Get()};
        const int angle = rotation == DXGI_MODE_ROTATION_ROTATE90 ? 90 : rotation == DXGI_MODE_ROTATION_ROTATE180 ? 180 : rotation == DXGI_MODE_ROTATION_ROTATE270 ? 270 : 0;
        if (cached.width != int(angle == 90 || angle == 270 ? desc.Height : desc.Width) || cached.height != int(angle == 90 || angle == 270 ? desc.Width : desc.Height)) throw std::runtime_error("Display geometry changed; retry capture");
        cached.pixels.resize(size_t(cached.width) * cached.height * 4);
        for (int y = 0; y < cached.height; ++y) {
            auto dest = cached.pixels.data() + size_t(y) * cached.width * 4;
            if (!angle) memcpy(dest, static_cast<uint8_t*>(mapped.pData) + size_t(y) * mapped.RowPitch, size_t(cached.width) * 4);
            else for (int x = 0; x < cached.width; ++x) {
                auto [sx, sy] = sourcePixel(x,y,int(desc.Width),int(desc.Height),angle);
                memcpy(dest + x * 4, static_cast<uint8_t*>(mapped.pData) + size_t(sy) * mapped.RowPitch + sx * 4, 4);
            }
        }
        if (info.LastMouseUpdateTime.QuadPart) separateCursor = info.PointerPosition.Visible != FALSE;
    }
    Frame result = cached;
    if (separateCursor) cursor(result);
    return result;
}
Json Capture::preview(const Frame& frame, const std::string& quality) {
    ComPtr<IWICImagingFactory> factory;
    check(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory)), "Create JPEG factory");
    ComPtr<IWICBitmap> bitmap;
    check(factory->CreateBitmapFromMemory(frame.width,frame.height,GUID_WICPixelFormat32bppBGRA,frame.width*4,UINT(frame.pixels.size()),const_cast<BYTE*>(frame.pixels.data()),&bitmap), "Create JPEG bitmap");
    auto [w,h] = dimensions(frame.width,frame.height,"smooth");
    ComPtr<IWICBitmapScaler> scaler; check(factory->CreateBitmapScaler(&scaler), "Create preview scaler");
    check(scaler->Initialize(bitmap.Get(),w,h,WICBitmapInterpolationModeFant), "Scale preview");
    for (float qualityValue : {0.7f,0.5f,0.3f,0.15f}) {
        ComPtr<IStream> stream; check(CreateStreamOnHGlobal(nullptr,TRUE,&stream), "Create preview stream");
        ComPtr<IWICBitmapEncoder> encoder; check(factory->CreateEncoder(GUID_ContainerFormatJpeg,nullptr,&encoder), "Create JPEG encoder");
        check(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache), "Initialize JPEG");
        ComPtr<IWICBitmapFrameEncode> output; ComPtr<IPropertyBag2> properties;
        check(encoder->CreateNewFrame(&output,&properties), "Create JPEG frame");
        PROPBAG2 property{}; property.pstrName = const_cast<wchar_t*>(L"ImageQuality"); VARIANT value{}; value.vt=VT_R4;value.fltVal=qualityValue;
        check(properties->Write(1,&property,&value), "Set JPEG quality");
        check(output->Initialize(properties.Get()), "Initialize JPEG frame"); check(output->SetSize(w,h), "Set JPEG size");
        WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR; check(output->SetPixelFormat(&format), "Set JPEG format");
        check(output->WriteSource(scaler.Get(),nullptr), "Encode JPEG"); check(output->Commit(), "Commit JPEG frame"); check(encoder->Commit(), "Commit JPEG");
        STATSTG stat{}; check(stream->Stat(&stat,STATFLAG_NONAME), "Read JPEG size");
        if (stat.cbSize.QuadPart > 640*1024) continue;
        LARGE_INTEGER zero{}; check(stream->Seek(zero,STREAM_SEEK_SET,nullptr), "Rewind JPEG");
        std::vector<uint8_t> data(size_t(stat.cbSize.QuadPart)); ULONG read=0;
        check(stream->Read(data.data(),ULONG(data.size()),&read), "Read JPEG");
        if (read != data.size()) throw std::runtime_error("Incomplete JPEG");
        return {{"ok",true},{"data",base64(data.data(),data.size())},{"width",frame.width},{"height",frame.height},
            {"originX",frame.x},{"originY",frame.y},{"displayId",selected},{"displays",displayList()},{"quality",quality}};
    }
    throw std::runtime_error("Desktop preview exceeds frame limit");
}
}
