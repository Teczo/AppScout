import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'AppScout',
  description: 'App trend research from YouTube channels',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="inner">
            <Link href="/" className="brand">
              AppScout
            </Link>
            <span className="tag">YouTube channel → apps → verified research → trends</span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
