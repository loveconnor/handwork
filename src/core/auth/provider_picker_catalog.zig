//! Subscription provider choices for the `/provider` picker.
const std = @import("std");
const host_target = @import("../hosts/target.zig");
const model_provider = @import("../config/model_provider.zig");
const provider_catalog = @import("provider_catalog.zig");
pub const max_provider_options = provider_catalog.entries.len;
pub const max_column_options = max_provider_options;

fn providerVisible(id: model_provider.ProviderId) bool {
    if (comptime host_target.is_wasm) return id == .codex;
    return @import("../config/provider_policy.zig").nativeEnabled(id);
}

/// Writes the visible provider slugs into `out` and returns how many landed.
pub fn providerOptions(out: *[max_provider_options][]const u8) usize {
    var count: usize = 0;
    for (&provider_catalog.entries) |*entry| {
        if (!providerVisible(entry.id)) continue;
        out[count] = entry.slug;
        count += 1;
    }
    return count;
}

test "provider options expose the catalog slugs the composer accepts" {
    var buf: [max_provider_options][]const u8 = undefined;
    const count = providerOptions(&buf);

    try std.testing.expect(count == (if (host_target.is_wasm) @as(usize, 1) else provider_catalog.entries.len - 2));
    try std.testing.expectEqualStrings("codex", buf[0]);
    for (buf[0..count]) |slug| {
        try std.testing.expect(provider_catalog.parse(slug) != null);
        try std.testing.expect(std.mem.indexOfScalar(u8, slug, ' ') == null);
    }
}
