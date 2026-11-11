// Offline host only: no WeCom process, account, network, or chat data.
#define AGENT_WECOM_BRIDGE_TEST 1
#import "NativeInjectBridge.m"
#import <fcntl.h>

@interface TestConversation : NSObject
@property(nonatomic, copy) NSString *conversationId;
@end
@implementation TestConversation
@end

@interface WEWInputViewController : NSViewController
@property(nonatomic, strong) NSTextView *inputTextView;
@property(nonatomic, strong) TestConversation *conversation;
@property(nonatomic) NSUInteger sendCount;
- (void)sendSingleMsg:(id)sender;
@end
@implementation WEWInputViewController
- (void)sendSingleMsg:(__unused id)sender { self.sendCount++; self.inputTextView.string = @""; }
@end

@interface PointerGetter : NSObject
- (void *)unsafeValue;
@end
@implementation PointerGetter
- (void *)unsafeValue { abort(); }
@end

@interface AmbiguousConversation : NSObject
- (NSString *)conversationId;
- (NSString *)rid;
@end
@implementation AmbiguousConversation
- (NSString *)conversationId { return @"12"; }
- (NSString *)rid { return @"13"; }
@end

@interface RoundedConversation : NSObject
- (NSNumber *)conversationId;
@end
@implementation RoundedConversation
- (NSNumber *)conversationId { return @(9007199254740992.0); }
@end

static void require(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); exit(1); }
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        require(argc == 2, @"Pass a new temporary fixture root");
        NSString *root = @(argv[1]);
        NSString *database = [root stringByAppendingPathComponent:@"Profiles/test/Messages1/Info.db"];
        require([NSFileManager.defaultManager createDirectoryAtPath:database.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil], @"fixture directory");
        int fixture = open(database.fileSystemRepresentation, O_CREAT | O_EXCL | O_RDWR, 0600);
        require(fixture >= 0, @"new fixture database placeholder");
        require(profileMatches(database), @"exact held profile");
        require(!profileMatches([root stringByAppendingPathComponent:@"other"]), @"unknown profile rejected");
        require(getter([PointerGetter new], @"unsafeValue", NO) == nil, @"pointer getter not invoked");
        require(conversationId([AmbiguousConversation new]) == nil, @"conflicting identity getters rejected");
        require(conversationId([RoundedConversation new]) == nil, @"floating-point identities rejected");
        require(!decimalString(@"1e2") && !decimalString(@"１２") && decimalString(@"1152921504606846983"), @"IDs remain ASCII decimal strings");

        [NSApplication sharedApplication];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        WEWInputViewController *controller = [WEWInputViewController new];
        controller.inputTextView = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 400, 150)];
        controller.view = controller.inputTextView;
        controller.conversation = [TestConversation new];
        controller.conversation.conversationId = @"1152921504606846983";
        window.contentViewController = controller;
        instanceId = @"offline-instance"; submissions = [NSMutableDictionary dictionary]; sendingEnabled = NO;
        NSMutableDictionary *request = [@{@"cmd": @"send", @"instanceId": instanceId, @"pid": @(getpid()),
            @"accountId": @"99", @"conversationId": @"1152921504606846983", @"deliveryId": @"one",
            @"clientDatabase": database, @"text": @"offline simulated text"} mutableCopy];
        require([handle(@{@"cmd": @"status"})[@"state"] isEqual:@"ready"], @"status ready without UI access");
        require([handle(request)[@"state"] isEqual:@"blocked"] && controller.sendCount == 0, @"disabled means no send");
        sendingEnabled = YES;
        request[@"instanceId"] = @"stale";
        require([handle(request)[@"state"] isEqual:@"blocked"], @"stale instance"); request[@"instanceId"] = instanceId;
        request[@"conversationId"] = @"3";
        require([handle(request)[@"state"] isEqual:@"blocked"] && controller.sendCount == 0, @"wrong exact ID blocks without selecting");
        request[@"conversationId"] = @"1152921504606846983";
        controller.inputTextView.string = @"existing user draft";
        require([handle(request)[@"state"] isEqual:@"blocked"] && [controller.inputTextView.string isEqual:@"existing user draft"], @"preserve draft");
        controller.inputTextView.string = @"";
        request[@"cmd"] = @"preflight";
        require([handle(request)[@"state"] isEqual:@"ready"] && controller.sendCount == 0 && !controller.inputTextView.string.length, @"preflight is read-only");
        request[@"cmd"] = @"send";
        require([handle(request)[@"state"] isEqual:@"submitted"] && controller.sendCount == 1, @"invoke exactly once");
        require([handle(request)[@"state"] isEqual:@"unknown"] && controller.sendCount == 1, @"duplicate never invokes again");
        request[@"text"] = @"changed";
        require([handle(request)[@"state"] isEqual:@"blocked"] && controller.sendCount == 1, @"delivery fingerprint mismatch");
        request[@"deliveryId"] = @"queued-cancel";
        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block NSDictionary *timeout;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{ timeout = dispatchMain(request, YES); dispatch_semaphore_signal(completed); });
        require(dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 7 * NSEC_PER_SEC)) == 0, @"bounded main queue timeout");
        require([timeout[@"state"] isEqual:@"blocked"], @"queued send cancelled before starting");
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.2];
        while ([deadline timeIntervalSinceNow] > 0) [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:deadline];
        require(controller.sendCount == 1 && !controller.inputTextView.string.length, @"cancelled queued send never runs later");
        require([handle(@{@"cmd": @"open_conv", @"conv_name": @"anything"})[@"state"] isEqual:@"blocked"], @"legacy selection command rejected");
        close(fixture);
        printf("PASS: native bridge guards (offline simulated host); no real messages sent\n");
    }
    return 0;
}
