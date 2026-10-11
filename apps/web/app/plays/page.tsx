import { getDatabase } from "@drama/db/client";
import { PlayRepository } from "@drama/db/repositories/plays";

import { requirePageUser } from "../../lib/auth/page-session";
import { DeletePlayButton } from "./delete-play-button";

export default async function PlaysPage() {
  const user = await requirePageUser();
  const plays = await new PlayRepository(getDatabase()).list(user.id);
  return <main className="library-page">
    <header className="library-header"><div><p className="eyebrow">Private rehearsal library</p><h1>Your plays</h1>
      <p>Study approved scripts and keep each acting choice grounded in the text.</p></div>
      <a className="button-link" href="/plays/new">Add a play</a></header>
    {plays.length === 0 ? <section className="empty-state"><h2>Your first script starts here.</h2>
      <p>Add an English stage play as a PDF, DOCX, TXT, or pasted script.</p></section> :
      <ul className="play-grid">{plays.map((play) => <li key={play.id}><article className="play-card">
        <p className="status-pill">{play.status.replaceAll("_", " ")}</p><h2>{play.title}</h2>
        <a href={play.status === "review" ? `/plays/${play.id}/review` : `/plays/${play.id}/overview`}>
          {play.status === "review" ? "Review parser issues" : "Open study workspace"} →
        </a><DeletePlayButton playId={play.id} title={play.title} />
      </article></li>)}</ul>}
  </main>;
}
