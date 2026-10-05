// OAuth 1.0a request signing (RFC 5849), as NetSuite token-based authentication requires.
import { createHmac, randomBytes } from 'node:crypto';

const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function oauth1Header({
  method,
  url,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  realm,
  signatureMethod = 'HMAC-SHA256',
  bodyParams = {}, // only for form-encoded bodies; NetSuite's JSON bodies are not signed
  nonce = randomBytes(16).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000).toString(),
}) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: signatureMethod,
    oauth_timestamp: timestamp,
    oauth_token: token,
    oauth_version: '1.0',
  };

  // Signature base: every oauth_* param plus every query param, encoded, sorted.
  const params = [...Object.entries(oauth), ...u.searchParams.entries(), ...Object.entries(bodyParams)].map(([k, v]) => [enc(k), enc(v)]);
  params.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1));
  const paramString = params.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [method.toUpperCase(), enc(baseUrl), enc(paramString)].join('&');

  const algo = signatureMethod === 'HMAC-SHA1' ? 'sha1' : 'sha256';
  const signature = createHmac(algo, `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest('base64');

  const header = { ...oauth, oauth_signature: signature };
  const parts = Object.entries(header).map(([k, v]) => `${k}="${enc(v)}"`);
  return `OAuth ${realm ? `realm="${realm}", ` : ''}${parts.join(', ')}`;
}
