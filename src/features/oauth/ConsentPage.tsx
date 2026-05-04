/**
 * OAuthConsentPage — shown when a third-party client (e.g. the Qt desktop app)
 * requests access to a user's TimeHuddle account via OAuth 2.0 / OIDC.
 *
 * better-auth redirects here with ?consent_code=...&client_id=...&scope=...
 * The user can approve or deny; we POST to /api/auth/oauth2/consent.
 */

import React, { useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, Spinner } from '@mieweb/ui';
import { TIMECORE_BASE_URL } from '../../lib/api';

// ─── Scope descriptions ───────────────────────────────────────────────────────

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Verify your identity',
  profile: 'Read your name and profile picture',
  email: 'Read your email address',
  offline_access: 'Stay signed in without re-authorizing',
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const OAuthConsentPage: React.FC = () => {
  const params = new URLSearchParams(window.location.search);
  const consentCode = params.get('consent_code') ?? '';
  const clientId = params.get('client_id') ?? '';
  const scopeParam = params.get('scope') ?? 'openid profile email';
  const scopes = scopeParam.split(/\s+/).filter(Boolean);

  const [clientName, setClientName] = useState<string>(clientId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the OIDC discovery doc to get client info if possible.
  // In practice, better-auth exposes the client name via its own API; for now
  // we fall back to a human-friendly label derived from the client_id.
  useEffect(() => {
    const friendly: Record<string, string> = {
      'qt-timehuddle-desktop': 'TimeHuddle Desktop',
    };
    setClientName(friendly[clientId] ?? clientId);
  }, [clientId]);

  async function respond(accept: boolean) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${TIMECORE_BASE_URL}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }

      // better-auth will redirect (via the response Location header or a JSON redirect URL)
      const data = await res.json().catch(() => null);
      if (data?.redirectTo) {
        window.location.href = data.redirectTo;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLoading(false);
    }
  }

  if (!consentCode) {
    return (
      <div className="consent-page-shell" role="main">
        <p className="consent-error-text">Invalid consent request — missing consent_code.</p>
      </div>
    );
  }

  return (
    <div
      className="consent-page-shell flex min-h-screen items-center justify-center bg-neutral-100 p-4 dark:bg-neutral-900"
      role="main"
    >
      <Card className="consent-card w-full max-w-md">
        <CardHeader>
          <div className="consent-header flex flex-col gap-1">
            <h1 className="consent-title text-xl font-semibold">Authorize access</h1>
            <p className="consent-subtitle text-sm text-neutral-500 dark:text-neutral-400">
              <strong>{clientName}</strong> is requesting permission to access your TimeHuddle
              account.
            </p>
          </div>
        </CardHeader>

        <CardContent>
          <div className="consent-body flex flex-col gap-6">
            {/* Scope list */}
            <section aria-labelledby="consent-scopes-heading">
              <h2
                id="consent-scopes-heading"
                className="consent-scopes-heading mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300"
              >
                This app will be able to:
              </h2>
              <ul className="consent-scopes-list flex flex-col gap-1" role="list">
                {scopes.map((scope) => (
                  <li
                    key={scope}
                    className="consent-scope-item flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400"
                  >
                    <span aria-hidden="true" className="text-green-500">
                      ✓
                    </span>
                    {scopeLabel(scope)}
                  </li>
                ))}
              </ul>
            </section>

            {/* Error message */}
            {error && (
              <p
                role="alert"
                className="consent-error rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
              >
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="consent-actions flex gap-3" role="group" aria-label="Consent decision">
              {loading ? (
                <Spinner aria-label="Processing…" />
              ) : (
                <>
                  <Button
                    onClick={() => respond(true)}
                    aria-label={`Allow ${clientName} to access your account`}
                    className="flex-1"
                  >
                    Allow
                  </Button>
                  <Button
                    onClick={() => respond(false)}
                    aria-label={`Deny ${clientName} access to your account`}
                    className="flex-1"
                    variant="secondary"
                  >
                    Deny
                  </Button>
                </>
              )}
            </div>

            <p className="consent-disclaimer text-xs text-neutral-400 dark:text-neutral-500">
              You can revoke this access at any time from your account settings.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
