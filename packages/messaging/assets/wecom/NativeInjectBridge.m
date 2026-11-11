// Version-pinned experimental in-process bridge. No AX, key events or C++ ABI guesses.
// Sending is disabled unless AGENT_WECOM_INJECT_ALLOW_SEND=1 at client launch.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <libproc.h>
#import <sys/proc_info.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <pthread.h>
#import <unistd.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>

#ifndef AGENT_WECOM_BRIDGE_SOURCE_SHA256
#define AGENT_WECOM_BRIDGE_SOURCE_SHA256 "unbuilt"
#endif
#define SOURCE_SHA256 @"079eabdc95281c62b4daf7f431124dff53caf5d11ccbe1f8715b2b2f56a4daf2"
static const NSUInteger FrameLimit = 65536;
static NSString *instanceId;
static NSMutableDictionary<NSString *, NSDictionary *> *submissions;
static BOOL sendingEnabled;

static NSDictionary *reply(BOOL ok, NSString *state, NSString *detail) {
    NSBundle *bundle = NSBundle.mainBundle;
    return @{@"ok": @(ok), @"state": state, @"detail": detail,
        @"protocol": @2, @"instanceId": instanceId, @"pid": @(getpid()),
        @"appVersion": [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
        @"appBuild": [bundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"",
        @"sourceSha256": SOURCE_SHA256,
        @"bridgeSourceSha256": @AGENT_WECOM_BRIDGE_SOURCE_SHA256,
        @"sendingEnabled": @(sendingEnabled)};
}

static BOOL decimalString(id value) {
    return [value isKindOfClass:NSString.class] && [value length] > 0 && [value length] <= 20 &&
        [value rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet].location == NSNotFound &&
        [value rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"0123456789"].invertedSet].location == NSNotFound;
}

// Read only declared zero-argument object/integer getters. Never interpret a C++ pointer as id.
static id getter(id object, NSString *name, BOOL integerAllowed) {
    if (!object) return nil;
    SEL selector = NSSelectorFromString(name);
    if (![object respondsToSelector:selector]) return nil;
    NSMethodSignature *signature = [object methodSignatureForSelector:selector];
    if (!signature || signature.numberOfArguments != 2) return nil;
    const char *type = signature.methodReturnType;
    BOOL objectResult = strcmp(type, "@") == 0;
    BOOL integerResult = integerAllowed && (strcmp(type, "Q") == 0 || strcmp(type, "q") == 0 ||
        strcmp(type, "I") == 0 || strcmp(type, "i") == 0);
    if (!objectResult && !integerResult) return nil;
    @try {
        NSInvocation *call = [NSInvocation invocationWithMethodSignature:signature];
        call.target = object; call.selector = selector; [call invoke];
        if (strcmp(type, "@") == 0) {
            __unsafe_unretained id result = nil;
            [call getReturnValue:&result];
            return result;
        }
        if (integerAllowed && (strcmp(type, "Q") == 0 || strcmp(type, "q") == 0)) {
            unsigned long long result = 0; [call getReturnValue:&result];
            return [NSString stringWithFormat:@"%llu", result];
        }
        if (integerAllowed && (strcmp(type, "I") == 0 || strcmp(type, "i") == 0)) {
            unsigned int result = 0; [call getReturnValue:&result];
            return [NSString stringWithFormat:@"%u", result];
        }
    } @catch (__unused NSException *error) {}
    return nil;
}

static NSString *conversationId(id conversation) {
    NSMutableSet *ids = [NSMutableSet set];
    for (NSString *name in @[@"conversationId", @"convId", @"remoteId", @"rid"]) {
        id value = getter(conversation, name, YES);
        if ([value isKindOfClass:NSNumber.class]) {
            const char *type = [value objCType];
            // Reject floating-point identities rather than accepting an already rounded value.
            if (strlen(type) != 1 || !strchr("cCsSiIlLqQ", type[0])) return nil;
            value = [value stringValue];
        }
        if (decimalString(value)) [ids addObject:value];
    }
    return ids.count == 1 ? ids.anyObject : nil;
}

static NSString *currentId(id controller) {
    NSMutableSet *ids = [NSMutableSet set];
    NSMutableSet *visited = [NSMutableSet set];
    for (id responder = controller; responder && visited.count < 40;) {
        NSValue *key = [NSValue valueWithNonretainedObject:responder];
        if ([visited containsObject:key]) break;
        [visited addObject:key];
        for (NSString *name in @[@"conversation", @"currentConversation", @"convInfo", @"conversationInfo", @"mobileConversation"]) {
            NSString *value = conversationId(getter(responder, name, NO));
            if (value) [ids addObject:value];
        }
        // Only an Objective-C object ivar is safe to read via object_getIvar.
        Ivar ivar = class_getInstanceVariable([responder class], "_mobileConversation");
        if (ivar && ivar_getTypeEncoding(ivar)[0] == '@') {
            NSString *value = conversationId(object_getIvar(responder, ivar));
            if (value) [ids addObject:value];
        }
        responder = getter(responder, @"nextResponder", NO);
    }
    return ids.count == 1 ? ids.anyObject : nil;
}

static BOOL validSendMethod(id object) {
    NSMethodSignature *signature = [object methodSignatureForSelector:NSSelectorFromString(@"sendSingleMsg:")];
    return signature && signature.numberOfArguments == 3 && strcmp(signature.methodReturnType, "v") == 0 &&
        strcmp([signature getArgumentTypeAtIndex:2], "@") == 0;
}

static NSArray *inputControllers(void) {
    Class inputClass = NSClassFromString(@"WEWInputViewController");
    if (!inputClass) return @[];
    NSMutableArray *queue = [NSMutableArray array];
    for (NSWindow *window in NSApplication.sharedApplication.windows) {
        if (window.contentView) [queue addObject:window.contentView];
        if (window.contentViewController) [queue addObject:window.contentViewController];
        if (window.firstResponder) [queue addObject:window.firstResponder];
    }
    NSMutableSet *visited = [NSMutableSet set];
    NSMutableArray *found = [NSMutableArray array];
    while (queue.count && visited.count < 10000) {
        id object = queue.lastObject; [queue removeLastObject];
        NSValue *key = [NSValue valueWithNonretainedObject:object];
        if ([visited containsObject:key]) continue;
        [visited addObject:key];
        if ([object isKindOfClass:inputClass] && validSendMethod(object)) [found addObject:object];
        for (NSString *name in @[@"nextResponder", @"view"]) {
            id next = getter(object, name, NO);
            if (next && next != object) [queue addObject:next];
        }
        for (NSString *name in @[@"subviews", @"childViewControllers"]) {
            id children = getter(object, name, NO);
            if ([children isKindOfClass:NSArray.class]) [queue addObjectsFromArray:children];
        }
    }
    return found;
}

static id inputView(id controller) {
    id view = getter(controller, @"inputTextView", NO);
    return [view isKindOfClass:NSTextView.class] ? view : nil;
}

static NSString *canonical(NSString *path) {
    char resolved[PATH_MAX];
    return realpath(path.fileSystemRepresentation, resolved) ? @(resolved) : nil;
}

static BOOL profileMatches(NSString *expected) {
    NSString *wanted = canonical(expected);
    if (!wanted) return NO;
    int size = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
    if (size <= 0 || size > 4 * 1024 * 1024) return NO;
    struct proc_fdinfo *fds = calloc(1, (size_t)size);
    if (!fds) return NO;
    int received = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, size);
    NSMutableSet *paths = [NSMutableSet set], *profiles = [NSMutableSet set];
    NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"/Profiles/[^/]+/Messages[0-9]*/Info\\.db$" options:0 error:nil];
    for (int i = 0; received > 0 && i < received / (int)sizeof(*fds); i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
        struct vnode_fdinfowithpath info = {0};
        if (proc_pidfdinfo(getpid(), fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &info, sizeof(info)) != sizeof(info)) continue;
        NSString *path = [NSString stringWithUTF8String:info.pvip.vip_path];
        if (!path || ![pattern firstMatchInString:path options:0 range:NSMakeRange(0, path.length)]) continue;
        NSString *resolved = canonical(path);
        if (resolved) { [paths addObject:resolved]; [profiles addObject:resolved.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent]; }
    }
    free(fds);
    return profiles.count == 1 && [paths containsObject:wanted];
}

