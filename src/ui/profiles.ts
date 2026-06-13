/**
 * The connection for this workspace (SPEC §4). One profile per origin: the
 * subdomain *is* the namespace, so there's no separate profile name — you
 * connect a workspace to one bucket. The profile is persisted to this
 * origin's localStorage so the workspace stays connected across reloads and
 * subdomain hops (the config panel warns about this and offers a purge).
 * Credentials are never sent anywhere except to AWS via SigV4.
 */

export interface Profile {
  region: string;
  bucket: string;
  /** optional key prefix under which the tracelog channels live (e.g. `logs/`) */
  prefix?: string;
  /** public bucket — read anonymously, no credentials stored or sent */
  public?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** the workspace (subdomain) this profile belongs to; '' = single-origin */
  subdomain?: string;
}

const KEY = 'tracelog-viewer:profile';
// the previous multi-profile format, migrated on first load
const OLD_LIST_KEY = 'tracelog-viewer:profiles';
const OLD_ACTIVE_KEY = 'tracelog-viewer:active-profile';

class ProfileStore extends EventTarget {
  private profile: Profile | null = null;

  constructor() {
    super();
    const raw = localStorage.getItem(KEY);
    if (raw) {
      try {
        this.profile = JSON.parse(raw) as Profile;
      } catch {
        /* malformed — leave disconnected */
      }
      return;
    }
    this.migrateOldFormat();
  }

  /** Old multi-profile arrays collapse to the active (or first) profile. */
  private migrateOldFormat(): void {
    const oldRaw = localStorage.getItem(OLD_LIST_KEY);
    if (!oldRaw) return;
    try {
      const arr = JSON.parse(oldRaw) as (Profile & { name?: string })[];
      const activeName = localStorage.getItem(OLD_ACTIVE_KEY);
      const chosen = arr.find((p) => p.name === activeName) ?? arr[0];
      if (chosen) {
        delete chosen.name;
        this.profile = chosen;
        this.persist();
      }
    } catch {
      /* ignore malformed legacy data */
    }
    localStorage.removeItem(OLD_LIST_KEY);
    localStorage.removeItem(OLD_ACTIVE_KEY);
  }

  active(): Profile | null {
    return this.profile;
  }

  save(profile: Profile): void {
    this.profile = profile;
    this.persist();
    this.dispatchEvent(new Event('change'));
  }

  remove(): void {
    this.profile = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* storage disabled */
    }
    this.dispatchEvent(new Event('change'));
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.profile));
    } catch {
      /* storage disabled — profile stays in memory for this session */
    }
  }
}

export const profiles = new ProfileStore();
