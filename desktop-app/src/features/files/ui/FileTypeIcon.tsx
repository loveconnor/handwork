import { memo } from "react";
import {
  TypeScript,
  JavaScript,
  ReactLib,
  Rust,
  Go,
  HTML5,
  CSS,
  Sass,
  Markdown,
  Java,
  C,
  CPlusPlus,
  Php,
  Bash,
  Zig,
  Vue,
  Svelte,
  Astro,
} from "honestui/logos";
import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileArchive,
  FileMusic,
  FileVideo,
  Folder,
  FolderOpen,
} from "../../../shared/ui/icons";
type Props = {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
  isRoot?: boolean;
  size?: number;
};
const LANGUAGE_LOGOS = {
  ts: TypeScript,
  tsx: ReactLib,
  js: JavaScript,
  jsx: ReactLib,
  mjs: JavaScript,
  cjs: JavaScript,
  rs: Rust,
  go: Go,
  html: HTML5,
  htm: HTML5,
  css: CSS,
  scss: Sass,
  sass: Sass,
  md: Markdown,
  mdx: Markdown,
  java: Java,
  c: C,
  h: C,
  cpp: CPlusPlus,
  hpp: CPlusPlus,
  cc: CPlusPlus,
  php: Php,
  sh: Bash,
  bash: Bash,
  zsh: Bash,
  zig: Zig,
  vue: Vue,
  svelte: Svelte,
  astro: Astro,
};
function fileGlyph(name: string) {
  const lower = name.toLowerCase();
  const extension = lower.split(".").pop() ?? "";
  const logo = LANGUAGE_LOGOS[extension as keyof typeof LANGUAGE_LOGOS];
  if (logo) return logo;
  if (["json", "jsonc", "json5"].includes(extension)) return FileJson;
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(
      extension,
    )
  )
    return FileImage;
  if (["zip", "gz", "tar", "7z", "rar"].includes(extension)) return FileArchive;
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(extension))
    return FileMusic;
  if (["mp4", "mov", "webm", "mkv"].includes(extension)) return FileVideo;
  if (["txt", "log", "pdf", "doc", "docx", "rtf"].includes(extension))
    return FileText;
  if (
    [
      "py",
      "rb",
      "swift",
      "kt",
      "cs",
      "sql",
      "toml",
      "yaml",
      "yml",
      "xml",
      "lock",
    ].includes(extension) ||
    lower === "dockerfile" ||
    lower === "makefile"
  )
    return FileCode;
  return File;
}
/** File and folder marks share the app's Honest UI icon and logo catalogs. */
export const FileTypeIcon = memo(function FileTypeIcon({
  name,
  isDir,
  isOpen = false,
  size = 16,
}: Props) {
  const Icon = isDir ? (isOpen ? FolderOpen : Folder) : fileGlyph(name);
  return (
    <span
      aria-hidden="true"
      data-file-icon
      className="inline-block shrink-0 align-middle"
      style={{ width: size, height: size }}
    >
      <Icon className="block size-full" />
    </span>
  );
});
