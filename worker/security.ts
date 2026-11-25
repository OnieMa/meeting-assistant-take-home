import type { Env } from './types';

const encoder = new TextEncoder();
const cookieName = 'meeting_session';
const sessionDays = 30;
const secondsPerDay = 86_400;
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');

export const hash = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

export function accessCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (value) => alphabet[value & 31]).join('').match(/.{5}/g)!.join('-');
}

export function normalizedCode(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

export function sessionToken(request: Request) {
  return request.headers.get('Cookie')?.split(/;\s*/).find((value) =>
    value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

export function sessionCookie(request: Request, token: string, age: number) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}

export async function newSession(request: Request, env: Env, workspace: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const age = sessionDays * secondsPerDay;
  await env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(
    await hash(token), workspace, Date.now() + age * 1000,
  ).run();
  return sessionCookie(request, token, age);
}

export async function currentWorkspace(request: Request, env: Env) {
  const token = sessionToken(request);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare('SELECT workspace_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await hash(token), Date.now()).first<string>('workspace_id');
}

export async function jobProof(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export function matches(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
