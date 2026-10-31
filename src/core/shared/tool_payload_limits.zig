/// Maximum decoded content accepted by write_file.
pub const file_content_bytes: usize = 4 * 1024 * 1024;

/// JSON can encode one content byte as six bytes (\\u0000). Reserve bounded
/// space for the path and other argument fields without reducing the file limit.
pub const arguments_json_bytes: usize = file_content_bytes * 6 + 64 * 1024;
