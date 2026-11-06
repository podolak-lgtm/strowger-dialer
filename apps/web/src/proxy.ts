import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)", "/api/health", "/api/version", "/api/v1/(.*)", "/api/webhooks/(.*)", "/cb/(.*)", "/r/(.*)", "/legal/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export const config = {
  // /api/health, /api/version and /api/v1 (affiliate posting, keyed by its
  // own bearer token) never touch Clerk, so the healthcheck, the deploy
  // check and posting work with no session. /r/<code> (referral landing,
  // which sets the strowger_ref cookie) and /legal/* (terms) are public
  // pages: they still pass through Clerk, which only reads the session.
  matcher: [
    "/((?!_next|api/health|api/version|api/v1|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api(?!/health|/version|/v1)|trpc)(.*)",
  ],
};
