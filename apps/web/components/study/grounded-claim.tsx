import type { PlayModel } from "@drama/domain/play-model";
import type { GroundedClaim as GroundedClaimValue } from "@drama/domain/study";

type Props = { claim: GroundedClaimValue; play?: PlayModel };

export function GroundedClaim({ claim, play }: Props) {
  const references = claim.reference && play ? locateReferences(play, claim.reference.elementIds) : [];
  return (
    <article className={`grounded-claim grounded-claim--${claim.epistemicStatus}`}>
      <div className="claim-label">{claim.epistemicStatus === "explicit" ? "Script evidence" : "Interpretation"}</div>
      <p>{claim.text}</p>
      {references.length > 0 ? <ul className="reference-list">{references.map(({ act, scene, element }) => (
        <li key={element.id}>
          <a className="reference-chip" href={`/plays/${claim.reference!.playId}/scenes/${scene.id}#${element.id}`}>
            Act {act.ordinal} · Scene {scene.ordinal} · {element.id}
            {element.sourcePage ? ` · Page ${element.sourcePage}` : ""}
          </a>
        </li>
      ))}</ul> : null}
    </article>
  );
}

function locateReferences(play: PlayModel, elementIds: string[]) {
  return play.acts.flatMap((act) => act.scenes.flatMap((scene) => scene.elements
    .filter((element) => elementIds.includes(element.id))
    .map((element) => ({ act, scene, element }))));
}
