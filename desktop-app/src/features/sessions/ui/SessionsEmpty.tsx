/** Quiet empty state shared by standalone chats and project conversations. */
export function SessionsEmpty({ message }: { message: string }) {
  return (
    <div
      data-sessions-empty
      className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center"
    >
      <p className="text-[13px] leading-relaxed text-content/45">{message}</p>
    </div>
  );
}
