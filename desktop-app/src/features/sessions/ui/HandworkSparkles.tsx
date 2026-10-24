import { Sparkles } from "../../../shared/ui/icons";
import { useState, type CSSProperties } from "react";
import { useTurnCelebration } from "./turnCelebration";
// Longest sparkle delay plus duration, with a little slack for the fade.
const CELEBRATE_MS = 3200;
const SPARKLE_COUNT = 18;
type Sparkle = {
  star: boolean;
  x: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  spin: number;
};
function makeSparkles(): Sparkle[] {
  return Array.from({ length: SPARKLE_COUNT }, (_, i) => {
    const star = i % 3 !== 2;
    return {
      star,
      // Spread evenly across the bubble with some jitter so it never reads as a grid.
      x: Math.min(96, Math.max(4, ((i + Math.random()) / SPARKLE_COUNT) * 100)),
      size: star ? 7 + Math.random() * 6 : 2.5 + Math.random() * 2,
      delay: 150 + Math.random() * 950,
      duration: 1200 + Math.random() * 800,
      drift: (Math.random() - 0.5) * 28,
      spin: (Math.random() < 0.5 ? -1 : 1) * (90 + Math.random() * 120),
    };
  }).sort(() => Math.random() - 0.5);
}
/** A one-shot burst of rising sparkles inside a freshly sent /operator bubble. */
export function HandworkSparkles({
  blockId,
  startedAt,
}: {
  blockId: string;
  startedAt?: number;
}) {
  const active = useTurnCelebration(blockId, startedAt, CELEBRATE_MS);
  const [sparkles] = useState(makeSparkles);
  if (!active) return null;
  return (
    <span aria-hidden className="handwork-sparkles">
      {sparkles.map((sparkle, index) => (
        <span
          key={index}
          className="handwork-sparkle"
          style={
            {
              "--x": `${sparkle.x}%`,
              "--size": `${sparkle.size}px`,
              "--delay": `${sparkle.delay}ms`,
              "--duration": `${sparkle.duration}ms`,
              "--drift": `${sparkle.drift}px`,
              "--spin": `${sparkle.spin}deg`,
            } as CSSProperties
          }
        >
          {sparkle.star ? (
            <Sparkles className="handwork-sparkle-glyph" />
          ) : (
            <span className="handwork-sparkle-glyph handwork-sparkle-ember" />
          )}
        </span>
      ))}
    </span>
  );
}
