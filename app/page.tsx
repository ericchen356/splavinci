import Link from 'next/link';

const STEPS = [
  { href: '/plan', title: 'Plan', body: 'Fly the capture, drop waypoints in 3D or on the mini-map, tune each shot, and generate a wall-aware path.' },
  { href: '/review', title: 'Review', body: 'Play the flythrough, follow it on the mini-map, leave spatial comments, export the video.' },
];

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 28 }}>splavinci</h1>
      <p style={{ color: 'var(--muted)', margin: '0 0 32px' }}>
        Author a camera flythrough through a captured room.
      </p>
      <div style={{ display: 'grid', gap: 12 }}>
        {STEPS.map((s, i) => (
          <Link
            key={s.href}
            href={s.href}
            style={{
              display: 'block',
              padding: 16,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              color: 'var(--text)',
              textDecoration: 'none',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Step {i + 1}</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
            <div style={{ color: 'var(--muted)' }}>{s.body}</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
