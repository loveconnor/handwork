#import <AppKit/AppKit.h>

// Used at key observation and before attaching. This does not inspect other
// applications' windows or require Accessibility access.
bool handwork_vscode_is_frontmost(void) {
    @autoreleasepool {
        NSString *identifier = [[NSWorkspace sharedWorkspace].frontmostApplication bundleIdentifier];
        return [identifier isEqualToString:@"com.microsoft.VSCode"] ||
               [identifier isEqualToString:@"com.microsoft.VSCodeInsiders"];
    }
}
