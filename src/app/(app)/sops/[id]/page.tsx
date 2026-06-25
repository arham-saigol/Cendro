import { SopDetail } from "@/components/app/sop-pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SopDetail id={id} />;
}