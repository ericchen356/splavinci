'use client';

/**
 * The screen switcher.
 *
 * A client component only so it can mark the current screen. The tab you are
 * already on used to look exactly like the one you are not, which on a
 * two-screen app is the whole of the navigation state — and `aria-current`
 * carries it to anything that is not looking at the colour.
 *
 * The tabs appear only once a capture is open. On the library screen there is
 * no capture to plan or review, and offering the pair there let you land on an
 * authoring screen with nothing loaded and no way to tell that was why it was
 * empty. Picking a room is the step before those two exist.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/plan', label: 'Plan' },
  { href: '/review', label: 'Review' },
] as const;

export function AppNav() {
  const pathname = usePathname();
  const inCapture = TABS.some((tab) => pathname === tab.href);

  return (
    <nav className="app-nav" aria-label="Screens">
      <Link href="/" className="app-nav__brand">
        splavinci
      </Link>
      {inCapture && (
        <>
          {/* The way back to the library. Which capture is open is decided
              there and nowhere else, so this is also the only way to change it. */}
          <Link href="/" className="app-nav__tab app-nav__up">
            ← Renders
          </Link>
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="app-nav__tab"
              aria-current={pathname === tab.href ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </>
      )}
    </nav>
  );
}
