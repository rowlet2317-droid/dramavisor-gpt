import type { CoachingReport } from "@drama/domain/coaching";

export function PriorityNotes({ report }: { report: CoachingReport }) {
  return <div className="coaching-notes">
    <section><h2>What is working</h2><ul>{report.strengths.map((note, index) =>
      <li key={`${note.text}:${index}`}>{note.text}</li>)}</ul></section>
    <section><h2>Priorities</h2><ol>{report.priorities.map((note, index) =>
      <li key={`${note.text}:${index}`}>{note.text}</li>)}</ol></section>
    <section className="coaching-exercise"><p className="eyebrow">Next exercise</p>
      <h2>{report.exercise.title}</h2><p>{report.exercise.instructions}</p></section>
    {report.interpretationNotes.length > 0 ? <section><h2>Interpretation notes</h2>
      <ul>{report.interpretationNotes.map((note, index) =>
        <li key={`${note.text}:${index}`}>{note.text}</li>)}</ul></section> : null}
  </div>;
}
