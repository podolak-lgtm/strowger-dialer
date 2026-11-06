"use client";

/** The switch-off time in the viewer's own clock. */
export function TestPhonesUntil({ iso }: { iso: string }) {
  return <span suppressHydrationWarning>{new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>;
}
