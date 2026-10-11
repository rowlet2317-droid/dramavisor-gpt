import { redirect } from "next/navigation";

export default async function PlayPage({ params }: { params: Promise<{ playId: string }> }) {
  const { playId } = await params;
  redirect(`/plays/${playId}/overview`);
}
