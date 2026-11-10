#include "algorithms.hpp"
#include <iostream>
int main() {
    remote::algorithmSelfTest();
    remote::StaticVideoAdmission admission;
    if(!admission.shouldSubmit(false,false,0))throw std::runtime_error("First input missing");
    admission.submitted(0);
    for(int n=1;n<30;n++)if(admission.shouldSubmit(false,false,n*33))throw std::runtime_error("Static input repeated");
    if(!admission.shouldSubmit(false,false,1000)||!admission.shouldSubmit(false,true,10)||!admission.shouldSubmit(true,false,10))throw std::runtime_error("Keepalive/force/change missing");
    admission.reset();if(!admission.shouldSubmit(false,false,1))throw std::runtime_error("Reset input missing");
    if(remote::adaptiveVideoDimensions(3840,2160,"hd",960)!=std::pair<int,int>{960,540})throw std::runtime_error("Adaptive scaling failed");
    if(remote::adaptiveVideoDimensions(3840,2160,"smooth",2560)!=std::pair<int,int>{1280,720})throw std::runtime_error("Quality ceiling exceeded");
    if(remote::adaptiveVideoDimensions(1024,768,"original",0)!=std::pair<int,int>{1024,768})throw std::runtime_error("Original dimensions changed");
    std::vector<uint8_t> old(128*128*4),next(old.size(),0);
    for(int y=0;y<128;y++)for(int x=0;x<128;x++){uint32_t value=uint32_t(x)*2654435761u ^ uint32_t(y)*2246822519u;memcpy(old.data()+(y*128+x)*4,&value,4);}
    for(int y=0;y<111;y++)memcpy(next.data()+y*128*4,old.data()+(y+17)*128*4,128*4);
    auto copy=remote::findPixelScroll(old,next,128,128);
    if(!copy||copy->sourceY!=17||copy->y!=0||copy->height!=111)throw std::runtime_error("Pixel scroll detection failed");
    next[100*128*4+4]^=1;
    if(remote::findPixelScroll(old,next,128,128))throw std::runtime_error("Unverified scroll admitted");
    if(remote::findPixelScroll(old,old,128,128))throw std::runtime_error("Static desktop treated as scrolling");
    std::cout << "Coordinates, rotation, quality, H264 and exact pixel scroll validation passed\n";
}
