/**
 * Static protection for the one secret this plugin stores: the proxy password.
 *
 * The settings file is a plain JSON document under the user's home, so a
 * credential written into it verbatim leaks with the file — a copied backup, a
 * synced folder, a bug report that pastes the whole settings object. This module
 * is the one place that turns such a password into something only this machine
 * (and, on Windows, only this user account) can put back.
 *
 * Two backends, in descending order of strength. The settings page reports which
 * one is in force instead of implying the stronger one:
 *
 *   windows-dpapi  `CryptProtectData` with a per-user key the OS holds. The
 *                  ciphertext is bound to the Windows account, so it cannot be
 *                  decrypted off the machine at all — not by whoever ends up
 *                  with the file, and not by this plugin on another host. The
 *                  price is that moving the install means retyping the password.
 *
 *   machine-aes    AES-256-GCM under a key derived (scrypt) from a fingerprint
 *                  of this machine. Everything needed to decrypt travels with
 *                  the file, so this only raises the cost of an offline attack;
 *                  it does not make one impossible. It exists so the plugin
 *                  still protects the password on platforms with no OS facility
 *                  to borrow, and it is honest about being the weaker half.
 *
 * Neither backend defends against code already running as this user: that code
 * can call `openSecret` itself. `settings.json` is written 0600 for the same
 * reason — it narrows the audience, it does not eliminate it.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Long enough for a cold PowerShell start, short enough not to wedge a boot. */
const DPAPI_TIMEOUT_MS = 15_000

/** The plaintext travels in the environment, never interpolated into the script. */
const DPAPI_ENV = 'OFM_SECRET_IN'

/**
 * `Add-Type` is not optional: Windows PowerShell 5.1 does not load
 * System.Security on its own, and without it `ProtectedData` reports
 * `TypeNotFound` rather than failing in any way that names the real problem.
 *
 * The payload crosses as base64 in both directions so that a password with
 * characters outside the console's code page survives the trip.
 */
const DPAPI_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  `$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:${DPAPI_ENV})`,
  '$blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($blob))',
].join('; ')

const DPAPI_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  `$blob = [Convert]::FromBase64String($env:${DPAPI_ENV})`,
  '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($bytes))',
].join('; ')

/** 2^15 costs ~32 MB per derivation, which is why every call raises `maxmem`. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

/**
 * The strongest backend this platform can offer. It says what `sealSecret`
 * *will* reach for, not what an existing record used — a file written on
 * Windows and read elsewhere keeps its own scheme, and `openSecret` dispatches
 * on the record rather than on the host.
 */
export function secretBackend() {
  return process.platform === 'win32' ? 'windows-dpapi' : 'machine-aes'
}

/**
 * Encrypt `plain` for storage, or return `null` when there is nothing to store.
 *
 * A Windows DPAPI failure falls through to `machine-aes` rather than storing
 * nothing: losing the password silently would be worse than protecting it with
 * the weaker backend, and `egressStatus().secretScheme` reports which one was
 * actually used.
 *
 * @param {string} plain
 * @returns {Promise<{scheme: string, blob?: string, salt?: string, iv?: string, tag?: string, data?: string}|null>}
 */
export async function sealSecret(plain) {
  const text = typeof plain === 'string' ? plain : ''
  if (text === '') return null
  if (process.platform === 'win32') {
    try {
      return { scheme: 'windows-dpapi', blob: await runDpapi(DPAPI_PROTECT, text) }
    } catch { /* no DPAPI here: fall through to the weaker backend */ }
  }
  return { scheme: 'machine-aes', ...machineSeal(text) }
}

/**
 * Decrypt a record produced by `sealSecret`.
 *
 * `undefined` means "the password is gone" — a different machine, a different
 * Windows account, a corrupted file, or a record this build does not know. The
 * caller turns that into a prompt to retype rather than an exception, because a
 * settings page that cannot render because of a stale blob is a worse outcome
 * than one that asks for the password again.
 *
 * @param {unknown} record
 * @returns {Promise<string|undefined>}
 */
export async function openSecret(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (record.scheme === 'windows-dpapi') {
    if (typeof record.blob !== 'string' || record.blob === '') return undefined
    try {
      return Buffer.from(await runDpapi(DPAPI_UNPROTECT, record.blob), 'base64').toString('utf8')
    } catch {
      return undefined
    }
  }
  if (record.scheme === 'machine-aes') return machineOpen(record)
  return undefined
}

async function runDpapi(script, input) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    env: { ...process.env, [DPAPI_ENV]: input },
    windowsHide: true,
    timeout: DPAPI_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  })
  const out = String(stdout).trim()
  if (out === '') throw new Error('DPAPI returned nothing')
  return out
}

/**
 * What the fallback key is derived from.
 *
 * These are the properties that make the file useful on this machine and much
 * less useful anywhere else. They are not secret — anyone who has the file can
 * guess them — which is exactly why this backend is documented as the weaker
 * one and not presented as equivalent to DPAPI.
 */
function machineFingerprint() {
  let username = ''
  try { username = os.userInfo().username } catch { /* no passwd entry: fall back to the rest */ }
  return crypto.createHash('sha256')
    .update([os.hostname(), username, process.platform, process.arch, os.homedir()].join('\u0000'))
    .digest()
}

function machineKey(salt) {
  return crypto.scryptSync(machineFingerprint(), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  })
}

function machineSeal(plain) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(salt), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function machineOpen(record) {
  try {
    const salt = Buffer.from(String(record.salt ?? ''), 'base64')
    const iv = Buffer.from(String(record.iv ?? ''), 'base64')
    const tag = Buffer.from(String(record.tag ?? ''), 'base64')
    const data = Buffer.from(String(record.data ?? ''), 'base64')
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) return undefined
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(salt), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    // A wrong fingerprint surfaces as an authentication-tag failure, which is
    // the same answer as a missing record: ask for the password again.
    return undefined
  }
}
