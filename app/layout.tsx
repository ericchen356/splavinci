import type { Metadata, Viewport } from 'next';
import { AppNav } from '@/components/AppNav';
import './globals.css';
/* Partials of the global sheet. Split by area, not by component: see the
   header in each for why. Order after globals.css, so tokens are defined. */
import './styles/home.css';
import './styles/inspector.css';
import './styles/map.css';
import './styles/plan.css';
import './styles/review.css';

export const metadata: Metadata = {
  title: 'splavinci',
  description: 'Camera-path authoring for Gaussian splat rooms',
};

/* Matches --ground, so the browser chrome and the overscroll gutter are the
   same colour as the app rather than flashing against it on load. */
export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f3f3f6',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <AppNav />
          <div className="app-body">{children}</div>
        </div>
      </body>
    </html>
  );
}
