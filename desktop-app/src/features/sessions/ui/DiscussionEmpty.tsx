import { MessagesSquare as MessageMultiple } from "honestui/icons";
export function DiscussionEmpty({ message }: { message: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <MessageMultiple aria-hidden="true" className="size-16 text-content/25" />
      <p className="text-[13px] leading-relaxed text-content/45">{message}</p>
    </div>
  );
}
