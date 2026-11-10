#include "remote.hpp"
#include <cstring>

namespace remote {
static double wallMilliseconds(){return std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();}
static std::shared_ptr<Frame> videoPixels(const Frame& input,const std::string& quality,int maxEdge){
    auto [w,h]=adaptiveVideoDimensions(input.width,input.height,quality,maxEdge);auto frame=std::make_shared<Frame>();frame->width=w;frame->height=h;frame->x=input.x;frame->y=input.y;frame->pixels.resize(size_t(w)*h*4);
    if(w==input.width&&h==input.height)frame->pixels=input.pixels;
    else for(int y=0;y<h;y++)for(int x=0;x<w;x++)memcpy(frame->pixels.data()+(size_t(y)*w+x)*4,input.pixels.data()+(size_t(y*input.height/h)*input.width+x*input.width/w)*4,4);
    return frame;
}
struct VideoPipeline::State {
    std::function<void(const Json&)> emit;
    std::mutex mutex;std::condition_variable signal;std::deque<Json> commands;bool quitting=false;
    std::thread worker;
    explicit State(std::function<void(const Json&)> output):emit(std::move(output)),worker([this]{run();}){}
    void run(){
        auto com=CoInitializeEx(nullptr,COINIT_MULTITHREADED);auto media=MFStartup(MF_VERSION,MFSTARTUP_LITE);
        Capture capture;VideoEncoder encoder;CompoundCapture compound(emit);bool enabled=false,force=true,cursor=false,availableBefore=false,compoundEnabled=false;
        Frame cursorBounds;
        std::string quality="hd",activity="motion";int fps=30,maxEdge=0;double latency=0;uint64_t dropped=0,coalesced=0,suppressed=0,sequence=0,cursorSequence=0;
        StaticVideoAdmission admission;
        auto changedAt=std::chrono::steady_clock::now();
        std::shared_ptr<Frame> last;std::optional<uint32_t> cutover;
        auto next=std::chrono::steady_clock::now(),cursorNext=next,shapeNext=next;
        encoder.onSubmitted=[&](double timestamp){compound.submitted(timestamp);admission.submitted(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count());force=false;if(cursor&&!cutover)cutover=uint32_t(std::llround(timestamp*90'000));};
        auto reset=[&]{admission.reset();maxEdge=0;encoder.reset();capture.reset();compound.configure(false);last.reset();cutover.reset();};
        try {
            for(;;){
                std::deque<Json> requests;
                {std::unique_lock<std::mutex> lock(mutex);signal.wait_for(lock,std::chrono::milliseconds(5),[&]{return quitting||!commands.empty();});if(quitting)break;requests.swap(commands);}
                for(const auto& command:requests){
                    Json result={{"ok",true}};bool reply=command.contains("id")&&!command["id"].is_null();
                    try {
                        auto op=command.at("op").get<std::string>();
                        if(op=="video-start"||op=="video-tuning"){
                            if(op=="video-start"&&command.value("profile",std::string("baseline"))!="baseline")throw std::runtime_error("Windows encoder supports Baseline");
                            int rate=command.at("bitRate").get<int>(),hz=command.at("maxFps").get<int>(),gop=command.value("keyFrameInterval",60),pending=command.value("maxPendingFrames",1);
                            if(pending<1||pending>2)throw std::runtime_error("Invalid admission limit");
                            check(media,"Windows Media Feature Pack required");
                            int requestedEdge=command.value("maxEdge",op=="video-start"?0:maxEdge);
                            if(requestedEdge!=0&&(requestedEdge<640||requestedEdge>8192))throw std::runtime_error("Invalid video size cap");
                            if(requestedEdge!=maxEdge){maxEdge=requestedEdge;force=true;}
                            encoder.configure(rate,hz,gop);fps=hz;
                            if(op=="video-start"){enabled=true;force=true;next=std::chrono::steady_clock::now();}
                            result["adaptiveResolutionVersion"]=1;result["profile"]="baseline";result["maxPendingFrames"]=1;
                        }else if(op=="video"){
                            enabled=command.at("enabled").get<bool>();force=enabled;if(enabled){check(media,"Windows Media Feature Pack required");next=std::chrono::steady_clock::now();}else{cursor=false;capture.independentCursor=false;reset();}
                        }else if(op=="video-stats"){
                            result={{"ok",true},{"pendingFrames",0},{"queuedFrames",0},{"admissionLimit",1},{"coalescedFrames",coalesced},{"suppressedFrames",suppressed},{"encodeLatencyMs",latency},{"droppedFrames",dropped},{"sequence",++sequence},{"sampledAt",wallMilliseconds()},{"activity",activity},{"activityConfidence",0.9}};dropped=0;coalesced=0;suppressed=0;
                        }else if(op=="compound-enable"){
                            compoundEnabled=command.at("enabled").get<bool>();compound.configure(compoundEnabled);force=true;result["version"]=1;result["codec"]="png";
                        }else if(op=="compound-sample") result=compound.sample(command);
                        else if(op=="cursor-enable"){
                            bool wanted=command.at("enabled").get<bool>();
                            if(wanted&&!capture.canSeparateCursor())throw std::runtime_error("DXGI separate cursor not available");
                            cursor=wanted;capture.independentCursor=wanted;cutover.reset();force=true;next=std::chrono::steady_clock::now();
                            if(!cursor)emit({{"event","cursor"},{"sequence",++cursorSequence},{"active",false},{"visible",false},{"x",0},{"y",0},{"cutoverRtp",0}});
                            result["version"]=1;
                        }else if(op=="set-display"){
                            capture.select(command.at("displayId").get<std::string>());encoder.reset();force=true;cutover.reset();compound.configure(compoundEnabled);
                        }else if(op=="set-quality"){
                            auto value=command.at("quality").get<std::string>();dimensions(100,100,value);quality=value;encoder.reset();force=true;cutover.reset();
                        }else throw std::runtime_error("Unknown video operation");
                    }catch(const std::exception& error){result={{"ok",false},{"error",error.what()}};}
                    if(reply){result["id"]=command["id"];emit(result);}
                }
                bool available=desktopAvailable();
                if(!available&&availableBefore){encoder.reset();capture.reset();last.reset();cutover.reset();force=true;}
                availableBefore=available;
                auto now=std::chrono::steady_clock::now();
                if(enabled&&available&&now>=next){
                    next=now+std::chrono::microseconds(1'000'000/std::max(1,fps));
                    try {
                        auto frame=capture.frame();coalesced+=frame.coalescedFrames;cursorBounds.width=frame.width;cursorBounds.height=frame.height;cursorBounds.x=frame.x;cursorBounds.y=frame.y;
                        auto pixels=videoPixels(frame,quality,maxEdge);
                        bool changed=!last||last->width!=pixels->width||last->height!=pixels->height||last->pixels!=pixels->pixels;
                        if(changed){changedAt=now;activity="interactive";}else if(now-changedAt>=std::chrono::milliseconds(500))activity="idle";
                        last=std::move(pixels);compound.change(last,wallMilliseconds());
                        auto output=[&](const Json& encoded){if(desktopAvailable()&&!encoded.is_null()){compound.delivered(encoded.at("timestamp").get<double>());emit(encoded);}};
                        // Drain delayed MFT output even when no new pixels need submission.
                        output(encoder.drain());
                        double nowMs=std::chrono::duration<double,std::milli>(now.time_since_epoch()).count();
                        if(admission.shouldSubmit(changed,force||!encoder.ready(),nowMs)){
                            auto began=std::chrono::steady_clock::now();output(encoder.encode(*last,quality,force));
                            auto elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-began).count();latency=latency==0?elapsed:latency*0.8+elapsed*0.2;
                        }else suppressed++;
                    }catch(const std::exception& error){dropped++;enabled=false;reset();emit({{"event","video-error"},{"error",error.what()}});}
                }
                if(cursor&&last&&cutover&&available&&now>=cursorNext){
                    cursorNext=now+std::chrono::milliseconds(33);bool shape=now>=shapeNext;if(shape)shapeNext=now+std::chrono::seconds(1);
                    // Cursor coordinates use the physical display bounds, before quality scaling.
                    auto event=cursorMetadata(cursorBounds,++cursorSequence,*cutover,shape);
                    double scale=double(last->width)/std::max(1,cursorBounds.width);event["pixelScale"]=scale;event["drawWidth"]=64*scale;event["drawHeight"]=64*scale;
                    if(event.contains("hotX"))event["hotX"]=event["hotX"].get<double>()*scale;
                    if(event.contains("hotY"))event["hotY"]=event["hotY"].get<double>()*scale;
                    emit(event);
                }
            }
        }catch(const std::exception& error){try{emit({{"event","video-error"},{"error",error.what()}});}catch(...){}}
        encoder.reset();capture.reset();if(SUCCEEDED(media))MFShutdown();if(SUCCEEDED(com))CoUninitialize();
    }
};
VideoPipeline::VideoPipeline(std::function<void(const Json&)> emit):state(new State(std::move(emit))){}
VideoPipeline::~VideoPipeline(){{std::lock_guard<std::mutex> lock(state->mutex);state->quitting=true;}state->signal.notify_one();state->worker.join();}
void VideoPipeline::submit(const Json& command){
    {std::lock_guard<std::mutex> lock(state->mutex);if(state->commands.size()>=128)throw std::runtime_error("Video command queue full");state->commands.push_back(command);}state->signal.notify_one();
}
}
