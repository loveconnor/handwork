//! Compile the application-facing terminal adapter as well as the low-level
//! console module. This object is never linked into the CLI or executed.
const terminal_runtime = @import("ui/shell_runtime.zig");
const std = @import("std");
const storage = @import("core/shared/io.zig");

export fn checkTerminalAdapter() void {
    var terminal: terminal_runtime.TerminalState = .{};
    terminal.ensureInteractive() catch return;
    terminal.captureOriginalTermios() catch return;
    terminal.enableRawMode() catch return;
    defer terminal.disableRawMode();
    _ = terminal.queryLayout(4) catch return;
    _ = terminal.queryCursorPosition() catch return;
    const ready = terminal.pollInput(0) catch return;
    if (ready.readable) {
        var bytes: [64]u8 = undefined;
        _ = terminal.read(&bytes) catch return;
    }
}

export fn checkPrivateStorageAdapter() void {
    var directory = storage.openOrCreateVerifiedPrivateDirFromDir(std.Io.Dir.cwd(), "platform-check") catch return;
    defer directory.close();
    storage.verifyPrivateDirectory(directory.dir) catch return;
    storage.durableReplaceVerified(std.heap.page_allocator, &directory, "fixture", "synthetic data") catch return;
    var lock = storage.acquireTimedAdvisoryLock(&directory, "fixture.lock", 0) catch return;
    defer lock.release();
    storage.verifyOwnerOnlyRegularFile(lock.file) catch return;
    var existing = storage.openExistingPrivateDirectory(std.Io.Dir.cwd(), "platform-check") catch return;
    defer existing.close();
}
