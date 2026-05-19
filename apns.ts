// Send Apple Push Notifications via the HTTP/2 token-based provider API.
//
// Configured via env vars:
//   APNS_KEY_PATH   - path to APNs Auth Key .p8 file
//   APNS_KEY_ID     - 10-char Key ID from developer portal
//   APNS_TEAM_ID    - 10-char Team ID
//   APNS_BUNDLE_ID  - app bundle id, used as apns-topic
//   APNS_ENV        - "sandbox" (default) or "production"
//
// If any required var is missing, `APNs.fromEnv()` returns undefined and
// the bridge silently falls back to no-op pushes (the iOS local
// notification path still works while the app is alive).

import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { createSign, createPrivateKey, type KeyObject } from "node:crypto";

export interface APNsPayload {
  title: string;
  body: string;
  /** Optional category for action buttons; matched on the device side. */
  category?: string;
  /** Arbitrary client-side keys merged into the top-level dict; used for
   *  wakeup data (sessionId, etc.) so the iOS app can navigate on tap. */
  custom?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  status: number;
  reason?: string;
  apnsId?: string;
}

const TOKEN_REFRESH_MS = 45 * 60 * 1000; // APNs accepts tokens up to 60 min old

export class APNs {
  private session?: ClientHttp2Session;
  private cachedJwt?: { token: string; issuedAt: number };
  private privateKey: KeyObject;

  private constructor(
    private readonly host: string,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly bundleId: string,
    private readonly keyPem: string,
  ) {
    this.privateKey = createPrivateKey(keyPem);
  }

  static fromEnv(): APNs | undefined {
    const keyPath = process.env.APNS_KEY_PATH;
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const bundleId = process.env.APNS_BUNDLE_ID;
    const envName = (process.env.APNS_ENV ?? "sandbox").toLowerCase();

    if (!keyPath || !keyId || !teamId || !bundleId) {
      console.log("[apns] disabled, env not configured");
      return undefined;
    }

    let pem: string;
    try {
      pem = readFileSync(keyPath, "utf8");
    } catch (err: any) {
      console.error(`[apns] failed to read key file ${keyPath}:`, err?.message ?? err);
      return undefined;
    }

    const host = envName === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

    console.log(`[apns] enabled host=${host} keyId=${keyId} teamId=${teamId} bundleId=${bundleId}`);
    return new APNs(host, keyId, teamId, bundleId, pem);
  }

  /**
   * Send a single push to a device token. Returns the HTTP status and the
   * reason string from APNs (`BadDeviceToken`, `Unregistered`, etc.) so
   * the caller can prune stale device tokens from its subscription map.
   */
  async send(deviceToken: string, payload: APNsPayload): Promise<SendResult> {
    const session = this.getSession();
    const jwt = this.getJwt();

    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
    };
    if (payload.category) aps.category = payload.category;

    const body = JSON.stringify({
      aps,
      ...(payload.custom ?? {}),
    });

    return new Promise<SendResult>((resolve) => {
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        "authorization": `bearer ${jwt}`,
        "apns-topic": this.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      });

      let status = 0;
      let apnsId: string | undefined;
      let respBody = "";

      req.on("response", (headers) => {
        status = Number(headers[":status"]) || 0;
        const id = headers["apns-id"];
        if (typeof id === "string") apnsId = id;
      });
      req.setEncoding("utf8");
      req.on("data", (chunk) => { respBody += chunk; });
      req.on("end", () => {
        let reason: string | undefined;
        if (respBody) {
          try { reason = JSON.parse(respBody).reason; } catch {}
        }
        resolve({ ok: status >= 200 && status < 300, status, reason, apnsId });
      });
      req.on("error", (err) => {
        console.error("[apns] request error:", err.message);
        resolve({ ok: false, status: 0, reason: err.message });
      });

      req.end(body);
    });
  }

  /** Send to many device tokens, log failures, return results in input order. */
  async sendMany(deviceTokens: Iterable<string>, payload: APNsPayload): Promise<Array<{ token: string; result: SendResult }>> {
    const tokens = [...deviceTokens];
    const results = await Promise.all(tokens.map(async (token) => {
      const result = await this.send(token, payload);
      if (!result.ok) {
        console.log(`[apns] send FAILED token=${token.slice(0, 8)}… status=${result.status} reason=${result.reason ?? "?"}`);
      } else {
        console.log(`[apns] send ok token=${token.slice(0, 8)}… apnsId=${result.apnsId ?? "?"}`);
      }
      return { token, result };
    }));
    return results;
  }

  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    console.log(`[apns] connecting ${this.host}`);
    this.session = connect(this.host);
    this.session.on("error", (err) => {
      console.error("[apns] session error:", err.message);
    });
    this.session.on("close", () => {
      console.log("[apns] session closed");
    });
    return this.session;
  }

  private getJwt(): string {
    const now = Date.now();
    if (this.cachedJwt && now - this.cachedJwt.issuedAt < TOKEN_REFRESH_MS) {
      return this.cachedJwt.token;
    }
    const iat = Math.floor(now / 1000);
    const headerB64 = base64url(JSON.stringify({ alg: "ES256", kid: this.keyId, typ: "JWT" }));
    const payloadB64 = base64url(JSON.stringify({ iss: this.teamId, iat }));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signer = createSign("SHA256");
    signer.update(signingInput);
    const derSig = signer.sign(this.privateKey);
    // node's createSign returns DER-encoded ECDSA signature; APNs needs raw r||s.
    const rawSig = derToJose(derSig, 32);
    const token = `${signingInput}.${rawSig.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    this.cachedJwt = { token, issuedAt: now };
    return token;
  }
}

function base64url(input: string | Buffer): string {
  const b = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * ECDSA signatures from node's createSign are DER-encoded. JOSE / JWT
 * spec wants the raw concatenation of r and s, each padded to `coord`
 * bytes (32 for P-256). This converts.
 */
function derToJose(der: Buffer, coordBytes: number): Buffer {
  // DER: 0x30 totalLen 0x02 rLen rBytes 0x02 sLen sBytes
  if (der[0] !== 0x30) throw new Error("Invalid DER signature");
  let i = 2;
  if (der[1] === 0x81) i = 3;
  if (der[i] !== 0x02) throw new Error("Invalid DER signature (r)");
  const rLen = der[i + 1]!;
  let r = der.subarray(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (der[i] !== 0x02) throw new Error("Invalid DER signature (s)");
  const sLen = der[i + 1]!;
  let s = der.subarray(i + 2, i + 2 + sLen);

  // Strip leading zero (DER preserves sign bit), then left-pad to coordBytes.
  if (r.length > coordBytes) r = r.subarray(r.length - coordBytes);
  if (s.length > coordBytes) s = s.subarray(s.length - coordBytes);
  const rPadded = Buffer.concat([Buffer.alloc(coordBytes - r.length), r]);
  const sPadded = Buffer.concat([Buffer.alloc(coordBytes - s.length), s]);
  return Buffer.concat([rPadded, sPadded]);
}
