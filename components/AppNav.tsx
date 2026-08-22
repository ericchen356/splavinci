'use client';

/**
 * The two-screen switcher.
 *
 * A client component only so it can mark the current screen. The tab you are
 * already on used to look exactly like the one you are not, which on a
 * two-screen app is the whole of the navigation state — and `aria-current`
 * carries it to anything that is not looking at the colour.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/plan', label: 'Plan' },
  { href: '/review', label: 'Review' },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="app-nav" aria-label="Screens">
      <Link href="/" className="app-nav__brand">
        splavinci
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
    </nav>
  );
}
