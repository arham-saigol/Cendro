"use node";

import { ConvexError, v } from "convex/values";
import { Resend } from "resend";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const sendInvitation = internalAction({
  args: { companyId: v.id("companies"), invitationId: v.id("invitations"), email: v.string(), role: v.union(v.literal("Admin"), v.literal("Manager"), v.literal("Employee")), token: v.string() },
  handler: async (ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    if (!apiKey || !from) throw new ConvexError("Invitation email is not configured.");
    const url = `${appUrl}/invite/${encodeURIComponent(args.token)}`;
    const result = await new Resend(apiKey).emails.send({
      from,
      to: args.email,
      subject: "You’re invited to Cendro",
      html: `<p>You have been invited to join Cendro as <strong>${args.role}</strong>.</p><p><a href="${url}">Accept invitation</a></p>`,
      text: `You have been invited to join Cendro as ${args.role}. Accept: ${url}`,
    });
    if (result.error) throw new ConvexError("Could not send invitation email.");
    await ctx.runMutation(internal.invitations.markSent, { invitationId: args.invitationId });
    return { skipped: false };
  },
});
