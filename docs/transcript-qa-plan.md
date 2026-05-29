# Transcript QA Plan — speaker-attribution review after the back-catalogue re-proof

**Why this exists.** The whole back catalogue was re-proofread in commit
`ef0cf7d` (branch `transcripts/reproof-and-reattribute`). As part of that, the
proofread step (Task 2 in `scripts/lib/proofread.mjs`) re-derived speaker
attribution from conversational cues on **~120 episodes**, replacing the old
positional diarization mapping. That mapping was wrong far more often than not,
so this is a big net improvement — but the LLM re-derivation is probabilistic
and **flipped at least one previously-correct episode** (093, caught and fixed:
the two PT authors were swapped and the text was even rewritten to stay
internally consistent). The automated detector only catches 2-guest
address-cue mismatches, so **silent flips on harder multi-speaker episodes are
the main residual risk.** This plan is the focused pass to find and fix them.

## Baseline for comparison
The pre-re-proof transcripts (which include the earlier *manual* speaker
corrections) are the parent of the re-proof commit: **`ef0cf7d^`**. Use it as
ground truth for attribution where it was verified.

## Tools already in the repo
- `node scripts/audit-speaker-swaps.mjs` — heuristic swap detector (read-only).
- `node scripts/proofread-catalog-batch.mjs reformat --only NNN` — re-apply
  formatting/timestamps to one episode from cached proofread (no API, no
  re-attribution). Use to format a baseline-restored episode.
- `node scripts/transcribe-new.mjs --episode NNN --force` — full single-episode
  re-proof (re-attribution may differ each run; not deterministic).
- `scripts/output/speaker-corrections/*.json` — the prior *manual* QA ground
  truth (19 episodes: swaps, merges, diarization failures, verified-correct).

## Procedure

1. **Re-run the detector** and triage every flag.
   - As of the re-proof, flagged: 141 (1/13), 28 (1/3), 5 (1/1) — all weak,
     reviewed as benign cross-talk. Re-check and confirm.

2. **Diff attribution vs the baseline for every reattributed episode.**
   For each episode whose proofread report has a `speaker-id` flag
   (`scripts/output/proofread/reports/NNN.json`), compare speaker labels:
   `git show ef0cf7d^:src/episodes/NNN.md` vs `src/episodes/NNN.md`.
   A flip shows up as the same self-intro / answer-to-direct-address landing on
   a different name. Prioritise:
   - **Multi-guest episodes** (≥2 non-host speakers) — highest flip risk.
   - **The manual-correction set**: 028, 059, 069, 085, 093, 094, 141 (swaps);
     033, 053, 068 (merges); 044, 051 (diarization). 059/085/094 were excluded
     from the batch (kept verified); 093 already fixed. Spot-check 028/069/141
     once more; they looked preserved by label distribution.

3. **Confirm suspected flips** with the episode description (roles/affiliations
   reveal who says what) or the audio. Don't "fix" benign cross-talk.

4. **Fix a confirmed flip** by restoring the baseline attribution and
   re-formatting (preserves correctness, avoids another LLM re-derivation):
   ```
   git show ef0cf7d^:src/episodes/NNN.md > /tmp/NNN.base.md
   # then matter.stringify(reformatExisting(baseBody), currentFrontmatter)
   ```
   (See how 093 was fixed in the session that produced this plan.)

## Known residual issues (not fully fixable by re-proof)
- **Genuine diarization merges** (two similar voices in one cluster) can't be
  un-merged from cached transcripts — they need a fresh AssemblyAI run with the
  correct `speakers_expected`, and even then similar voices may re-merge.
  Candidates flagged by the prior audit: **033** (residual), **068** (one merged
  guest line). Re-transcribe + review if these matter.
- **093** was restored from the pre-filler-removal baseline, so it still
  contains "um/uh" fillers. Optionally re-clean just 093.

## Also worth a quick look
- Render 3–4 episodes in the browser (`npm start`) to confirm bold names,
  same-speaker grouping, and `[mm:ss]` timestamps display correctly.
- Sanity-check the new tag sets on a handful of episodes.

## Results of the 2026-05-29 QA pass

**Method.** Re-ran the detector (unchanged: 141 1/13, 28 1/3, 5 1/1 — all
benign cross-talk, confirmed). Diffed all 136 `speaker-id`-flagged episodes
against `ef0cf7d^`, focusing on the 51 multi-guest ones. Word-share is a weak
proxy, so the decisive test was whether self-intro / direct-address cues land
on the right person (cross-checked against `speaker-corrections/*.json`).

**Manual-correction set is intact.** Every verified swap (028, 059, 069, 093,
094, 141) and every verified-correct episode (077, 087, 096, 108, 122, 130,
182) still lands its address cues on the correct speaker. No 2-guest flips
found.

**New failure mode found & fixed — unlisted co-host/producer merged into the
host.** The re-proof's cast list comes from each episode's `guests:`
frontmatter, which omits co-host Jennifer Milner and the Office Hours
producers (Tessa, Shanti). Where those speakers weren't in the cast list,
their turns were folded into Dr. Linda Bluestein. Fixed via the 093 pattern
(restore baseline body → `reformatExisting` → current frontmatter):
  - **058** — Linda is the *interviewee*; Jennifer Milner interviews. Raw was
    one block; baseline had the clean two-voice split. Restored.
  - **170, 174, 177** — Office Hours; producers Tessa/Shanti read listener
    questions. Restored. (177 was merged **silently** — no `speaker-id` flag.)

**Same root cause, NOT safe to baseline-restore (report only).** On these the
re-proof *also fixed* significant guest/host scrambles, so restoring baseline
would trade a few co-host turns for large guest-attribution errors. The clean
fix is a targeted re-proof with Jennifer Milner added to the cast (a `cohosts`
field), not a baseline restore:
  - **010** (guest Bonnie Robson) — baseline had Linda/Bonnie swapped mid-show.
  - **062** (guest Rudrani Banik) — baseline guest/host "significantly scrambled".
  - **013** (guest Ilene Ruhoy), **027** (guest Jeanice Mitchell) — Jennifer is
    a few brief interjections; baseline intro was mislabeled (027 named the
    guest as the intro speaker). Current is better overall; low impact.

**Residuals (unchanged, not fixable by re-proof).**
- Diarization merges **033**, **068** — need a fresh AssemblyAI run.
- Diarization single-block failures **044**, **051** — both baseline and
  current are guesses; need re-transcription.
- **085** (6-speaker triple-crossover) — Jill Brook's host-intro lines
  ("Hello, fellow Triad patients", "Our guests today are…") are misattributed
  to Dr. Leonard Weinstock in **both** baseline and current, so it's a
  pre-existing diarization error, not a re-proof regression. Worth a targeted
  manual fix (reassign those two intro turns to Jill Brook) but out of scope
  for the baseline-restore pattern.
- **058 / 170 / 174 / 177** (this pass) and **093** were restored from
  pre-filler-removal baselines, so they reintroduce "um/uh" fillers.
  Optionally re-clean.
