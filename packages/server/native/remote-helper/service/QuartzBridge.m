#import "QuartzBridge.h"
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach_time.h>

typedef void *(*CreateStream)(CGDirectDisplayID, size_t, size_t, int32_t, CFDictionaryRef,
    dispatch_queue_t, void (^)(int, uint64_t, IOSurfaceRef, void *));
typedef int (*ControlStream)(void *);

// The stream owns its callback. Keep its CF reference until the final stopped
// callback, as required by CGDisplayStream; never block the callback queue.
@interface ARDStreamState : NSObject
@property void *stream;
@property dispatch_queue_t queue;
@property BOOL started;
@property BOOL stopped;
@property BOOL closing;
@end
@implementation ARDStreamState
@end
static void releaseStream(ARDStreamState *state) {
    if (state.stream) { void *stream = state.stream; state.stream = NULL; CFRelease(stream); }
}

void *ARDCreateDisplayStream(CGDirectDisplayID display, size_t width, size_t height,
    dispatch_queue_t queue, void (^handler)(int, uint64_t, IOSurfaceRef)) {
    CreateStream create = (CreateStream)dlsym(RTLD_DEFAULT, "CGDisplayStreamCreateWithDispatchQueue");
    if (!create || !dlsym(RTLD_DEFAULT, "CGDisplayStreamStart") || !dlsym(RTLD_DEFAULT, "CGDisplayStreamStop")) return NULL;
    CFStringRef *interval = dlsym(RTLD_DEFAULT, "kCGDisplayStreamMinimumFrameTime");
    CFStringRef *cursor = dlsym(RTLD_DEFAULT, "kCGDisplayStreamShowCursor");
    NSMutableDictionary *options = [NSMutableDictionary dictionary];
    if (interval) options[(__bridge NSString *)*interval] = @0.25;
    if (cursor) options[(__bridge NSString *)*cursor] = @YES;
    ARDStreamState *state = [ARDStreamState new]; state.queue = queue;
    state.stream = create(display, width, height, 'BGRA', (__bridge CFDictionaryRef)options, queue,
        ^(int status, uint64_t time, IOSurfaceRef surface, void *update) {
            if (status == 3) state.stopped = YES;
            if (!state.closing) handler(status, time, surface);
            if (state.closing && state.stopped) releaseStream(state);
        });
    return state.stream ? (__bridge_retained void *)state : NULL;
}
int ARDStartDisplayStream(void *handle) {
    ARDStreamState *state = (__bridge ARDStreamState *)handle;
    if (!state) return -1;
    ControlStream start = (ControlStream)dlsym(RTLD_DEFAULT, "CGDisplayStreamStart");
    __block int result = -1;
    dispatch_sync(state.queue, ^{ if (start) result = start(state.stream); state.started = result == 0; });
    return result;
}
void ARDStopDisplayStream(void *handle) {
    if (!handle) return;
    ARDStreamState *state = (__bridge_transfer ARDStreamState *)handle;
    dispatch_async(state.queue, ^{
        state.closing = YES;
        if (!state.started || state.stopped) { releaseStream(state); return; }
        ControlStream stop = (ControlStream)dlsym(RTLD_DEFAULT, "CGDisplayStreamStop");
        if (stop) stop(state.stream);
        // Successful start retains the stream until its final callback.
    });
}
double ARDHostTimeSeconds(uint64_t time) {
    mach_timebase_info_data_t info; mach_timebase_info(&info);
    return (double)time * info.numer / info.denom / 1e9;
}
