"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Untrusted engine text: no raw HTML, remote image fetches, or navigation. */
export default function AssistantMarkdown({ text }: { text: string }) {
  return <div className="text-[13.5px] leading-[1.7] break-words [&_p]:mb-3 [&_p:last-child]:mb-0 [&_h1]:mb-3 [&_h1]:text-xl [&_h2]:my-3 [&_h2]:text-lg [&_h3]:my-2 [&_h3]:font-semibold [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-[10px] [&_pre]:bg-inset [&_pre]:p-3 [&_code]:font-mono [&_code]:text-[12px] [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:p-2">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, href }) => <span className="text-accent-ink" title={href}>{children}{href && <span className="ml-1 text-[11px] text-ink-3">({href})</span>}</span>,
      img: ({ alt }) => <span className="text-ink-3">[Image: {alt || "remote image not loaded"}]</span>,
    }}>{text}</Markdown>
  </div>;
}
