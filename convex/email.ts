"use node";

import { ConvexError, v } from "convex/values";
import { Resend } from "resend";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export const sendInvitation = internalAction({
  // Reads the stored record so the delivery address can never drift from the
  // normalized email the invitation was created with.
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const invitation = await ctx.runQuery(internal.invitations.getForSend, { invitationId: args.invitationId });
    if (!invitation) throw new ConvexError("Invitation not found.");
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    const appUrl = process.env.APP_URL;
    if (!apiKey || !from || !appUrl) throw new ConvexError("Invitation email is not configured.");
    const url = `${appUrl}/invite/${encodeURIComponent(invitation.token)}`;
    const result = await new Resend(apiKey).emails.send({
      from,
      to: invitation.email,
      subject: "You’re invited to Cendro",
      html: `<p>You have been invited to join Cendro as <strong>${escapeHtml(invitation.role)}</strong>.</p><p><a href="${url}">Accept invitation</a></p>`,
      text: `You have been invited to join Cendro as ${invitation.role}. Accept: ${url}`,
    });
    if (result.error) throw new ConvexError("Could not send invitation email.");
    await ctx.runMutation(internal.invitations.markSent, { invitationId: args.invitationId });
    return { skipped: false };
  },
});
