import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)", "/api/health", "/api/v1/(.*)", "/api/webhooks/(.*)", "/cb/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export const config = {
  // /api/health and /api/v1 (affiliate posting, keyed by its own bearer token)
  // never touch Clerk, so the healthcheck and posting work with no session.
  matcher: [
    "/((?!_next|api/health|api/v1|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api(?!/health|/v1)|trpc)(.*)",
  ],
};
