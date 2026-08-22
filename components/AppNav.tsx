'use client';

/**
 * The screen switcher, and the one guard on leaving a plan.
 *
 * A client component so it can mark the current screen. The tab you are
 * already on used to look exactly like the one you are not, which on a
 * two-screen app is the whole of the navigation state — and `aria-current`
 * carries it to anything that is not looking at the colour.
 *
 * The tabs appear only once a capture is open. On the library screen there is
 * no capture to plan or review, and offering the pair there let you land on an
 * authoring screen with nothing loaded and no way to tell that was why it was
 * empty. Picking a room is the step before those two exist.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { usePlanStore } from '@/lib/plan/planStore';

const TABS = [
  { href: '/plan', label: 'Plan' },
  { href: '/review', label: 'Review' },
] as const;

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const inCapture = TABS.some((tab) => pathname === tab.href);

  const waypointCount = usePlanStore((s) => s.waypoints.length);
  const resetPlan = usePlanStore((s) => s.resetPlan);
  const [confirming, setConfirming] = useState(false);

  /* Only the way OUT of the capture is guarded. Plan and Review are two views
     of one plan in one room, so moving between them keeps everything; going
     back to the library is what changes which room is open, and a plan does
     not survive that. */
  const atRisk = inCapture && waypointCount > 0;

  const leave = useCallback(() => {
    setConfirming(false);
    resetPlan();
    router.push('/');
  }, [resetPlan, router]);

  return (
    <>
      <nav className="app-nav" aria-label="Screens">
        <Link href="/" className="app-nav__brand">
          splavinci
        </Link>
        {inCapture && (
          <>
            {/* The way back to the library. Which capture is open is decided
                there and nowhere else, so this is also the only way to change
                it — and therefore the only place a plan can be lost.

                It stops being a link once there is something to lose. Guarding
                an <a> means cancelling its default, which puts a plan's
                survival on top of the router's internals; a button has no
                navigation to cancel. It is also the honest element: with
                unsaved work this does not go anywhere, it asks a question. */}
            {atRisk ? (
              <button
                type="button"
                className="app-nav__tab app-nav__up"
                onClick={() => setConfirming(true)}
              >
                ← Renders
              </button>
            ) : (
              <Link href="/" className="app-nav__tab app-nav__up">
                ← Renders
              </Link>
            )}
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

      {confirming && (
        <LeaveDialog
          count={waypointCount}
          onStay={() => setConfirming(false)}
          onLeave={leave}
        />
      )}
    </>
  );
}

/**
 * Confirmation before a plan is discarded.
 *
 * Deliberately not window.confirm: that blocks the whole page, cannot say how
 * much is about to be lost in the user's own terms, and gives the destructive
 * choice the same weight as the safe one. Here the safe choice is the default
 * — it takes focus, it answers Escape, and the destructive button has to be
 * chosen on purpose.
 */
function LeaveDialog({
  count,
  onStay,
  onLeave,
}: {
  count: number;
  onStay: () => void;
  onLeave: () => void;
}) {
  const stayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    stayRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onStay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStay]);

  return (
    <div className="modal" role="presentation" onClick={onStay}>
      <div
        className="modal__panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        aria-describedby="leave-body"
        /* The backdrop dismisses; a click that started inside the panel must
           not, or dragging to select the text closes the dialog. */
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id="leave-title">
          Discard this plan?
        </h2>
        <p className="modal__body" id="leave-body">
          {count === 1 ? 'One waypoint' : `${count} waypoints`} and any comments
          belong to the capture that is open. Going back to the library clears
          them, because they are positions in this room and mean nothing in
          another one.
        </p>
        <div className="modal__actions">
          <button type="button" ref={stayRef} onClick={onStay}>
            Keep editing
          </button>
          <button type="button" className="btn--danger" onClick={onLeave}>
            Discard and leave
          </button>
        </div>
      </div>
    </div>
  );
}
