"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MessageScroller } from 'honestui/ai/message-scroller';

export function HandworkConversation({ landing, sessionKey, busy, footer, overlay, children }: {
  landing: boolean; sessionKey: string; busy: boolean; footer: ReactNode; children: ReactNode;
  /** Floats over the transcript, such as the find bar. */
  overlay?: ReactNode;
}) {
  const footerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const element = footerRef.current;
    if (!element) return;
    const measure = () => setComposerHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [landing]);

  return <div data-slot="chat-thread" className={`handwork-thread ${landing ? 'is-landing' : ''}`} style={{ '--handwork-composer-height': `${composerHeight}px` } as CSSProperties}>
    {landing ? <div role="log" aria-label="Handwork conversation">{children}</div> : <MessageScroller
      key={sessionKey}
      label="Handwork conversation"
      navigation="rail"
      navigationLabel="Chat message navigation"
      busy={busy}
      className="handwork-message-scroller"
      viewportClassName="handwork-message-viewport"
      contentClassName="handwork-message-content"
    >{children}</MessageScroller>}
    {overlay}
    <div ref={footerRef} data-slot="chat-thread-footer">{footer}</div>
  </div>;
}
