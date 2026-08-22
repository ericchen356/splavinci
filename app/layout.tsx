import type { Metadata, Viewport } from 'next';
import { AppNav } from '@/components/AppNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'splavinci',
  description: 'Camera-path authoring for Gaussian splat rooms',
};

/* Matches --ground, so the browser chrome and the overscroll gutter are the
   same colour as the app rather than flashing white on load. */
export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#101114',
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
