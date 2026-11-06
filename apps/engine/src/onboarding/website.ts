// The 10DLC website check (onboarding wizard, Business step; owner, 6 Nov:
// "double-checking the website and flagging what wouldn't work"). Fetches the
// home page and the privacy policy it links, and hands the HTML to the pure
// readers in `@strowger/shared/tendlc` (`analyzeSite`, `privacyNoSharingIn`),
// which decide what to flag.
//
// The address comes from a client, so the fetch refuses anything that is not
// a public http(s) host: every hop (redirects are followed by hand) is
// resolved and private, loopback, link-local and CGNAT addresses are refused.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { analyzeSite, normalizeWebsite, privacyNoSharingIn, type WebsiteFindings } from "@strowger/shared/tendlc";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 5;
const UA = "Mozilla/5.0 (compatible; StrowgerSiteCheck/1.0; +https://strowger.crossbar.digital)";

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? privateAddress(m[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) addresses");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("non-standard port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.railway\.internal)$/i.test(host)) throw new Error("not a public host");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error("not a public host");
}

/** GET with redirects followed by hand (each hop checked), a size cap and a timeout. */
async function get(url: string): Promise<{ status: number; finalUrl: string; html: string }> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublic(current);
    const res = await fetch(current, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        html += dec.decode(value, { stream: true });
        if (size > MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    return { status: res.status, finalUrl: current.toString(), html };
  }
  throw new Error("too many redirects");
}

const reason = (e: unknown) => {
  const m = e instanceof Error ? (e.name === "TimeoutError" ? "it took longer than 8 seconds" : e.message) : String(e);
  return /ENOTFOUND|EAI_AGAIN/.test(m) ? "the address does not exist" : /ECONNREFUSED/.test(m) ? "the server refused the connection" : /certificate|SSL|TLS/i.test(m) ? "its security certificate is not valid" : m.slice(0, 120);
};

/** Check a business website for what TCR and the carriers look at. Never throws. */
export async function checkWebsite(website: string, names: string[]): Promise<WebsiteFindings> {
  const checkedAt = new Date().toISOString();
  const url = normalizeWebsite(website);
  const none = { showsName: null, privacyUrl: null, termsUrl: null, privacyNoSharing: null, smsDisclosure: null };
  if (!url) return { url: website, checkedAt, reachable: false, error: "not a web address", ...none };
  let home;
  try {
    home = await get(url);
  } catch (e) {
    return { url, checkedAt, reachable: false, error: reason(e), ...none };
  }
  if (home.status >= 400) return { url, checkedAt, reachable: false, status: home.status, finalUrl: home.finalUrl, ...none };
  const a = analyzeSite(home.html, home.finalUrl, names.filter(Boolean));
  let privacyReachable: boolean | null = null;
  let privacyNoSharing: boolean | null = null;
  if (a.privacyUrl) {
    try {
      const p = await get(a.privacyUrl);
      privacyReachable = p.status < 400;
      privacyNoSharing = privacyReachable ? privacyNoSharingIn(p.html) : null;
    } catch {
      privacyReachable = false;
    }
  }
  return { url, checkedAt, reachable: true, status: home.status, finalUrl: home.finalUrl, https: home.finalUrl.startsWith("https://"), ...a, privacyReachable, privacyNoSharing };
}
