/**
 * SettingsPage — User & application settings.
 * Sections:
 *   • Profile       — display name, bio, website, linked sign-in accounts, password reset
 *   • Appearance    — theme toggle
 *   • Account       — sign out
 *   • Developer     — OAuth 2.0 application management
 *   • About         — stack versions
 */
import {
  faBell,
  faCode,
  faGear,
  faInfo,
  faPalette,
  faPlus,
  faRotateLeft,
  faRightFromBracket,
  faTrash,
  faUser,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Text,
  Textarea,
} from '@mieweb/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { Capacitor } from '@capacitor/core';
import {
  checkPushNotificationStatus,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/nativePush';
import { authApi, userApi, oauthApi, type OAuthApplication } from '../lib/api';
import { GitHubConnectionRow } from './GitHubConnectionRow';
import { PROFILE_BIO_MAX, PROFILE_DISPLAY_NAME_MAX, PROFILE_WEBSITE_MAX } from '../lib/constants';
import { useBrand, BRANDS } from '../lib/useBrand';
import { useSession } from '../lib/useSession';
import { AppPage } from './AppPage';

// ─── Primitives ───────────────────────────────────────────────────────────────

const Section: React.FC<{
  icon: typeof faGear;
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ icon, title, description, children }) => (
  <Card padding="none">
    <CardHeader className="flex items-start gap-3 px-5 py-4">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
        <FontAwesomeIcon icon={icon} className="text-sm" />
      </div>
      <div>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && (
          <Text variant="muted" size="xs" className="mt-0.5">
            {description}
          </Text>
        )}
      </div>
    </CardHeader>
    <CardContent className="divide-y divide-neutral-100 p-0 dark:divide-neutral-800">
      {children}
    </CardContent>
  </Card>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex items-center justify-between gap-4 px-5 py-3.5">
    <div className="min-w-0">
      <Text size="sm" weight="medium">
        {label}
      </Text>
      {hint && (
        <Text variant="muted" size="xs" className="mt-0.5">
          {hint}
        </Text>
      )}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

// ─── Brand selector ────────────────────────────────────────────────────────────────────

const brandOptions = BRANDS.map((b) => ({
  value: b.id,
  label: `${b.emoji} ${b.label}`,
}));

const BrandSelector: React.FC = () => {
  const { brand, setBrand } = useBrand();

  return (
    <Select
      label="Brand theme"
      hideLabel
      size="sm"
      value={brand}
      options={brandOptions}
      onValueChange={(v) => setBrand(v as typeof brand)}
      aria-label="Switch between brand themes"
    />
  );
};

// ─── Push notifications (Web Push — timeharbor-old parity) ────────────────────

