const clerkDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (!clerkDomain) throw new Error("Missing CLERK_JWT_ISSUER_DOMAIN for Convex auth configuration.");

export default { providers: [{ domain: clerkDomain, applicationID: "convex" }] };
