const std = @import("std");

const UpdateChannel = enum { stable, dev };

const WasmSurface = enum {
    none,
    core,
    term,
};

const PgsoArtifact = enum {
    handwork,
    file_index,
    ui_activity,
    approval_review,
};

const NapiSurface = enum {
    none,
    core,
};

pub fn build(b: *std.Build) void {
    // Use the same bundled Windows headers and ABI on native and cross builds.
    const target = b.standardTargetOptions(.{
        .default_target = if (@import("builtin").os.tag == .windows) .{ .abi = .gnu } else .{},
    });
    const optimize = b.standardOptimizeOption(.{});
    const windows_host = WindowsHost.init(b, target, optimize);
    const platform_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/platform_tests.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .error_tracing = true,
        }),
    });
    const platform_check = b.step("platform-check", "Compile platform adapter tests without running them");
    windows_host.addTo(platform_tests.root_module);
    platform_check.dependOn(&platform_tests.step);
    const terminal_platform_check = b.addObject(.{
        .name = "terminal-platform-check",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/terminal_platform_check.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    windows_host.addImports(terminal_platform_check.root_module);
    platform_check.dependOn(&terminal_platform_check.step);
    const platform_run = b.step("test-platform", "Run platform adapter tests on the target host");
    platform_run.dependOn(&b.addRunArtifact(platform_tests).step);
    const pgso_artifact = b.option(
        PgsoArtifact,
        "pgso-artifact",
        "Emit ReleaseSafe LLVM bitcode for one PGO/PGSO artifact",
    );
    const wasm_surface = b.option(
        WasmSurface,
        "wasm-surface",
        "Build a WASI WebAssembly surface for JavaScript hosts (core or term)",
    ) orelse .none;
    const napi_surface = b.option(
        NapiSurface,
        "napi-surface",
        "Build a Node-API addon surface (core)",
    ) orelse .none;

    const git_commit = readGitCommit(b);
    const app_version = readAppVersion(b);
    const update_channel = b.option(UpdateChannel, "update-channel", "Build update channel (stable or dev)") orelse .stable;

    const build_options = b.addOptions();
    build_options.addOption([]const u8, "git_commit", git_commit);
    build_options.addOption([]const u8, "app_version", app_version);
    build_options.addOption([]const u8, "update_channel", @tagName(update_channel));
    build_options.addOption(WasmSurface, "wasm_surface", .none);

    const exe = b.addExecutable(.{
        .name = "handwork",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .stack_check = false,
            .stack_protector = false,
            .omit_frame_pointer = true,
            // Zig 0.17's mingw CRT emits SEH directives that need unwind tables.
            .unwind_tables = if (target.result.os.tag == .windows) null else .none,
            .error_tracing = false,
            .strip = optimize != .debug,
        }),
    });
    exe.root_module.addImport("build_options", build_options.createModule());
    windows_host.addTo(exe.root_module);
    if (target.result.os.tag == .macos) {
        exe.root_module.linkFramework("ApplicationServices", .{});
        exe.root_module.linkFramework("AppKit", .{});
        exe.root_module.addCSourceFile(.{ .file = b.path("src/core/hosts/macos_cmd_v_monitor.c"), .flags = &.{} });
        exe.root_module.addCSourceFile(.{ .file = b.path("src/core/hosts/macos_frontmost_app.m"), .flags = &.{} });
    }

    b.installArtifact(exe);
    const runtime_files = b.addInstallDirectory(.{ .source_dir = b.path("runtime"), .install_dir = .lib, .install_subdir = "handwork", .exclude_extensions = &.{".test.mjs"} });
    b.getInstallStep().dependOn(&runtime_files.step);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    run_cmd.addPassthruArgs();

    const run_step = b.step("run", "Run handwork");
    run_step.dependOn(&run_cmd.step);

    const test_filter = b.option([]const u8, "test-filter", "Run tests whose names contain this string");
    const test_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .error_tracing = true,
    });
    test_module.addImport("build_options", build_options.createModule());
    // Tests that re-exec the product binary use the installed exe; the test
    // run step depends on the install step.
    const test_options = b.addOptions();
    test_options.addOptionPathUntracked(
        "product_exe",
        b.graph.path(.install_bin, b.fmt("handwork{s}", .{target.result.exeFileExt()})),
    );
    test_module.addImport("test_options", test_options.createModule());
    windows_host.addTo(test_module);
    const exe_tests = b.addTest(.{
        .root_module = test_module,
        .filters = if (test_filter) |filter| &.{filter} else &.{},
    });
    if (target.result.os.tag == .macos) {
        exe_tests.root_module.linkFramework("ApplicationServices", .{});
        exe_tests.root_module.linkFramework("AppKit", .{});
        exe_tests.root_module.addCSourceFile(.{ .file = b.path("src/core/hosts/macos_cmd_v_monitor.c"), .flags = &.{} });
        exe_tests.root_module.addCSourceFile(.{ .file = b.path("src/core/hosts/macos_frontmost_app.m"), .flags = &.{} });
    }
    const integration_module = b.createModule(.{
        .root_source_file = b.path("src/platform_integration_tests.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .error_tracing = true,
    });
    integration_module.addImport("build_options", build_options.createModule());
    const integration_test_options = b.addOptions();
    integration_test_options.addOption([]const u8, "product_exe", "");
    integration_module.addImport("test_options", integration_test_options.createModule());
    windows_host.addTo(integration_module);
    const integration_tests = b.addTest(.{ .root_module = integration_module, .filters = &.{"platform integration"} });
    platform_check.dependOn(&integration_tests.step);
    const integration_step = b.step("test-platform-integration", "Run storage and command platform journeys");
    integration_step.dependOn(&b.addRunArtifact(integration_tests).step);
    const run_exe_tests = b.addRunArtifact(exe_tests);
    run_exe_tests.step.dependOn(b.getInstallStep());

    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_exe_tests.step);

    const image_tests = b.addTest(.{
        .name = "image-tests",
        .root_module = test_module,
        .filters = &.{
            "core.images.codec",     "core.images.svg",       "core.images.vector",            "core.images.mermaid",
            "ui.images.",            "ui.terminal.graphics",  "core.shared.image_placeholder", "image placeholder",
            "image-only paragraphs", "image blocks render",   "standalone image rejection",    "APC graphics",
            "drawn-pixel flags",     "attachment thumbnails", "core.images.raster",
        },
    });
    const image_test_step = b.step("test-images", "Run inline image decoding, rendering, and integration tests");
    image_test_step.dependOn(&b.addRunArtifact(image_tests).step);
    const image_test_check = b.step("test-images-check", "Compile inline image tests for the selected target");
    image_test_check.dependOn(&image_tests.step);

    if (wasm_surface != .none) {
        addWasmArtifact(b, wasm_surface, git_commit, app_version, update_channel);
    }
    if (napi_surface != .none) {
        addNapiArtifact(b, napi_surface, target, git_commit, app_version, update_channel);
    }

    const mcp_test_exports = b.createModule(.{
        .root_source_file = b.path("src/mcp_test_exports.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mcp_test_exports.addImport("build_options", build_options.createModule());
    windows_host.addImports(mcp_test_exports);
    const mcp_dispatcher_e2e = b.addExecutable(.{
        .name = "mcp-stdio-dispatcher-driver",
        .root_module = b.createModule(.{
            .root_source_file = b.path(
                "tests/e2e/fixtures/mcp-stdio-dispatcher-driver.zig",
            ),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    mcp_dispatcher_e2e.root_module.addImport(
        "mcp_test_exports",
        mcp_test_exports,
    );
    const run_mcp_dispatcher_e2e = b.addRunArtifact(mcp_dispatcher_e2e);
    run_mcp_dispatcher_e2e.addPassthruArgs();
    const mcp_dispatcher_e2e_step = b.step(
        "run-mcp-stdio-dispatcher-e2e",
        "Run the MCP stdio dispatcher E2E driver",
    );
    mcp_dispatcher_e2e_step.dependOn(&run_mcp_dispatcher_e2e.step);

    // --- file_index search benchmark ---
    const benchmark_exports_mod = b.createModule(.{
        .root_source_file = b.path("src/benchmark_exports.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    windows_host.addImports(benchmark_exports_mod);
    const file_index_bench = b.addExecutable(.{
        .name = "file-index-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/file_index_bench.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    file_index_bench.root_module.addImport("file_index", benchmark_exports_mod);
    const install_bench = b.addInstallArtifact(file_index_bench, .{});
    const bench_step = b.step("bench-file-index", "Build file_index search benchmark");
    bench_step.dependOn(&install_bench.step);

    const run_bench = b.addRunArtifact(file_index_bench);
    run_bench.step.dependOn(&install_bench.step);
    run_bench.addPassthruArgs();
    const run_bench_step = b.step("run-bench-file-index", "Build and run file_index search benchmark");
    run_bench_step.dependOn(&run_bench.step);

    const stream_bench = b.addExecutable(.{
        .name = "provider-stream-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/provider_stream.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    stream_bench.root_module.addImport("benchmark_exports", benchmark_exports_mod);
    const install_stream_bench = b.addInstallArtifact(stream_bench, .{});
    const stream_bench_step = b.step("bench-provider-stream", "Build the local provider stream processing benchmark");
    stream_bench_step.dependOn(&install_stream_bench.step);
    const run_stream_bench = b.addRunArtifact(stream_bench);
    const run_stream_bench_step = b.step("run-bench-provider-stream", "Measure local SSE framing and Responses reduction without network requests");
    run_stream_bench_step.dependOn(&run_stream_bench.step);

    // --- UI activity progress benchmark ---
    const ui_activity_bench = b.addExecutable(.{
        .name = "ui-activity-progress-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/activity_progress.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    ui_activity_bench.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const install_ui_activity_bench = b.addInstallArtifact(ui_activity_bench, .{});
    const ui_activity_bench_step = b.step(
        "bench-ui-activity",
        "Build the UI activity progress benchmark",
    );
    ui_activity_bench_step.dependOn(&install_ui_activity_bench.step);

    const run_ui_activity_bench = b.addRunArtifact(ui_activity_bench);
    run_ui_activity_bench.step.dependOn(&install_ui_activity_bench.step);
    const run_ui_activity_bench_step = b.step(
        "run-bench-ui-activity",
        "Build and run the UI activity progress benchmark",
    );
    run_ui_activity_bench_step.dependOn(&run_ui_activity_bench.step);

    const ui_activity_bench_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/activity_progress.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    ui_activity_bench_tests.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const run_ui_activity_bench_tests = b.addRunArtifact(ui_activity_bench_tests);
    test_step.dependOn(&run_ui_activity_bench_tests.step);
    const test_ui_activity_bench_step = b.step(
        "test-ui-activity-benchmark",
        "Run UI activity benchmark policy tests",
    );
    test_ui_activity_bench_step.dependOn(&run_ui_activity_bench_tests.step);

    // --- file-diff approval review benchmark ---
    const approval_review_bench = b.addExecutable(.{
        .name = "approval-review-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/approval_review.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    approval_review_bench.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const install_approval_review_bench = b.addInstallArtifact(
        approval_review_bench,
        .{},
    );
    const approval_review_bench_step = b.step(
        "bench-approval-review",
        "Build the file-diff approval review benchmark",
    );
    approval_review_bench_step.dependOn(&install_approval_review_bench.step);

    const run_approval_review_bench = b.addRunArtifact(approval_review_bench);
    run_approval_review_bench.step.dependOn(&install_approval_review_bench.step);
    run_approval_review_bench.addPassthruArgs();
    const run_approval_review_bench_step = b.step(
        "run-bench-approval-review",
        "Build and run the file-diff approval review benchmark",
    );
    run_approval_review_bench_step.dependOn(&run_approval_review_bench.step);

    const approval_review_bench_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/approval_review.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    approval_review_bench_tests.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const run_approval_review_bench_tests = b.addRunArtifact(
        approval_review_bench_tests,
    );
    const test_approval_review_bench_step = b.step(
        "test-approval-review-benchmark",
        "Run file-diff approval review benchmark qualification tests",
    );
    test_approval_review_bench_step.dependOn(
        &run_approval_review_bench_tests.step,
    );

    const pgso_ir_step = b.step(
        "pgso-ir",
        "Emit selected ReleaseSafe LLVM bitcode for PGO/PGSO qualification",
    );
    if (pgso_artifact) |artifact| {
        const selected: *std.Build.Step.Compile = switch (artifact) {
            .handwork => exe,
            .file_index => file_index_bench,
            .ui_activity => ui_activity_bench,
            .approval_review => approval_review_bench,
        };
        const output_name = switch (artifact) {
            .handwork => "pgso/handwork.bc",
            .file_index => "pgso/file-index.bc",
            .ui_activity => "pgso/ui-activity.bc",
            .approval_review => "pgso/approval-review.bc",
        };
        const install_ir = b.addInstallFile(
            selected.getEmittedLlvmBc(),
            output_name,
        );
        pgso_ir_step.dependOn(&install_ir.step);
    } else {
        const missing_artifact = b.addFail(
            "pgso-ir requires -Dpgso-artifact",
        );
        pgso_ir_step.dependOn(&missing_artifact.step);
    }
}

/// Windows system libraries and translated Win32 headers for host adapters.
/// Zig 0.17 removed `@cImport`, so each adapter's header set in `src/c/` is
/// translated here and imported by name; non-Windows targets get nothing.
const WindowsHost = struct {
    const headers = [_][]const u8{
        "windows_clipboard",
        "windows_console",
        "windows_private_storage",
        "windows_processes",
        "windows_shell",
        "windows_sockets",
    };
    const system_libraries = [_][]const u8{ "advapi32", "ws2_32", "shell32", "ole32", "user32", "gdi32" };

    c_modules: ?[headers.len]*std.Build.Module,

    fn init(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.lang.Optimize) WindowsHost {
        if (target.result.os.tag != .windows) return .{ .c_modules = null };
        var modules: [headers.len]*std.Build.Module = undefined;
        for (headers, &modules) |name, *module| {
            const translate = b.addTranslateC(.{
                .root_source_file = b.path(b.fmt("src/c/{s}.h", .{name})),
                .target = target,
                .optimize = optimize,
            });
            module.* = translate.createModule();
        }
        return .{ .c_modules = modules };
    }

    /// Adds the translated headers only.
    fn addImports(self: WindowsHost, module: *std.Build.Module) void {
        const modules = self.c_modules orelse return;
        for (headers, modules) |name, c_module| {
            module.addImport(module.owner.fmt("{s}_c", .{name}), c_module);
        }
    }

    /// Adds the translated headers and links the Win32 system libraries.
    fn addTo(self: WindowsHost, module: *std.Build.Module) void {
        if (self.c_modules == null) return;
        self.addImports(module);
        for (system_libraries) |name| module.linkSystemLibrary(name, .{});
    }
};

fn addWasmArtifact(
    b: *std.Build,
    surface: WasmSurface,
    git_commit: []const u8,
    app_version: []const u8,
    update_channel: UpdateChannel,
) void {
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
    });
    const name = switch (surface) {
        .core => "handwork-core",
        .term => "handwork-term",
        .none => unreachable,
    };
    const description = switch (surface) {
        .core => "Build the headless handwork WebAssembly artifact",
        .term => "Build the terminal handwork WebAssembly artifact",
        .none => unreachable,
    };

    const wasm_options = b.addOptions();
    wasm_options.addOption([]const u8, "git_commit", git_commit);
    wasm_options.addOption([]const u8, "app_version", app_version);
    wasm_options.addOption([]const u8, "update_channel", @tagName(update_channel));
    wasm_options.addOption(WasmSurface, "wasm_surface", surface);

    const wasm_root = switch (surface) {
        .core => "src/wasm_core_main.zig",
        .term => "src/wasm_term_main.zig",
        .none => unreachable,
    };
    const wasm_exe = b.addExecutable(.{
        .name = name,
        .root_module = b.createModule(.{
            .root_source_file = b.path(wasm_root),
            .target = wasm_target,
            .optimize = .small,
            .single_threaded = true,
            .link_libc = true,
            .stack_check = false,
            .stack_protector = false,
            .omit_frame_pointer = true,
            .unwind_tables = .none,
            .error_tracing = false,
            .strip = true,
        }),
    });
    if (surface == .core) wasm_exe.stack_size = 1024 * 1024;
    wasm_exe.root_module.addImport("build_options", wasm_options.createModule());

    const install_wasm = b.addInstallArtifact(wasm_exe, .{});
    const wasm_step = b.step(name ++ "-wasm", description);
    wasm_step.dependOn(&install_wasm.step);
    b.getInstallStep().dependOn(&install_wasm.step);
}

fn addNapiArtifact(
    b: *std.Build,
    surface: NapiSurface,
    target: std.Build.ResolvedTarget,
    git_commit: []const u8,
    app_version: []const u8,
    update_channel: UpdateChannel,
) void {
    const napi_options = b.addOptions();
    napi_options.addOption([]const u8, "git_commit", git_commit);
    napi_options.addOption([]const u8, "app_version", app_version);
    napi_options.addOption([]const u8, "update_channel", @tagName(update_channel));
    napi_options.addOption(NapiSurface, "napi_surface", surface);

    const root = switch (surface) {
        .core => "src/napi_core_main.zig",
        .none => unreachable,
    };
    const lib = b.addLibrary(.{
        .name = "libhandwork",
        .linkage = .dynamic,
        .root_module = b.createModule(.{
            .root_source_file = b.path(root),
            .target = target,
            .optimize = .safe,
            .link_libc = true,
            .strip = true,
        }),
    });
    lib.root_module.addImport("build_options", napi_options.createModule());
    const node_include = b.option(
        []const u8,
        "node-include-dir",
        "Directory containing node_api.h for the N-API addon",
    ) orelse discoverNodeIncludeDir(b);
    const node_api = b.addTranslateC(.{
        .root_source_file = b.path("src/c/node_api.h"),
        .target = target,
        .optimize = .safe,
    });
    node_api.addSystemIncludePath(.{ .cwd_relative = node_include });
    lib.root_module.addImport("node_api_c", node_api.createModule());
    lib.linker_allow_shlib_undefined = true;

    const install = b.addInstallArtifact(lib, .{ .dest_sub_path = "libhandwork.node" });
    const step = b.step("libhandwork-napi", "Build the libhandwork Node-API core addon");
    step.dependOn(&install.step);
    b.getInstallStep().dependOn(&install.step);
}

fn discoverNodeIncludeDir(b: *std.Build) []const u8 {
    var code: u8 = 0;
    const out = b.runAllowFail(
        &.{ "node", "-p", "require('node:path').join(require('node:path').dirname(process.execPath), '..', 'include', 'node')" },
        &code,
        .ignore,
    ) catch std.process.fatal("Node.js is required to locate node_api.h; pass -Dnode-include-dir=<path>", .{});
    if (code != 0) std.process.fatal("could not locate node_api.h; pass -Dnode-include-dir=<path>", .{});
    const trimmed = std.mem.trim(u8, out, " \t\r\n");
    return b.allocator.dupe(u8, trimmed) catch std.process.fatal("could not allocate Node include path", .{});
}

fn readGitCommit(b: *std.Build) []const u8 {
    var code: u8 = 0;
    const out = b.runAllowFail(
        &.{ "git", "rev-parse", "--short=12", "HEAD" },
        &code,
        .ignore,
    ) catch return "unknown";
    if (code != 0) return "unknown";
    const trimmed = std.mem.trim(u8, out, " \t\r\n");
    return b.allocator.dupe(u8, trimmed) catch "unknown";
}

fn readAppVersion(b: *std.Build) []const u8 {
    const bytes = std.Io.Dir.cwd().readFileAlloc(b.graph.io, "package.json", b.allocator, .limited(1024 * 1024)) catch
        @panic("could not read package.json to resolve app version");
    defer b.allocator.free(bytes);

    const package = std.json.parseFromSlice(struct { version: []const u8 }, b.allocator, bytes, .{ .ignore_unknown_fields = true }) catch
        @panic("could not parse version in package.json");
    defer package.deinit();
    return b.allocator.dupe(u8, package.value.version) catch
        @panic("could not allocate app version");
}