const PushNotificationsSettings: React.FC = () => {
  const isNative = Capacitor.isNativePlatform();
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  // VAPID check is only relevant on the web; always pass on native.
  const [serverHasVapid, setServerHasVapid] = useState<boolean | null>(isNative ? true : null);

  const refreshStatus = useCallback(async () => {
    if (isNative) {
      // On native we don't have a synchronous way to check if we are subscribed
      // without a stored token, so treat "supported" as the indicator.
      return;
    }
    if (!isPushSupported()) {
      setEnabled(false);
      return;
    }
    const st = await checkPushNotificationStatus();
    setEnabled(st.permission === 'granted' && st.subscribed && st.serverEnabled);
  }, [isNative]);

  useEffect(() => {
    setSupported(isPushSupported());
    if (!isNative) {
      // VAPID key is configured if the env var is present
      const vapidKey =
        (typeof import.meta !== 'undefined' &&
          (import.meta as { env?: Record<string, string> }).env?.VITE_VAPID_PUBLIC_KEY) ||
        '';
      setServerHasVapid(vapidKey.length > 0);
    }
    void refreshStatus();
  }, [isNative, refreshStatus]);

  const handleEnable = async () => {
    setLoading(true);
    try {
      await subscribeToPush();
      if (!isNative) await refreshStatus();
      else setEnabled(true);

      window.alert(
        'Notifications enabled! You will receive alerts when team members clock in or out.',
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      let detail = 'Failed to enable notifications. ';
      if (msg.includes('permission') || msg.includes('denied')) {
        detail += 'Please allow notifications in your browser settings.';
      } else if (msg.includes('not-configured')) {
        detail += 'The server is missing VAPID keys in settings.';
      } else {
        detail += msg;
      }

      window.alert(detail);
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    if (!window.confirm('Are you sure you want to disable push notifications?')) return;
    setLoading(true);
    try {
      await unsubscribeFromPush();
      if (!isNative) await refreshStatus();
      else setEnabled(false);

      window.alert('Notifications disabled.');
    } catch {
      window.alert('Failed to disable notifications. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3 px-5 py-4">
      {serverHasVapid === false && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Web Push is not configured on this server. Add VAPID keys to{' '}
          <code className="text-xs">settings.json</code> (see{' '}
          <code className="text-xs">settings.push.example.json</code>).
        </div>
      )}
      {!supported ? (
        <Text variant="muted" size="sm">
          Push notifications are not supported on this platform.
        </Text>
      ) : enabled ? (
        <>
          <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
            Notifications are enabled. You will receive alerts when team members clock in or out.
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisable}
            disabled={loading}
            isLoading={loading}
          >
            Disable notifications
          </Button>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            Enable push notifications to get notified when your team members clock in or clock out.
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleEnable}
            disabled={loading || serverHasVapid === false}
            isLoading={loading}
            leftIcon={<FontAwesomeIcon icon={faBell} className="text-xs" />}
          >
            Enable notifications
          </Button>
        </>
      )}
    </div>
  );
};

// ─── Profile editor ───────────────────────────────────────────────────────────

const ProfileEditor: React.FC = () => {
  const { user } = useSession();
  const [name, setName] = useState(user?.name ?? '');
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Load current profile values
  useEffect(() => {
    if (!user?.id) return;
    userApi.getUser(user.id).then((p) => {
      setName(p.name ?? '');
      setBio(p.bio ?? '');
      setWebsite(p.website ?? '');
    });
  }, [user?.id]);

  const handleSave = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await userApi.updateProfile({ name, bio, website });
      setMessage({ ok: true, text: 'Profile saved.' });
    } catch (err: unknown) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setBusy(false);
    }
  };

  const websiteError =
    website && !/^https?:\/\/.+/.test(website) ? 'Must start with http:// or https://' : undefined;

  return (
    <div className="space-y-3 px-5 py-4">
      <div>
        <Text size="xs" weight="medium" className="mb-1 block">
          Display name
        </Text>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          size="sm"
          maxLength={PROFILE_DISPLAY_NAME_MAX}
          placeholder="Your display name"
          aria-label="Display name"
        />
        <Text variant="muted" size="xs" className="mt-1 text-right">
          {name.length}/{PROFILE_DISPLAY_NAME_MAX}
        </Text>
      </div>
      <div>
        <Text size="xs" weight="medium" className="mb-1 block">
          Email
        </Text>
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
          <Text size="sm" variant="muted">
            {user?.email}
          </Text>
        </div>
        <Text variant="muted" size="xs" className="mt-1">
          Email cannot be changed here.
        </Text>
      </div>
      {user?.username && (
        <div>
          <Text size="xs" weight="medium" className="mb-1 block">
            Username
          </Text>
          <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
            <Text size="sm" variant="muted">
              @{user.username}
            </Text>
          </div>
          <Text variant="muted" size="xs" className="mt-1">
            Username cannot be changed after it is set.
          </Text>
        </div>
      )}
      <div>
        <Text size="xs" weight="medium" className="mb-1 block">
          Bio
        </Text>
        <Textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={PROFILE_BIO_MAX}
          placeholder="Tell your team a little about yourself"
          rows={3}
          aria-label="Bio"
        />
        <Text variant="muted" size="xs" className="mt-1 text-right">
          {bio.length}/{PROFILE_BIO_MAX}
        </Text>
      </div>
      <div>
        <Text size="xs" weight="medium" className="mb-1 block">
          Website
        </Text>
        <Input
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          size="sm"
          maxLength={PROFILE_WEBSITE_MAX}
          placeholder="https://example.com"
          type="url"
          aria-label="Website"
          error={websiteError}
        />
      </div>
      {message && (
        <Text size="xs" variant={message.ok ? 'success' : 'destructive'}>
          {message.text}
        </Text>
      )}
      <Button
        variant="primary"
        size="sm"
        onClick={() => void handleSave()}
        disabled={busy || !!websiteError}
        isLoading={busy}
        loadingText="Saving…"
      >
        Save profile
      </Button>
    </div>
  );
};

