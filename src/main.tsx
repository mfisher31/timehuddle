import './styles.css';

// ─── Eager theme + brand bootstrap ───────────────────────────────────────────
// Apply theme immediately (before React mounts) so login, landing, and all
// pre-auth pages receive the correct data-theme / .dark class without flicker.
(function applyBootstrapTheme() {
  const stored = localStorage.getItem('app:theme');
  const theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
})();

// Apply brand CSS eagerly so login/signup pages get the right brand colors.
// useBrand() only runs inside AppLayout, so pre-auth pages need this bootstrap.
(function applyBootstrapBrand() {
  const BUILD_TIME_BRAND = 'bluehive';
  const DEFAULT_BRAND = 'webchart';
  const stored = localStorage.getItem('app:brand');
  const brand = stored || DEFAULT_BRAND;
  if (brand === BUILD_TIME_BRAND) return; // baked into CSS, no injection needed
  // Dynamically import brand and inject CSS — async but fast enough for pre-auth pages
  import('@mieweb/ui/brands').then(({ generateBrandCSS, brands }) => {
    const loader = brands[brand as keyof typeof brands] ?? brands[DEFAULT_BRAND];
    loader().then((config) => {
      const el = document.createElement('style');
      el.id = 'mieweb-brand-override';
      el.textContent = generateBrandCSS(config);
      document.head.appendChild(el);
    });
  });
})();

// ─── Startup timing (visible in Xcode device console) ─────────────────────────
const t0 = performance.now();
const _log = (msg: string) =>
  console.log(`[TimeHuddle] +${(performance.now() - t0).toFixed(0)}ms ${msg}`);
_log('main.tsx evaluated');

import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { InboxPage } from './features/inbox/InboxPage';
import { OAuthConsentPage } from './features/oauth/ConsentPage';
import { SessionProvider, useSession } from './lib/useSession';
import { AppLayout } from './ui/AppLayout';
import { LandingPage } from './ui/LandingPage';
import { LoginForm } from './ui/LoginForm';
import { UsernameClaimModal } from './ui/UsernameClaimModal';

// ─── Username path detection ──────────────────────────────────────────────────

/** Regex matching /:username — 3-30 chars, start/end alphanumeric. */
const USERNAME_PATH_RE = /^\/([a-z0-9][a-z0-9_-]{1,28}[a-z0-9])$/;

/** Reserved path segments that must never be treated as usernames. */
const RESERVED_PATHS = new Set([
  'app',
  'api',
  'auth',
  'login',
  'logout',
  'signup',
  'register',
  'admin',
  'dashboard',
  'settings',
  'profile',
  'account',
  'user',
  'static',
  'assets',
  'public',
  'health',
  'favicon',
  'robots',
  'sw',
  'manifest',
  'sitemap',
  'feed',
  'rss',
  'help',
  'support',
  'about',
  'oauth',
  'contact',
  'privacy',
  'terms',
  'legal',
]);

// ─── Deep link handling (Capacitor native only) ───────────────────────────────
//
// Password reset emails contain a timehuddle://reset?token=XXX link.
// When the user taps it, the OS opens the app and fires appUrlOpen.
// We store the token in this module-level variable so the App component
// can read it on mount (and on every resume).

let _deepLinkToken: string | null = null;

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => {
    try {
      // Expected format: timehuddle://reset?token=<value>
      const parsed = new URL(url);
      const token = parsed.searchParams.get('token');
      if (token) {
        _deepLinkToken = token;
        // Re-render the root so the App component picks up the token.
        renderRoot();
      }
    } catch {
      // Malformed URL — ignore
    }
  });
}

// ─── App (client-side rendered, /app and all non-root routes) ─────────────────
_log('App component defined — modules loaded');

const App: React.FC = () => {
  const { user, loading, needsUsernameClaim } = useSession();

  // Reset token: check URL params (web) or deep link (native).
  const resetToken =
    _deepLinkToken ??
    (typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('token')
      : null);

  if (resetToken) {
    return <LoginForm initialMode="reset-confirm" />;
  }

  // OAuth 2.0 consent page — shown when a third-party client (e.g. Qt desktop)
  // requests authorization. Requires the user to be logged in first.
  if (window.location.pathname === '/oauth/consent') {
    if (!user) return <LoginForm />;
    return <OAuthConsentPage />;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-100 dark:bg-neutral-900">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">Loading…</p>
      </div>
    );
  }

  if (!user) return <LoginForm />;
  if (needsUsernameClaim)
    return (
      <>
        <AppLayout />
        <UsernameClaimModal />
      </>
    );
  return <AppLayout />;
};

// ─── Entry point ──────────────────────────────────────────────────────────────

let _root: ReturnType<typeof createRoot> | null = null;

function renderRoot() {
  _log('renderRoot called');
  const el = document.getElementById('root');
  if (!el) return;

  if (!_root) {
    if (window.location.pathname === '/') {
      // On native (Capacitor iOS/Android) the WebView always starts at '/'.
      // Skip the marketing landing page and go straight to the app.
      if (Capacitor.isNativePlatform()) {
        _log('native platform detected — mounting SessionProvider + App');
        _root = createRoot(el);
        _root.render(
          <SessionProvider>
            <App />
          </SessionProvider>,
        );
        return;
      }
      _root = createRoot(el);
      _root.render(<LandingPage />);
      return;
    } else if (window.location.pathname === '/inbox') {
      _root = createRoot(el);
      _root.render(<InboxPage />);
      return;
    }

    // Public profile route — /:username
    // AppLayout handles this internally, so fall through to <App /> which keeps the sidebar.
    // The USERNAME_PATH_RE + RESERVED_PATHS check is still used by AppLayout for in-app routing.
    const usernameMatch = window.location.pathname.match(USERNAME_PATH_RE);
    if (usernameMatch && !RESERVED_PATHS.has(usernameMatch[1])) {
      _log(`profile route — @${usernameMatch[1]} — mounting full app shell`);
    }

    _root = createRoot(el);
  }

  _root.render(
    <SessionProvider>
      <App />
    </SessionProvider>,
  );
}

renderRoot();