static NSString *validate(NSDictionary *request) {
    if (!sendingEnabled) return @"Sending is disabled for this experimental client";
    if (![request[@"instanceId"] isEqual:instanceId] || ![request[@"pid"] isEqual:@(getpid())]) return @"Client instance changed";
    if (!decimalString(request[@"accountId"]) || !decimalString(request[@"conversationId"])) return @"Exact account and conversation IDs are required";
    if (![request[@"deliveryId"] isKindOfClass:NSString.class] || ![request[@"deliveryId"] length] || [request[@"deliveryId"] length] > 200) return @"Invalid delivery ID";
    if (![request[@"text"] isKindOfClass:NSString.class] || ![request[@"text"] length] || [request[@"text"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 20000) return @"Invalid text";
    if (![request[@"clientDatabase"] isKindOfClass:NSString.class] || !profileMatches(request[@"clientDatabase"])) return @"Client does not hold the exact single configured profile";
    return nil;
}

// Resolve the current exact ID only: no fuzzy names, row selection, setters or C++ calls.
static NSDictionary *onMain(NSDictionary *request, BOOL send) {
    NSString *problem = validate(request);
    if (problem) return reply(NO, @"blocked", problem);
    NSMutableArray *matches = [NSMutableArray array];
    for (id candidate in inputControllers()) {
        if ([currentId(candidate) isEqual:request[@"conversationId"]]) [matches addObject:candidate];
    }
    if (matches.count != 1) return reply(NO, @"blocked", @"Current conversation ID is unavailable, different or ambiguous; no conversation was selected");
    id controller = matches[0];
    NSTextView *editor = inputView(controller);
    if (!editor || editor.string.length || editor.hasMarkedText) return reply(NO, @"blocked", @"Input is unavailable or contains an existing draft");
    NSMutableDictionary *result = [reply(YES, @"ready", @"Exact profile and current conversation verified") mutableCopy];
    result[@"accountId"] = request[@"accountId"]; result[@"conversationId"] = request[@"conversationId"];
    if (!send) return result;
    if (![currentId(controller) isEqual:request[@"conversationId"]] || !profileMatches(request[@"clientDatabase"])) return reply(NO, @"blocked", @"Identity changed before submission");
    @try {
        [editor setString:request[@"text"]];
        if (![editor.string isEqual:request[@"text"]] || ![currentId(controller) isEqual:request[@"conversationId"]]) {
            // Preserve the prepared draft for inspection; never submit on changed state.
            return reply(NO, @"blocked", @"Prepared text or conversation changed; no send method invoked");
        }
        ((void (*)(id, SEL, id))objc_msgSend)(controller, NSSelectorFromString(@"sendSingleMsg:"), nil);
        result[@"state"] = @"submitted"; result[@"detail"] = @"Client send method invoked once; native outgoing record still required";
        return result;
    } @catch (__unused NSException *error) {
        return reply(NO, @"unknown", @"Client method interrupted; inspect the original conversation and do not resend");
    }
}

static NSDictionary *dispatchMain(NSDictionary *request, BOOL send) {
    if (NSThread.isMainThread) return onMain(request, send);
    NSObject *gate = [NSObject new];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block BOOL cancelled = NO, started = NO;
    __block NSDictionary *result;
    dispatch_async(dispatch_get_main_queue(), ^{
        @synchronized (gate) { if (cancelled) { dispatch_semaphore_signal(done); return; } started = YES; }
        @try { result = onMain(request, send); }
        @catch (__unused NSException *error) { result = reply(NO, send ? @"unknown" : @"blocked", @"Main-thread operation interrupted"); }
        dispatch_semaphore_signal(done);
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0) return result;
    @synchronized (gate) {
        cancelled = YES;
        return reply(NO, started && send ? @"unknown" : @"blocked", started ? @"Main-thread operation timed out" : @"Queued operation cancelled before it started");
    }
}

static NSDictionary *handle(NSDictionary *request) {
    NSString *cmd = request[@"cmd"];
    if (![cmd isKindOfClass:NSString.class]) return reply(NO, @"blocked", @"Missing command");
    if ([cmd isEqual:@"status"]) return reply(YES, @"ready", @"Read-only bridge status; no conversation accessed");
    if (![cmd isEqual:@"preflight"] && ![cmd isEqual:@"send"]) return reply(NO, @"blocked", @"Unsupported command");
    BOOL send = [cmd isEqual:@"send"];
    NSString *problem = validate(request);
    if (problem) return reply(NO, @"blocked", problem);
    NSString *delivery = request[@"deliveryId"];
    NSArray *fingerprint = @[request[@"accountId"], request[@"conversationId"], request[@"clientDatabase"], request[@"text"]];
    if (send && submissions[delivery]) {
        NSDictionary *previous = submissions[delivery];
        if (![previous[@"fingerprint"] isEqual:fingerprint]) return reply(NO, @"blocked", @"Delivery ID reused with different identity or text");
        return reply(NO, @"unknown", @"Delivery was already submitted or interrupted; use the receiver record and do not resend");
    }
    if (send && submissions.count >= 1000) return reply(NO, @"blocked", @"Client delivery cache full; no automatic eviction or resend");
    if (send) submissions[delivery] = @{@"fingerprint": fingerprint};
    NSDictionary *result = dispatchMain(request, send);
    if (send && [result[@"state"] isEqual:@"blocked"]) [submissions removeObjectForKey:delivery];
    return result;
}

static void serveClient(int fd) {
    uid_t uid; gid_t gid;
    if (getpeereid(fd, &uid, &gid) != 0 || uid != getuid()) return;
    struct timeval timeout = {.tv_sec = 10};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    int noSigpipe = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, sizeof(noSigpipe));
    NSMutableData *data = [NSMutableData data];
    BOOL complete = NO;
    while (data.length <= FrameLimit) {
        char chunk[4096]; ssize_t count = read(fd, chunk, sizeof(chunk));
        if (count <= 0) break;
        [data appendBytes:chunk length:(NSUInteger)count];
        if (memchr(chunk, '\n', (size_t)count)) { complete = YES; break; }
    }
    NSDictionary *result;
    if (!complete || data.length > FrameLimit) result = reply(NO, @"blocked", @"Request frame incomplete or too large");
    else {
        const char *bytes = data.bytes;
        NSUInteger length = (NSUInteger)((const char *)memchr(bytes, '\n', data.length) - bytes);
        id request = [NSJSONSerialization JSONObjectWithData:[data subdataWithRange:NSMakeRange(0, length)] options:0 error:nil];
        result = [request isKindOfClass:NSDictionary.class] ? handle(request) : reply(NO, @"blocked", @"Request must be a JSON object");
    }
    NSMutableData *output = [[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] mutableCopy];
    [output appendBytes:"\n" length:1];
    const char *bytes = output.bytes;
    for (NSUInteger offset = 0; offset < output.length;) {
        ssize_t count = write(fd, bytes + offset, output.length - offset);
        if (count <= 0) break;
        offset += (NSUInteger)count;
    }
}

static void *server(__unused void *unused) {
    @autoreleasepool {
        const char *path = getenv("AGENT_WECOM_INJECT_SOCKET");
        if (!path || !path[0] || strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) return NULL;
        NSString *parent = [@(path) stringByDeletingLastPathComponent];
        struct stat info;
        if (lstat(parent.fileSystemRepresentation, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0077)) return NULL;
        // Never remove an existing endpoint; each experiment uses a new private path.
        if (lstat(path, &info) == 0 || errno != ENOENT) return NULL;
        int listener = socket(AF_UNIX, SOCK_STREAM, 0);
        if (listener < 0) return NULL;
        fcntl(listener, F_SETFD, FD_CLOEXEC);
        struct sockaddr_un address = {.sun_family = AF_UNIX};
        strlcpy(address.sun_path, path, sizeof(address.sun_path)); address.sun_len = sizeof(address);
        if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || chmod(path, 0600) || listen(listener, 4)) { close(listener); return NULL; }
        for (;;) {
            int client = accept(listener, NULL, NULL);
            if (client < 0) { if (errno == EINTR) continue; break; }
            fcntl(client, F_SETFD, FD_CLOEXEC);
            @autoreleasepool { @try { serveClient(client); } @catch (__unused NSException *error) {} }
            close(client);
        }
        close(listener);
    }
    return NULL;
}

#ifndef AGENT_WECOM_BRIDGE_TEST
__attribute__((constructor)) static void start(void) {
    @autoreleasepool {
        if (![NSBundle.mainBundle.bundleIdentifier isEqual:@"com.tencent.WeWorkMac"] ||
            ![[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] isEqual:@"5.0.13"] ||
            ![[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"] isEqual:@"95049"]) return;
        // The startup library is already mapped. Never inject it into vendor GPU/network helpers.
        unsetenv("DYLD_INSERT_LIBRARIES");
        instanceId = NSUUID.UUID.UUIDString; submissions = [NSMutableDictionary dictionary];
        sendingEnabled = strcmp(getenv("AGENT_WECOM_INJECT_ALLOW_SEND") ?: "", "1") == 0;
        pthread_t thread;
        if (pthread_create(&thread, NULL, server, NULL) == 0) pthread_detach(thread);
    }
}
#endif