// ─── Developer Applications ───────────────────────────────────────────────────

const REDIRECT_URI_PLACEHOLDER = 'https://myapp.com/callback or myapp://callback';

const DeveloperApplications: React.FC = () => {
  const [apps, setApps] = useState<OAuthApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUris, setNewUris] = useState('');
  const [newType, setNewType] = useState<'web' | 'native' | 'spa'>('native');
  const [formError, setFormError] = useState<string | null>(null);
  // clientSecret is shown once after creation and then gone
  const [revealedSecret, setRevealedSecret] = useState<{ clientId: string; secret: string } | null>(null);

  const loadApps = useCallback(async () => {
    setLoading(true);
    try {
      setApps(await oauthApi.list());
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadApps(); }, [loadApps]);

  const handleCreate = async () => {
    setFormError(null);
    const name = newName.trim();
    const redirectUris = newUris.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!name) return setFormError('Name is required.');
    if (redirectUris.length === 0) return setFormError('At least one redirect URI is required.');

    setCreating(true);
    try {
      const app = await oauthApi.create({ name, redirectUris, type: newType });
      if (app.clientSecret) {
        setRevealedSecret({ clientId: app.clientId, secret: app.clientSecret });
      }
      setNewName('');
      setNewUris('');
      setShowForm(false);
      await loadApps();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create application.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await oauthApi.remove(id);
      await loadApps();
    } catch {
      // non-fatal
    }
  };

  return (
    <div className="developer-apps flex flex-col gap-4 px-5 py-4">
      {/* One-time secret reveal */}
      {revealedSecret && (
        <div
          role="alert"
          className="developer-secret-banner rounded border border-yellow-300 bg-yellow-50 p-3 text-sm dark:border-yellow-700 dark:bg-yellow-950"
        >
          <p className="font-medium text-yellow-800 dark:text-yellow-300">
            Save your client secret — it won&apos;t be shown again.
          </p>
          <dl className="developer-secret-fields mt-2 flex flex-col gap-1 font-mono text-xs">
            <div>
              <dt className="inline font-sans font-medium">Client ID: </dt>
              <dd className="inline select-all">{revealedSecret.clientId}</dd>
            </div>
            <div>
              <dt className="inline font-sans font-medium">Client Secret: </dt>
              <dd className="inline select-all">{revealedSecret.secret}</dd>
            </div>
          </dl>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setRevealedSecret(null)}
            aria-label="Dismiss client secret notice"
          >
            I&apos;ve saved it
          </Button>
        </div>
      )}

      {/* App list */}
      {loading ? (
        <Text variant="muted" size="sm">Loading…</Text>
      ) : apps.length === 0 ? (
        <Text variant="muted" size="sm">No applications yet.</Text>
      ) : (
        <ul className="developer-app-list flex flex-col gap-2" role="list">
          {apps.map((app) => (
            <li
              key={app.id}
              className="developer-app-item flex items-center justify-between gap-3 rounded border border-neutral-200 px-3 py-2 dark:border-neutral-700"
            >
              <div className="developer-app-info min-w-0">
                <p className="truncate text-sm font-medium">{app.name}</p>
                <p className="truncate font-mono text-xs text-neutral-500">{app.clientId}</p>
                <p className="text-xs text-neutral-400">{app.type} · {app.redirectUrls.join(', ')}</p>
              </div>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<FontAwesomeIcon icon={faTrash} className="text-xs" />}
                onClick={() => void handleDelete(app.id)}
                aria-label={`Delete application ${app.name}`}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Add application form */}
      {showForm ? (
        <div className="developer-app-form flex flex-col gap-3 rounded border border-neutral-200 p-3 dark:border-neutral-700">
          <Input
            placeholder="Application name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="Application name"
          />
          <Textarea
            placeholder={REDIRECT_URI_PLACEHOLDER}
            value={newUris}
            onChange={(e) => setNewUris(e.target.value)}
            aria-label="Redirect URIs (one per line)"
            rows={3}
          />
          <Select
            value={newType}
            onValueChange={(v) => setNewType(v as 'web' | 'native' | 'spa')}
            aria-label="Application type"
            options={[
              { label: 'Native / Desktop', value: 'native' },
              { label: 'Single-Page App (SPA)', value: 'spa' },
              { label: 'Web (server-side)', value: 'web' },
            ]}
          />
          {formError && (
            <Text variant="destructive" size="sm" role="alert">{formError}</Text>
          )}
          <div className="developer-app-form-actions flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleCreate()}
              isLoading={creating}
              loadingText="Creating…"
              aria-label="Create application"
            >
              Create
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowForm(false); setFormError(null); }}
              aria-label="Cancel"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          leftIcon={<FontAwesomeIcon icon={faPlus} className="text-xs" />}
          onClick={() => setShowForm(true)}
          aria-label="Add OAuth application"
        >
          Add application
        </Button>
      )}
    </div>
  );
};

