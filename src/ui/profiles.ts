/**
 * Credential profiles (SPEC §4). Profiles live in memory by default; the
 * explicit "remember on this device" opt-in persists them to localStorage —
 * with plain wording in the UI about what that means. Credentials are never
 * sent anywhere except to AWS via SigV4.
 */

export interface Profile {
  name: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** the workspace (subdomain) this profile belongs to; '' = the apex/home */
  subdomain?: string;
}

const STORAGE_KEY = 'tracelog-viewer:profiles';
const ACTIVE_KEY = 'tracelog-viewer:active-profile';

class ProfileStore extends EventTarget {
  private profiles = new Map<string, Profile>();
  private activeName: string | null = null;
  remembered: boolean;

  constructor() {
    super();
    const raw = localStorage.getItem(STORAGE_KEY);
    this.remembered = raw !== null;
    if (raw) {
      try {
        for (const p of JSON.parse(raw) as Profile[]) this.profiles.set(p.name, p);
        const active = localStorage.getItem(ACTIVE_KEY);
        if (active && this.profiles.has(active)) this.activeName = active;
      } catch {
        this.remembered = false;
      }
    }
  }

  list(): Profile[] {
    return [...this.profiles.values()];
  }

  active(): Profile | null {
    return this.activeName ? (this.profiles.get(this.activeName) ?? null) : null;
  }

  save(profile: Profile): void {
    this.profiles.set(profile.name, profile);
    this.activeName = profile.name;
    this.persistIfRemembered();
    this.dispatchEvent(new Event('change'));
  }

  remove(name: string): void {
    this.profiles.delete(name);
    if (this.activeName === name) this.activeName = null;
    this.persistIfRemembered();
    this.dispatchEvent(new Event('change'));
  }

  setActive(name: string): void {
    if (this.profiles.has(name)) {
      this.activeName = name;
      this.persistIfRemembered();
      this.dispatchEvent(new Event('change'));
    }
  }

  setRemembered(remember: boolean): void {
    this.remembered = remember;
    if (remember) {
      this.persistIfRemembered();
    } else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ACTIVE_KEY);
    }
    this.dispatchEvent(new Event('change'));
  }

  private persistIfRemembered(): void {
    if (!this.remembered) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list()));
    if (this.activeName) localStorage.setItem(ACTIVE_KEY, this.activeName);
  }
}

export const profiles = new ProfileStore();
