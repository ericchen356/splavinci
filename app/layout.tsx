import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'splavinci',
  description: 'Camera-path authoring for Gaussian splat rooms',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <nav className="app-nav">
            <Link href="/" className="brand">splavinci</Link>
            <Link href="/plan" className="tab">Plan</Link>
            <Link href="/review" className="tab">Review</Link>
          </nav>
          <div className="app-body">{children}</div>
        </div>
      </body>
    </html>
  );
}
