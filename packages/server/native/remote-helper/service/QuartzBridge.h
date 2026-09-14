#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <dispatch/dispatch.h>
// Runtime lookup keeps the deprecated public capture API optional on newer SDKs.
void *ARDCreateDisplayStream(CGDirectDisplayID display, size_t width, size_t height,
    dispatch_queue_t queue, void (^handler)(int status, uint64_t displayTime, IOSurfaceRef surface));
int ARDStartDisplayStream(void *stream);
void ARDStopDisplayStream(void *stream);
double ARDHostTimeSeconds(uint64_t time);