// ─── SettingsPage ─────────────────────────────────────────────────────────────

export const SettingsPage: React.FC = () => {
  const { user, signOut } = useSession();
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const handlePasswordReset = async () => {
    if (!user?.email || resetBusy) return;
    setResetBusy(true);
    setResetMessage(null);
    try {
      await authApi.requestPasswordReset(user.email, `${window.location.origin}/app`);
      setResetMessage('Check your email for a password reset link.');
    } catch (error: unknown) {
      setResetMessage(error instanceof Error ? error.message : 'Failed to send reset email.');
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <AppPage>
      {/* Profile */}
      <Section icon={faUser} title="Profile" description="Your display name, bio, and website.">
        <ProfileEditor />
      </Section>

      {/* Appearance */}
      <Section
        icon={faPalette}
        title="Appearance"
        description="Control how the application looks on this device."
      >
        <Row label="Brand theme" hint="Switch between brand themes">
          <BrandSelector />
        </Row>
      </Section>

      {/* Push notifications */}
      <Section
        icon={faBell}
        title="Push notifications"
        description="Browser alerts for team clock in/out (same as Time Harbor)."
      >
        <PushNotificationsSettings />
      </Section>

      {/* Account */}
      <Section icon={faGear} title="Account">
        <GitHubConnectionRow />
        <Row label="Reset password" hint="We will email you a link to choose a new password">
          <Button
            variant="outline"
            size="sm"
            leftIcon={<FontAwesomeIcon icon={faRotateLeft} className="text-xs" />}
            onClick={() => void handlePasswordReset()}
            disabled={!user?.email || resetBusy}
            isLoading={resetBusy}
            loadingText="Sending…"
          >
            Reset password
          </Button>
        </Row>
        {resetMessage && (
          <div className="px-5 py-3.5">
            <Text variant="muted" size="xs">
              {resetMessage}
            </Text>
          </div>
        )}
        <Row label="Sign out" hint="You will be returned to the login screen">
          <Button
            variant="danger"
            size="sm"
            leftIcon={<FontAwesomeIcon icon={faRightFromBracket} className="text-xs" />}
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </Row>
      </Section>

      {/* Developer */}
      <Section
        icon={faCode}
        title="Developer"
        description="OAuth 2.0 applications that can \u201cLogin with TimeHuddle\u201d on behalf of your users."
      >
        <DeveloperApplications />
      </Section>

      {/* About */}
      <Section icon={faInfo} title="About" description="Stack versions for this application.">
        {(
          [
            ['Vite', '8'],
            ['React', '19'],
            ['Tailwind CSS', '4'],
            ['TypeScript', '5.9'],
            ['Node.js', '22'],
          ] as const
        ).map(([name, version]) => (
          <Row key={name} label={name}>
            <Badge variant="outline">{version}</Badge>
          </Row>
        ))}
      </Section>
    </AppPage>
  );
};
