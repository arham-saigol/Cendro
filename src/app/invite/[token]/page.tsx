import { InviteClient } from "./invite-client";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return <InviteClient token={token} />;
}
