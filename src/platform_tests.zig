//! Platform adapters can be compiled and tested before the entire CLI port is
//! ready. Keep this root independent of application, provider and session code.
test {
    _ = @import("core/hosts/process_startup.zig");
    _ = @import("core/hosts/windows_file_io.zig");
    _ = @import("core/hosts/windows_private_storage.zig");
    _ = @import("core/hosts/windows_paths.zig");
    _ = @import("core/hosts/windows_sockets.zig");
    _ = @import("core/hosts/windows_processes.zig");
    _ = @import("core/hosts/windows_shell.zig");
    _ = @import("ui/terminal/windows_console.zig");
}
