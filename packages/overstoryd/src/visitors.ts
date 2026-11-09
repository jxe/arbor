import { sha256 } from "@ovst/protocol";

/**
 * A visitor (accounts §5.6): a profile with no account at this host, whose
 * device its home host's published keys list. It reads what this host's rules
 * grant the profile by a locator at that home host, and nothing more.
 */
export interface VisitorAuthentication {
  profileTree: string;
  /** The home host whose published keys vouched for the device. */
  homeHost: string;
  device: string;
  /** The device's key as the home host listed it when the session opened. */
  key: string;
  /** The subject its reads are recorded under, as a device session's are. */
  subject: `device:${string}`;
  expiresAt: number;
}

/** Visitor session tokens carry their own prefix, so a lookup never touches the account tables. */
export const VISITOR_TOKEN_PREFIX = "arv_";

/**
 * Visitor sessions, in memory only: a visitor holds no account and nothing of
 * it is stored, so a restart ends every visitor session and the visitor's
 * client opens another on its next 401, as after any expiry.
 */
export class VisitorSessions {
  private readonly sessions = new Map<string, VisitorAuthentication>();

  open(visitor: Omit<VisitorAuthentication, "subject">): string {
    this.prune(Date.now());
    const token = `${VISITOR_TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
    this.sessions.set(sha256(token), { ...visitor, subject: `device:${visitor.device}` });
    return token;
  }

  authenticate(token: string | undefined): VisitorAuthentication | null {
    if (!token?.startsWith(VISITOR_TOKEN_PREFIX)) return null;
    const digest = sha256(token);
    const session = this.sessions.get(digest);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(digest);
      return null;
    }
    return session;
  }

  /** End every session of a device its home host no longer lists with that key. */
  endUnlisted(profileTree: string, homeHost: string, listedKey: (device: string) => string | undefined): void {
    for (const [digest, session] of this.sessions) {
      if (session.profileTree === profileTree && session.homeHost === homeHost && listedKey(session.device) !== session.key) this.sessions.delete(digest);
    }
  }

  /** End every visitor session of a profile, as when it becomes an account here. */
  endProfile(profileTree: string): void {
    for (const [digest, session] of this.sessions) if (session.profileTree === profileTree) this.sessions.delete(digest);
  }

  /** Whether the session is still held: not expired, and not ended by a refresh. */
  active(visitor: VisitorAuthentication): boolean {
    if (visitor.expiresAt <= Date.now()) return false;
    for (const session of this.sessions.values()) if (session === visitor) return true;
    return false;
  }

  /** The profiles and home hosts with at least one open session, for the key refresh. */
  openProfiles(now = Date.now()): Array<{ profileTree: string; homeHost: string }> {
    const seen = new Map<string, { profileTree: string; homeHost: string }>();
    for (const session of this.sessions.values()) {
      if (session.expiresAt > now) seen.set(`${session.homeHost} ${session.profileTree}`, { profileTree: session.profileTree, homeHost: session.homeHost });
    }
    return [...seen.values()];
  }

  private prune(now: number): void {
    for (const [digest, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(digest);
  }
}
