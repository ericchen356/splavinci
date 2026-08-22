import Link from 'next/link';
import { Icon } from '@/components/Icon';

const STEPS = [
  {
    href: '/plan',
    title: 'Plan',
    body: 'Fly the capture, drop waypoints in 3D or on the mini-map, tune each shot, and generate a wall-aware path.',
  },
  {
    href: '/review',
    title: 'Review',
    body: 'Play the flythrough, follow it on the mini-map, leave spatial comments, export the video.',
  },
];

export default function Home() {
  return (
    <main className="hub">
      <h1 className="hub__title">splavinci</h1>
      <p className="hub__lede">Author a camera flythrough through a captured room.</p>

      <div className="hub__list">
        {STEPS.map((step, i) => (
          <Link key={step.href} href={step.href} className="hub__card">
            <span className="hub__step" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <span className="hub__name">
                Step {i + 1} — {step.title}
              </span>
              <span className="hub__body">{step.body}</span>
            </span>
            <span className="hub__chev">
              <Icon name="chevron-right" />
            </span>
          </Link>
        ))}
      </div>
    </main>
  );
}
