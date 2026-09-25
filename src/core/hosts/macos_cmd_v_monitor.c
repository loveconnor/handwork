#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

typedef struct {
    CFMachPortRef tap;
    CFRunLoopSourceRef source;
    CFRunLoopRef run_loop;
    bool pending;
} HandworkCmdVMonitor;

static CGEventRef observe_key(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *user_info) {
    (void)proxy;
    HandworkCmdVMonitor *monitor = user_info;
    if (type == kCGEventKeyDown &&
        CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == 9 &&
        CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) == 0 &&
        (CGEventGetFlags(event) & kCGEventFlagMaskCommand) != 0) {
        monitor->pending = true;
    }
    return event;
}

void *handwork_cmd_v_monitor_create(int *status) {
    *status = 2;
    if (!CGPreflightListenEventAccess() && !CGRequestListenEventAccess()) return NULL;

    HandworkCmdVMonitor *monitor = calloc(1, sizeof(*monitor));
    if (monitor == NULL) {
        *status = 3;
        return NULL;
    }
    monitor->tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                                    kCGEventTapOptionListenOnly, CGEventMaskBit(kCGEventKeyDown),
                                    observe_key, monitor);
    if (monitor->tap == NULL) {
        free(monitor);
        *status = 3;
        return NULL;
    }
    monitor->source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, monitor->tap, 0);
    if (monitor->source == NULL) {
        CFRelease(monitor->tap);
        free(monitor);
        *status = 3;
        return NULL;
    }
    monitor->run_loop = CFRunLoopGetCurrent();
    CFRetain(monitor->run_loop);
    CFRunLoopAddSource(monitor->run_loop, monitor->source, kCFRunLoopDefaultMode);
    *status = 1;
    return monitor;
}

bool handwork_cmd_v_monitor_poll(void *opaque) {
    HandworkCmdVMonitor *monitor = opaque;
    if (!CGEventTapIsEnabled(monitor->tap)) CGEventTapEnable(monitor->tap, true);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true);
    const bool pending = monitor->pending;
    monitor->pending = false;
    return pending;
}

void handwork_cmd_v_monitor_destroy(void *opaque) {
    HandworkCmdVMonitor *monitor = opaque;
    CFRunLoopRemoveSource(monitor->run_loop, monitor->source, kCFRunLoopDefaultMode);
    CFRelease(monitor->run_loop);
    CFRelease(monitor->source);
    CFRelease(monitor->tap);
    free(monitor);
}
