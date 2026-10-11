import type { PlayModel } from "@drama/domain/play-model";
import Link from "next/link";

export function StudyNav({ playId, play }: { playId: string; play: PlayModel }) {
  return (
    <nav className="study-nav" aria-label={`${play.title} study sections`}>
      <Link className="study-nav__back" href="/plays">← All plays</Link>
      <p className="eyebrow">Your script</p>
      <h1>{play.title}</h1>
      <ul>
        <li><Link href={`/plays/${playId}/overview`}>Overview</Link></li>
        <li><Link href={`/plays/${playId}/characters`}>Characters</Link></li>
        <li><Link href={`/plays/${playId}/my-role`}>My Role</Link></li>
        <li><Link href={`/plays/${playId}/recordings`}>Recordings &amp; coaching</Link></li>
      </ul>
      <p className="eyebrow">Scenes</p>
      <ol className="scene-nav">{play.acts.flatMap((act) => act.scenes.map((scene) => (
        <li key={scene.id}>
          <Link href={`/plays/${playId}/scenes/${encodeURIComponent(scene.id)}`}>
            A{act.ordinal} · S{scene.ordinal} {scene.title}
          </Link>
        </li>
      )))}</ol>
    </nav>
  );
}
