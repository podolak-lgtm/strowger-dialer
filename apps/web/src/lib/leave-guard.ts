// One page-wide "you have unsaved changes" guard for in-app navigation.
// A page with a draft (the campaign editor) sets the message while dirty;
// NavLink (components/nav-link.tsx) asks before a client navigation, through
// Link's onNavigate, which is the Next.js 16 way to cancel one. Reload and tab
// close are the page's own beforeunload.
let message: string | null = null;

export function setLeaveGuard(m: string | null): void {
  message = m;
}

/** True when it is fine to leave: nothing unsaved, or the person said so. */
export function confirmLeave(): boolean {
  return !message || window.confirm(message);
}
