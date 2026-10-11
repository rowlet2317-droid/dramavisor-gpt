# Drama Practice App User Manual

> Updated for the merged Plan 3 private beta. The app supports script study, private voice coaching, guided exercises, and real-time scene rehearsal for English stage plays.

## What you can do in this version

An invited actor can import an English stage play, correct the parsed structure, study the play and characters, build a role workbook, inspect source evidence, ask a contextual script tutor, record a complete take for private coaching, work through guided voice exercises, and rehearse with browser-based AI scene partners.

The app provides coaching prompts and evidence-linked ratings, not a validated global assessment of acting ability. External-provider measurements and the planned ten-actor usefulness study are still pending.

## 1. Accept an invitation

Open the invitation link, enter a password of at least 12 characters under `Choose a password`, and select `Create account`. Successful acceptance creates your account, signs you in, and takes you to the home page; then select **Open your plays** to reach your private play library.

## 2. Sign in

For later visits, open `/sign-in` and use the same email address and password. A signed-in session lasts 30 days.

## 3. Add an English stage play

From the play library, select `Add a play`. Either paste the script or upload a private PDF, DOCX, or UTF-8 TXT file, up to 25 MiB. The app derives the play title from the uploaded filename or the first non-empty line of pasted text. The beta accepts English stage plays only. TXT, text-based PDF, and DOCX files do not require OCR; scanned PDFs require the configured English OCR service.

Keep the worker running while the play is processed. When prompted, select `Review parser issues`. If the page says `The structural review is not ready yet`, wait briefly and refresh.

## 4. Review the parsed script

Resolve issues against your private source:

| Issue | Actor action |
| --- | --- |
| Scene boundary | Choose one proposed split, enter the new scene title, and select `Save selected boundary`. The page reloads before another split. |
| Unreadable text | Correct the passage against the private source. |
| Dialogue owner | Choose the character who speaks the line. |
| Character name | Choose the character and enter the corrected name. |

Scene boundaries are resolved one at a time because each save updates the scene structure and its stable IDs. After the boundaries are clear, resolve the remaining fields and select `Approve corrected play`. Do not close the browser while a save is actively in progress.

## 5. Study the play and role

Open `Overview` for the generated overview, themes, dramatic structure, and relationship summary. Open `Characters` for cast, aliases, scene counts, and grounded character analysis. Open `My Role`, choose your character, and select `Build or refresh workbook` for given circumstances, objectives, obstacles, stakes, tactics, beats, subtext options, and referenced stage directions.

Under `Scenes`, select a scene to read its study beside the original passage, speaker labels, stable IDs, and source pages where available. Evidence chips open the referenced original passage. Within a scene, select `Ask about this passage`, enter a question under `Script tutor`, and select `Ask`.

If the answer is `The script does not establish this`, the selected script evidence is insufficient to support an answer. It does not mean your question is invalid.

## 6. Record a complete voice take and review coaching

Open a scene’s `Practice` page. Choose your `Role`, optionally add an `Interpretation or director concept`, and decide whether to keep the recording for progress comparison or delete it after analysis. Select the control to start recording and allow microphone access only when prompted. Your performance is not interrupted while you record.

Select Stop and upload when finished. The recording is uploaded privately and queued for coaching; select the coaching-progress link to follow it. The app first preserves the transcript and vocal measurements, then prepares evidence-linked coaching. If the external coaching synthesis is temporarily unavailable, the page identifies that limitation and lets you retry it rather than silently presenting a fabricated report.

When available, review the coaching priorities, ratings, source evidence, and audio passages. A retained take can be compared with another retained take; choosing deletion-after-analysis prevents it from being kept for that progress comparison.

## 7. Run a guided exercise

From the same `Practice` page, select `Open guided exercise`. Choose a role and one of the available exercises: `Repeat a line`, `Change tactic`, `Pause and intend`, or `Alternative interpretation`.

The exercise does not activate the microphone automatically. Start the prompt, record the attempt, and review the single coaching note. Select `Continue`, `Retry`, or `Finish` to control the next step.

## 8. Rehearse a scene with AI partners

From `Practice`, select `Open interactive rehearsal`. Choose your role before starting. The app assigns stable voice labels to the other roles for the session so partners remain identifiable. Select `Start rehearsal` and approve microphone access when prompted.

Use the rehearsal controls deliberately:

| Control | What it does |
| --- | --- |
| `Pause` | Pauses the session without treating it as an interruption. |
| `Resume` | Continues a paused session and requests fresh short-lived credentials if necessary. |
| `Cue` | Repeats or advances the current rehearsal cue when the session is ready. |
| `Restart beat` | Restarts the current beat from its defined boundary. |
| `Continue` / `Restart line` | Available after the app detects an actor speech interruption; choose how to proceed. |
| `Stop rehearsal` | Ends the realtime session and releases the microphone. |

You can select `Record for coaching` before starting if you want your actor track queued as a private coaching take after stopping. The checkbox is optional; it does not record by default. After a recorded rehearsal stops, select `Open queued coaching take` to review the same coaching workflow described above.

The app can maintain up to four concurrent AI role output sessions. For additional roles, or when a realtime recovery needs an explicit fallback, it uses clearly labeled scripted voices rather than silently changing the scene partner. If the page exposes a recovery option, choose retry when the connection is ready or use the displayed fallback and advance manually as instructed.

## Evidence, privacy, and interpretation

`Script evidence` means a claim points to a stable script element. Evidence chips show the act, scene, stable ID, and source page when available, and open the original passage. `Interpretation` means a rehearsal possibility rather than a fact established by the script.

Plays, source passages, takes, coaching records, and rehearsal records are scoped to the owning account. Uploads use private object storage. Only start recording or rehearsal when you intend to grant microphone permission, and use `Stop rehearsal` before closing the tab whenever possible.

## Common questions

**Why is a section marked unavailable?** Background study or coaching generation may still be running or may have reached a processing limitation.

**Why does a new play require review?** Every parsed Play Model needs actor approval. Resolve blocking structural issues first, then select `Approve corrected play`.

**Can another beta user see this play or take?** No. Play, study, take, coaching, and rehearsal routes are scoped to the owner.

**Can I add a non-English script?** No. The current beta accepts English only.

**Why does rehearsal need a microphone?** The actor-input realtime session starts only after you select `Start rehearsal` or `Resume`; the microphone is released when the session stops or the page unmounts.

## Current limitations

The beta is English-only and voice-only. It does not provide camera analysis, cast voice cloning, a mobile-native app, or a validated performance score. Realtime and coaching depend on configured providers; external-provider measurements and the ten-actor usefulness study remain pending.
