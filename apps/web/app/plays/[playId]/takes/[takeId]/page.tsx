import { requirePageUser } from "../../../../../lib/auth/page-session";
import { CoachingTakeView } from "../../../../../components/coaching/coaching-take-view";

export default async function TakeReportPage({ params }: {
  params: Promise<{ playId: string; takeId: string }>;
}) {
  await requirePageUser();
  const { playId, takeId } = await params;
  return <main className="coaching-page">
    <header className="coaching-header"><p className="eyebrow">Private performance review</p>
      <h1>Coaching report</h1><p>Every claim links back to transcript, measurement, or replayable audio evidence.</p>
    </header>
    <CoachingTakeView playId={playId} takeId={takeId} />
  </main>;
}
