import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type SignedTokenSigner = {
  sign<T extends JsonValue>(payload: T): string;
  verify<T extends JsonValue>(token: string): T | null;
};

function encodeBase64Url(input: Buffer | string): string {
  return Buffer.isBuffer(input)
    ? input.toString('base64url')
    : Buffer.from(input, 'utf8').toString('base64url');
}

function decodeBase64Url(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function signPart(secret: Buffer, part: string): string {
  return crypto.createHmac('sha256', secret).update(part).digest('base64url');
}

export function createSignedTokenSigner(secret?: string | Buffer): SignedTokenSigner {
  const signingSecret = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(secret ?? crypto.randomBytes(32).toString('hex'), 'utf8');

  return {
    sign<T extends JsonValue>(payload: T): string {
      const encodedPayload = encodeBase64Url(JSON.stringify(payload));
      const signature = signPart(signingSecret, encodedPayload);
      return `${encodedPayload}.${signature}`;
    },

    verify<T extends JsonValue>(token: string): T | null {
      const [encodedPayload, suppliedSignature, extra] = String(token ?? '').split('.');
      if (!encodedPayload || !suppliedSignature || extra) return null;

      const expectedSignature = signPart(signingSecret, encodedPayload);
      try {
        const supplied = Buffer.from(suppliedSignature, 'base64url');
        const expected = Buffer.from(expectedSignature, 'base64url');
        if (supplied.length !== expected.length) return null;
        if (!crypto.timingSafeEqual(supplied, expected)) return null;
      } catch {
        return null;
      }

      const decoded = decodeBase64Url(encodedPayload);
      if (!decoded) return null;

      try {
        return JSON.parse(decoded) as T;
      } catch {
        return null;
      }
    },
  };
}

export async function loadOrCreateSigningSecret(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);

  try {
    const existing = (await fs.readFile(resolved, 'utf8')).trim();
    if (existing) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const generated = crypto.randomBytes(32).toString('hex');

  try {
    await fs.writeFile(resolved, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const raced = (await fs.readFile(resolved, 'utf8')).trim();
  if (!raced) {
    throw new Error(`Signing secret file exists but is empty: ${resolved}`);
  }
  return raced;
}
