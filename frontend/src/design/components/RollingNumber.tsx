import { useState } from "react";

interface RollingNumberProps {
  value: number;
  format?: (value: number) => string;
  className?: string;
}

/**
 * Number roll (P1-DOC-18): when `value` changes, the old number slides out and the new one
 * slides in — up when it grows, down when it falls. Only transform/opacity; with reduced
 * motion the change is instant. Screen readers get the current value only.
 */
export function RollingNumber({ value, format = String, className }: RollingNumberProps) {
  const [state, setState] = useState({ current: value, previous: null as number | null, key: 0 });
  if (value !== state.current) {
    setState({ current: value, previous: state.current, key: state.key + 1 });
  }
  const direction = state.previous !== null && state.current < state.previous ? "down" : "up";
  return (
    <span className={["s-roll", className].filter(Boolean).join(" ")}>
      <span key={`in${state.key}`} className={state.previous !== null ? `s-roll__in--${direction}` : undefined}>{format(state.current)}</span>
      {state.previous !== null && (
        <span
          key={`out${state.key}`}
          className={`s-roll__out--${direction}`}
          aria-hidden="true"
          onAnimationEnd={() => setState((current) => (current.key === state.key ? { ...current, previous: null } : current))}
        >
          {format(state.previous)}
        </span>
      )}
    </span>
  );
}
