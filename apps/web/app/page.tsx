export default function HomePage() {
  return <main className="home-page">
    <nav className="home-nav" aria-label="Main navigation">
      <a className="wordmark" href="/" aria-label="Drama Practice home"><img src="/icons/masks-theater.svg" alt="" width="28" height="28" /><span>Drama Practice</span></a>
      <a href="/sign-in">Sign in</a>
    </nav>
    <section className="hero"><div className="hero-copy">
      <p className="eyebrow">Your private rehearsal room</p>
      <h1>Know the text.<br /><em>Make the choice.</em></h1>
      <p className="hero-intro">Study the script, explore your character, and rehearse out loud—with every insight grounded in the words on the page.</p>
      <div className="home-actions"><a className="button-link" href="/sign-in">Start rehearsing <span aria-hidden="true">→</span></a><a href="/plays">Open your plays</a></div>
    </div><aside className="hero-stage" aria-label="From page to performance"><div className="stage-glow" /><p className="stage-direction">[ A quiet stage. Your cue approaches. ]</p><blockquote>“The readiness is all.”</blockquote><p className="stage-credit">Hamlet · Act V, Scene II</p></aside></section>
    <section className="feature-strip" aria-label="Practice features">
      <article><img src="/icons/book-open.svg" alt="" width="30" height="30" /><div><h2>Study with evidence</h2><p>Trace every observation back to the script.</p></div></article>
      <article><img src="/icons/masks-theater.svg" alt="" width="30" height="30" /><div><h2>Build the character</h2><p>Turn close reading into playable choices.</p></div></article>
      <article><img src="/icons/microphone.svg" alt="" width="30" height="30" /><div><h2>Rehearse out loud</h2><p>Run the scene with responsive partners.</p></div></article>
    </section>
  </main>;
}
