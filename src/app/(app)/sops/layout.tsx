"use client";

import { useParams } from "next/navigation";
import { DetailDrawerLayout } from "@/components/app/detail-drawer-layout";
import { SopList } from "@/components/app/sop-pages";

export default function SopsLayout({ children }: { children: React.ReactNode }) {
  const sopId = useParams<{ id?: string }>()?.id;
  return <DetailDrawerLayout base="/sops" detailId={sopId} drawerKey="sop-drawer" label="SOP" list={<SopList selectedId={sopId} />}>{children}</DetailDrawerLayout>;
}
