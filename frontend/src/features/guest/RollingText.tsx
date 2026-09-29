import { useState } from "react";

/**
 * Number roll (P1-DOC-18): characters that changed since the last value slide in from below,
 * the rest stay put. The text content is always the plain value (screen readers and tests
 * read «240 ₽»); reduced motion turns the slide off in CSS.
 */
export function RollingText({ value, className, testId }: { value: string; className?: string; testId?: string }) {
  // «Derive from props» pattern: safe under StrictMode double rendering.
  const [state, setState] = useState({ value, before: value, generation: 0 });
  if (state.value !== value) setState({ value, before: state.value, generation: state.generation + 1 });
  const before = state.value !== value ? state.value : state.before;
  const generation = state.value !== value ? state.generation + 1 : state.generation;
  const chars = Array.from(value);
  const old = Array.from(before);
  // Align from the right: «190 ₽» → «1 240 ₽» rolls the digits, not the currency sign.
  const offset = old.length - chars.length;
  return (
    <strong className={["g-roll", className].filter(Boolean).join(" ")} data-testid={testId} aria-live="polite">
      {chars.map((char, index) => {
        const changed = generation > 0 && old[index + offset] !== char && /\d/.test(char);
        return (
          <span key={changed ? `${index}-${generation}` : `${index}`} className={changed ? "g-roll__char g-roll__char--in" : "g-roll__char"}>
            {char}
          </span>
        );
      })}
    </strong>
  );
}
