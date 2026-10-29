"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MessageScroller } from 'honestui/ai/message-scroller';

export function HandworkConversation({ landing, sessionKey, busy, footer, overlay, children }: {
  landing: boolean; sessionKey: string; busy: boolean; footer: ReactNode; children: ReactNode;
  /** Floats over the transcript, such as the find bar. */
  overlay?: ReactNode;
}) {
  const footerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const following = useRef(true);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => { following.current = true; }, [sessionKey]);
  // History can arrive after the tab itself. Position each committed snapshot
  // before paint, including the footer measurement, without pulling a reader
  // back down after they deliberately leave the live edge.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && following.current) viewport.scrollTop = viewport.scrollHeight;
  }, [sessionKey, children, composerHeight, landing]);
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
      viewportRef={viewportRef}
      smooth={false}
      onFollowChange={value => { following.current = value; }}
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
