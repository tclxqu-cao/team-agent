#include "remote.hpp"
#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>

using namespace remote;
static void emit(const Json& value) {
    static std::mutex outputMutex;std::lock_guard<std::mutex> lock(outputMutex);
    auto line=value.dump()+"\n";
    if (line.size()>8*1024*1024) throw std::runtime_error("Helper response too large");
    size_t offset=0;
    while (offset<line.size()) { DWORD written=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),line.data()+offset,DWORD(line.size()-offset),&written,nullptr)||!written) throw std::runtime_error("Helper pipe closed");offset+=written; }
}
int main(int argc,char** argv) {
    try {
        algorithmSelfTest();
        if (argc==2 && std::string(argv[1])=="--self-test") {
            check(CoInitializeEx(nullptr,COINIT_MULTITHREADED), "Initialize test COM");
            check(MFStartup(MF_VERSION,MFSTARTUP_LITE), "Initialize test Media Foundation");
            Frame frame;frame.width=320;frame.height=240;frame.pixels.resize(320*240*4,128);
            CompoundCapture::selfTest();
            VideoEncoder encoder;encoder.configure(1'000'000,15,30);bool received=false;
            for(int i=0;i<20;++i) {auto event=encoder.encode(frame,"smooth",true);if(!event.is_null()&&!event["nals"].empty()){received=true;break;}}
            if(!received)throw std::runtime_error("H264 encoder produced no test frame");
            encoder.reset();MFShutdown();CoUninitialize();
            std::cout<<"Windows remote helper algorithms and synthetic H264 self-test passed\n";return 0;
        }
        if (argc!=3 || std::string(argv[1])!="--parent") throw std::runtime_error("Expected --parent PID");
        DWORD pid=DWORD(std::stoul(argv[2]));
        HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,pid);if(!parent) throw std::runtime_error("Parent process unavailable");
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        check(CoInitializeEx(nullptr,COINIT_MULTITHREADED), "Initialize COM");
        HRESULT mediaStartup=MFStartup(MF_VERSION,MFSTARTUP_LITE);
        // Codec initialization failure is reported to the viewer; JPEG remains the fallback when the DLLs are present.
        struct Queue {std::mutex mutex;std::deque<std::string> lines;bool closed=false;};
        auto queue=std::make_shared<Queue>();
        std::thread([queue] {
            std::string line;char chunk[4096];DWORD read=0;
            while(ReadFile(GetStdHandle(STD_INPUT_HANDLE),chunk,sizeof(chunk),&read,nullptr)&&read) {
                for(DWORD i=0;i<read;++i) {
                    if(chunk[i]=='\n') {
                        std::lock_guard<std::mutex> guard(queue->mutex);
                        if(queue->lines.size()>=128) {queue->closed=true;return;}
                        queue->lines.push_back(std::move(line));line.clear();
                    } else { line+=chunk[i];if(line.size()>65536){std::lock_guard<std::mutex> guard(queue->mutex);queue->closed=true;return;} }
                }
            }
            std::lock_guard<std::mutex> guard(queue->mutex);queue->closed=true;
        }).detach();
        Capture capture;VideoPipeline pipeline(emit);Input input;Power power;Audio audio;
        bool wasAvailable=false;std::string quality="hd";
        auto failDesktop=[&] {input.release();capture.reset();};
        try {
            while(WaitForSingleObject(parent,0)==WAIT_TIMEOUT) {
                bool available=desktopAvailable();
                if(!available&&wasAvailable) failDesktop();

                wasAvailable=available;
                std::deque<std::string> lines;
                {std::lock_guard<std::mutex> guard(queue->mutex);if(queue->closed)break;lines.swap(queue->lines);}
                for(const auto& line:lines) {
                    Json id=nullptr;
                    try {
                        auto cmd=Json::parse(line);id=cmd.at("id");if(!id.is_number_unsigned()&&!id.is_number_integer())throw std::runtime_error("Invalid request id");
                        auto op=cmd.at("op").get<std::string>();Json result={{"ok",true}};
                        if(op=="status") result={{"ok",true},{"screen",available},{"accessibility",available},{"videoProtocolVersion",2},{"compoundVersion",1},{"cursorVersion",1},{"locked",sessionLocked()},{"error",available?Json(nullptr):Json("Windows 已锁定、会话已断开或正在显示 UAC，请在电脑上恢复普通桌面。")}};
                        else if(op=="release") input.release();
                        else if(op=="quit") {input.release();return 0;}
                        else if(op=="wake"||op=="lock"||op=="keep-display") result=power.command(cmd);
                        else if(op=="video"||op=="video-start"||op=="video-tuning"||op=="video-stats"||op=="compound-enable"||op=="compound-sample"||op=="cursor-enable") {
                            pipeline.submit(cmd);continue;
                        } else if(op=="audio-start") audio.start();
                        else if(op=="audio-stop") audio.stop();
                        else if(op=="audio-play") audio.play(cmd);
                        else if(!available) throw std::runtime_error("Windows 已锁定或正在显示 UAC，请在电脑上恢复普通桌面。");
                        else if(op=="displays") result["displays"]=capture.displayList();
                        else if(op=="capture"||op=="set-display"||op=="set-quality") {
                            if(op=="set-display"){input.release();capture.select(cmd.at("displayId").get<std::string>());auto change=cmd;change.erase("id");pipeline.submit(change);}
                            if(op=="set-quality"){auto q=cmd.at("quality").get<std::string>();dimensions(100,100,q);quality=q;auto change=cmd;change.erase("id");pipeline.submit(change);}
                            result=capture.preview(capture.frame(),quality);
                            if(!desktopAvailable()) {failDesktop();throw std::runtime_error("Desktop changed during capture");}
                        } else result=input.command(cmd);
                        result["id"]=id;emit(result);
                    } catch(const std::exception& error) {input.release();emit({{"id",id},{"ok",false},{"error",error.what()}});}
                }
                for(auto& event:audio.poll())emit(event);
                Sleep(10);
            }
        } catch(...) {input.release();throw;}
        audio.stop();input.release();capture.reset();CloseHandle(parent);
        if(SUCCEEDED(mediaStartup)) MFShutdown();
        CoUninitialize();return 0;
    } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
