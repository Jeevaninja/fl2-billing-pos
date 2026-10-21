/**
 * Counter sign-in sessions (Phase 25, D3).
 * - Each session is a 256-bit random token that travels in an HttpOnly, SameSite=Strict cookie.
 * - The server keeps only the token's SHA-256, in memory, with a 16-hour absolute lifetime.
 * - An API restart signs everyone out, and no session row is ever stored or synced.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { StaffSummary } from '../src/services/index.js';

export const SESSION_COOKIE = 'fl2_session';
export const SESSION_TTL_MS = 16 * 60 * 60 * 1000;

export interface Session {
  staff: StaffSummary;
  expiresAt: Date;
}

const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SESSION_TTL_MS,
  ) {}

  issue(staff: StaffSummary): { token: string; session: Session } {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    const session = { staff, expiresAt: new Date(this.now() + this.ttlMs) };
    this.sessions.set(sha256(token), session);
    return { token, session };
  }

  /** The live session for `token`, or null (unknown or expired). */
  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const key = sha256(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(sha256(token));
  }

  /** Signs a staff member out everywhere (e.g. when their account is deactivated). */
  revokeStaff(staffId: string): void {
    for (const [key, session] of this.sessions) if (session.staff.id === staffId) this.sessions.delete(key);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt.getTime() <= now) this.sessions.delete(key);
  }
}

/** The session token from a `Cookie` header, if present. */
export function sessionToken(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

/** Plain HTTP on loopback, so no `Secure`; `Path=/api` keeps the cookie off everything else. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAgeSeconds}`;
}

export const clearedSessionCookie = () => sessionCookie('', 0);
