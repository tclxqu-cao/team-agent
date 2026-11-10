#include "remote.hpp"
#include <bcrypt.h>
#include <cstring>
#include <map>
#include <sstream>
#include <iomanip>

namespace remote {
static std::vector<uint8_t> png(const Frame& frame) {
    ComPtr<IWICImagingFactory> factory;check(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory)),"PNG factory");
    ComPtr<IStream> stream;check(CreateStreamOnHGlobal(nullptr,TRUE,&stream),"PNG stream");
    ComPtr<IWICBitmapEncoder> encoder;check(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,&encoder),"PNG encoder");
    check(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache),"Initialize PNG");
    ComPtr<IWICBitmapFrameEncode> output;check(encoder->CreateNewFrame(&output,nullptr),"PNG frame");
    check(output->Initialize(nullptr),"Initialize PNG frame");check(output->SetSize(frame.width,frame.height),"PNG dimensions");
    WICPixelFormatGUID format=GUID_WICPixelFormat32bppBGRA;check(output->SetPixelFormat(&format),"PNG format");
    check(output->WritePixels(frame.height,frame.width*4,UINT(frame.pixels.size()),const_cast<BYTE*>(frame.pixels.data())),"PNG pixels");
    check(output->Commit(),"Commit PNG frame");check(encoder->Commit(),"Commit PNG");
    STATSTG stat{};check(stream->Stat(&stat,STATFLAG_NONAME),"PNG size");
    if(stat.cbSize.QuadPart>32768) return {};
    LARGE_INTEGER zero{};check(stream->Seek(zero,STREAM_SEEK_SET,nullptr),"PNG rewind");
    std::vector<uint8_t> result(size_t(stat.cbSize.QuadPart));ULONG count=0;check(stream->Read(result.data(),ULONG(result.size()),&count),"Read PNG");
    if(count!=result.size())throw std::runtime_error("Truncated PNG");
    return result;
}
static std::string digest(const Frame& tile) {
    struct Provider {BCRYPT_ALG_HANDLE handle=nullptr;Provider(){if(BCryptOpenAlgorithmProvider(&handle,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw std::runtime_error("SHA256 unavailable");}~Provider(){BCryptCloseAlgorithmProvider(handle,0);}};
    static thread_local Provider provider;
    BCRYPT_HASH_HANDLE hash=nullptr;
    if(BCryptCreateHash(provider.handle,&hash,nullptr,0,nullptr,0,0)<0)throw std::runtime_error("SHA256 create");
    uint8_t size[2]={uint8_t(tile.width),uint8_t(tile.height)},result[32];
    auto a=BCryptHashData(hash,size,2,0),b=BCryptHashData(hash,const_cast<BYTE*>(tile.pixels.data()),ULONG(tile.pixels.size()),0),c=BCryptFinishHash(hash,result,32,0);
    BCryptDestroyHash(hash);if(a<0||b<0||c<0)throw std::runtime_error("SHA256 failure");
    std::ostringstream text;for(auto byte:result)text<<std::hex<<std::setw(2)<<std::setfill('0')<<unsigned(byte);return text.str();
}
static double entropy(const Frame& tile) {
    int bins[768]={},count=0;
    for(int y=0;y<tile.height;y+=2)for(int x=0;x<tile.width;x+=2){auto p=tile.pixels.data()+(size_t(y)*tile.width+x)*4;for(int c=0;c<3;c++)bins[c*256+p[c]]++;count++;}
    double value=0;for(int bin:bins)if(bin){double p=double(bin)/count;value-=p*std::log2(p);}return value;
}
static Json scrollCopy(const Frame& old,const Frame& next,int revision) {
    if(old.width!=next.width||old.height!=next.height)return nullptr;
    auto copy=findPixelScroll(old.pixels,next.pixels,next.width,next.height);
    if(!copy)return nullptr;
    return {{"sourceRevision",revision},{"sourceX",copy->sourceX},{"sourceY",copy->sourceY},{"x",copy->x},{"y",copy->y},{"width",copy->width},{"height",copy->height}};
}
struct CompoundCapture::State {
    struct Image {std::vector<uint8_t> png;double complexity;uint64_t use;};
    struct Source {std::shared_ptr<const Frame> frame;int revision;double capturedAt;};
    bool enabled=false;int epoch=0,revision=0,cursor=0,baseRevision=0;double capturedAt=0,timestamp=0;
    std::shared_ptr<const Frame> current,accepted,base;
    std::map<int64_t,Source> submittedFrames;double acceptedTimestamp=0,acceptedAt=0;
    std::map<std::string,Image> images;size_t imageBytes=0;uint64_t used=0,encodes=0,hits=0,scans=0;
    std::function<void(const Json&)> emit;
    Json metadata(const char* kind){return {{"event","compound"},{"kind",kind},{"epoch",epoch},{"revision",revision},{"timestamp",timestamp},{"capturedAt",capturedAt},{"width",current?current->width:0},{"height",current?current->height:0}};}
};
CompoundCapture::CompoundCapture(std::function<void(const Json&)> emit):state(new State){state->emit=std::move(emit);}
CompoundCapture::~CompoundCapture()=default;
void CompoundCapture::configure(bool enabled){auto emit=state->emit;int epoch=state->epoch+1;state.reset(new State);state->emit=std::move(emit);state->epoch=epoch;state->enabled=enabled;}
void CompoundCapture::change(std::shared_ptr<const Frame> frame,double capturedAt){
    auto& s=*state;if(!s.enabled)return;
    bool resized=!s.current||s.current->width!=frame->width||s.current->height!=frame->height;
    if(resized){bool enabled=s.enabled;configure(enabled);}
    auto& t=*state;t.capturedAt=capturedAt;
    bool changed=resized||t.current->pixels!=frame->pixels;
    if(changed){
        Json rects=Json::array();
        if(!resized){
            for(int y=0;y<frame->height;y+=64)for(int x=0;x<frame->width;x+=64){
                int width=std::min(64,frame->width-x),height=std::min(64,frame->height-y);bool different=false;
                for(int row=0;row<height&&!different;row++)different=memcmp(t.current->pixels.data()+(size_t(y+row)*frame->width+x)*4,frame->pixels.data()+(size_t(y+row)*frame->width+x)*4,size_t(width)*4)!=0;
                if(different)rects.push_back({{"x",x},{"y",y},{"width",width},{"height",height}});
                if(rects.size()>32)break;
            }
        }
        t.base=t.accepted;t.baseRevision=t.revision;t.accepted.reset();t.current=std::move(frame);t.revision++;
        Json event=t.metadata("invalidate");if(!rects.empty()&&rects.size()<=32)event["rects"]=rects;t.emit(event);
    }else t.current=std::move(frame);
}
void CompoundCapture::submitted(double timestamp){
    auto& s=*state;if(!s.enabled||!s.current)return;s.timestamp=timestamp;
    s.submittedFrames[std::llround(timestamp*10'000'000)]={s.current,s.revision,s.capturedAt};
    while(s.submittedFrames.size()>8)s.submittedFrames.erase(s.submittedFrames.begin());
    s.emit(s.metadata("frame"));
}
void CompoundCapture::delivered(double timestamp){
    auto& s=*state;auto entry=s.submittedFrames.find(std::llround(timestamp*10'000'000));
    if(entry==s.submittedFrames.end()||entry->second.revision!=s.revision)return;
    s.accepted=entry->second.frame;s.acceptedTimestamp=timestamp;s.acceptedAt=entry->second.capturedAt;
}
Json CompoundCapture::sample(const Json& command){
    auto& s=*state;if(!s.enabled||!s.accepted)return {{"ok",true},{"stale",true}};
    const auto& frame=*s.accepted;if(frame.width>4096||frame.height>4096||int64_t(frame.width)*frame.height>8388608)throw std::runtime_error("Compound dimensions unsupported");
    int budget=std::clamp(command.value("maxBytes",48000),1024,128*1024);double maxEntropy=command.value("maxEntropy",6.3);
    if(!std::isfinite(maxEntropy)||maxEntropy<0||maxEntropy>24)throw std::runtime_error("Invalid entropy threshold");
    Json result=s.metadata("sample");result.erase("event");result["timestamp"]=s.acceptedTimestamp;result["capturedAt"]=s.acceptedAt;result["ok"]=true;result["tiles"]=Json::array();
    if(s.base){auto copy=scrollCopy(*s.base,frame,s.baseRevision);if(!copy.is_null())result["scroll"]=copy;s.base.reset();}
    int columns=(frame.width+63)/64,count=columns*((frame.height+63)/64),bytes=256,scanned=0;
    std::vector<int> indices;std::set<int> seen;
    if(command.contains("priorityIndices")&&command["priorityIndices"].is_array())for(const auto& value:command["priorityIndices"]){if(indices.size()>=128)break;if(value.is_number_integer()){int index=value.get<int>();if(index>=0&&index<count&&seen.insert(index).second)indices.push_back(index);}}
    if(!command.value("selectedOnly",false))for(int n=0;n<count;n++){int index=(s.cursor+n)%count;if(seen.insert(index).second)indices.push_back(index);}
    auto began=std::chrono::steady_clock::now();
    for(int index:indices){
        s.scans++;
        int x=index%columns*64,y=index/columns*64;Frame tile;tile.width=std::min(64,frame.width-x);tile.height=std::min(64,frame.height-y);tile.pixels.resize(size_t(tile.width)*tile.height*4);
        for(int row=0;row<tile.height;row++)memcpy(tile.pixels.data()+size_t(row)*tile.width*4,frame.pixels.data()+(size_t(y+row)*frame.width+x)*4,size_t(tile.width)*4);
        for(size_t at=3;at<tile.pixels.size();at+=4)tile.pixels[at]=255;
        auto key=digest(tile);auto cached=s.images.find(key);double complexity=cached==s.images.end()?entropy(tile):cached->second.complexity;
        if(complexity<=maxEntropy){
            if(cached==s.images.end()){
                auto data=png(tile);if(!data.empty()){
                    while(s.images.size()>=1024||s.imageBytes+data.size()>16*1024*1024){auto oldest=std::min_element(s.images.begin(),s.images.end(),[](const auto&a,const auto&b){return a.second.use<b.second.use;});if(oldest==s.images.end())break;s.imageBytes-=oldest->second.png.size();s.images.erase(oldest);}
                    s.imageBytes+=data.size();s.encodes++;cached=s.images.emplace(key,State::Image{std::move(data),complexity,++s.used}).first;
                }
            }else{s.hits++;cached->second.use=++s.used;}
            if(cached!=s.images.end()){const auto& data=cached->second.png;int cost=192+int((data.size()+2)/3)*4;if(bytes+cost>budget)break;
                result["tiles"].push_back({{"key",key},{"x",x},{"y",y},{"width",tile.width},{"height",tile.height},{"entropy",complexity},{"data",base64(data.data(),data.size())}});bytes+=cost;}
        }
        scanned++;if(result["tiles"].size()>=128||std::chrono::steady_clock::now()-began>=std::chrono::milliseconds(30))break;
    }
    s.cursor=(s.cursor+std::max(1,scanned))%count;result["extraction"]={{"pngEncodes",s.encodes},{"pngCacheHits",s.hits},{"scannedBlocks",s.scans}};return result;
}
Json cursorMetadata(const Frame& frame,uint64_t sequence,uint32_t cutover,bool includeShape){
    CURSORINFO cursor{};cursor.cbSize=sizeof(cursor);bool visible=GetCursorInfo(&cursor)&&(cursor.flags&CURSOR_SHOWING);
    visible=visible&&cursor.ptScreenPos.x>=frame.x&&cursor.ptScreenPos.y>=frame.y&&cursor.ptScreenPos.x<frame.x+frame.width&&cursor.ptScreenPos.y<frame.y+frame.height;
    Json event={{"event","cursor"},{"sequence",sequence},{"active",true},{"visible",visible},{"x",std::clamp(double(cursor.ptScreenPos.x-frame.x)/std::max(1,frame.width),0.,1.)},{"y",std::clamp(double(cursor.ptScreenPos.y-frame.y)/std::max(1,frame.height),0.,1.)},{"cutoverRtp",cutover}};
    event["shape"]=cursor.hCursor==LoadCursorW(nullptr,MAKEINTRESOURCEW(32513))?"text":"arrow";
    if(includeShape&&visible){
        ICONINFO info{};if(GetIconInfo(cursor.hCursor,&info)){
            HDC dc=CreateCompatibleDC(nullptr);BITMAPINFO bi{};bi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);bi.bmiHeader.biWidth=64;bi.bmiHeader.biHeight=-64;bi.bmiHeader.biPlanes=1;bi.bmiHeader.biBitCount=32;void* bits=nullptr;
            HBITMAP bitmap=CreateDIBSection(dc,&bi,DIB_RGB_COLORS,&bits,nullptr,0);
            if(dc&&bitmap&&bits){auto old=SelectObject(dc,bitmap);memset(bits,0,64*64*4);DrawIconEx(dc,0,0,cursor.hCursor,0,0,0,nullptr,DI_NORMAL);Frame image;image.width=64;image.height=64;image.pixels.assign(static_cast<uint8_t*>(bits),static_cast<uint8_t*>(bits)+64*64*4);
                auto data=png(image);if(data.size()<=6144){event["image"]=base64(data.data(),data.size());event["hotX"]=info.xHotspot;event["hotY"]=info.yHotspot;}SelectObject(dc,old);}
            if(bitmap)DeleteObject(bitmap);
            if(dc)DeleteDC(dc);
            if(info.hbmMask)DeleteObject(info.hbmMask);
            if(info.hbmColor)DeleteObject(info.hbmColor);
        }
    }return event;
}
void CompoundCapture::selfTest(){
    std::vector<Json> events;CompoundCapture capture([&](const Json&e){events.push_back(e);});capture.configure(true);
    auto frame=std::make_shared<Frame>();frame->width=128;frame->height=128;frame->pixels.resize(128*128*4,255);
    capture.change(frame,1000);capture.submitted(1);capture.delivered(1);Json command={{"maxBytes",48000},{"maxEntropy",24}};
    auto first=capture.sample(command),second=capture.sample(command);
    if(first["tiles"].empty()||second["extraction"]["pngEncodes"]!=first["extraction"]["pngEncodes"]||second["extraction"]["pngCacheHits"].get<int>()<=0)throw std::runtime_error("Compound cache self-test failed");
    command["selectedOnly"]=true;command["priorityIndices"]=Json::array({3,3,-1,100});
    auto selected=capture.sample(command);
    if(selected["tiles"].size()!=1||selected["tiles"][0]["x"]!=64||selected["tiles"][0]["y"]!=64||selected["extraction"]["scannedBlocks"].get<int>()!=second["extraction"]["scannedBlocks"].get<int>()+1)throw std::runtime_error("Selected compound sample failed");
    command["priorityIndices"]=Json::array();auto empty=capture.sample(command);
    if(!empty["tiles"].empty()||empty["extraction"]["scannedBlocks"]!=selected["extraction"]["scannedBlocks"])throw std::runtime_error("Empty selected sample swept frame");
}
}
