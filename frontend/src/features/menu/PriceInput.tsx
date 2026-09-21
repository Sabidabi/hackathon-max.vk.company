import { useEffect, useState } from "react";

export function parsePrice(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [rubles, kopecks = ""] = normalized.split(".");
  const value = Number(rubles) * 100 + Number(kopecks.padEnd(2, "0"));
  return value <= 100_000_000 ? value : null;
}

export function PriceInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value / 100));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused && Number.isFinite(value)) setText(String(value / 100)); }, [value, focused]);
  const invalid = parsePrice(text) === null;
  return <>
    <input inputMode="decimal" value={text} aria-invalid={invalid} maxLength={11}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onChange={(event) => { setText(event.target.value); onChange(parsePrice(event.target.value) ?? Number.NaN); }} />
    {invalid && <small className="field-error">От 0 до 1 000 000 ₽, не больше двух знаков после запятой</small>}
  </>;
}
