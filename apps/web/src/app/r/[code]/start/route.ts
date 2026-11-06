// "Start free trial" on a referral link: remember the referrer for 30 days in
// a first-party cookie, then sign up. First referrer wins: a valid cookie
// already set by another client's link is kept.
import { NextResponse, type NextRequest } from "next/server";
import { REFERRAL_COOKIE, REFERRAL_COOKIE_DAYS } from "@strowger/shared/referrals";
import { publicBase, referrerByCode } from "@/lib/referrals";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: RouteContext<"/r/[code]/start">) {
  const { code } = await ctx.params;
  const referrer = await referrerByCode(code);
  const base = publicBase();
  const res = NextResponse.redirect(`${base}/sign-up?redirect_url=%2Fonboarding`, 303);
  const existing = req.cookies.get(REFERRAL_COOKIE)?.value;
  const keepExisting = Boolean(existing && existing !== referrer?.code && (await referrerByCode(existing)));
  if (referrer && !keepExisting) {
    res.cookies.set(REFERRAL_COOKIE, referrer.code, { httpOnly: true, sameSite: "lax", secure: base.startsWith("https:"), path: "/", maxAge: REFERRAL_COOKIE_DAYS * 86_400 });
  }
  return res;
}
