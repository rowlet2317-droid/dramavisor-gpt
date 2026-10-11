export function PositionConfirmation({ candidates, onSelect }: { candidates: Array<{ elementId: string; text: string }>;
  onSelect: (elementId: string) => void }) {
  return <section className="position-confirmation" aria-labelledby="position-heading">
    <h2 id="position-heading">Where are you in the scene?</h2><p>Choose a line; DramaVisor will not guess.</p>
    <ul>{candidates.map((candidate) => <li key={candidate.elementId}><button type="button"
      onClick={() => onSelect(candidate.elementId)}>{candidate.text}</button></li>)}</ul>
  </section>;
}
