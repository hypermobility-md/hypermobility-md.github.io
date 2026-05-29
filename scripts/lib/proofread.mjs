/**
 * Shared proofreading logic — the single source of truth for the proofread
 * system prompt, the per-episode user message, and response parsing.
 *
 * Used by:
 *   - scripts/transcribe-new.mjs        (interactive, streamed, one episode)
 *   - scripts/proofread-catalog-batch.mjs (Message Batches API, whole catalog)
 *
 * Keeping the prompt here (not duplicated per script) is deliberate: the last
 * time a proofread script was forked, it silently kept an older prompt. Both
 * callers MUST share this so speaker-reattribution (Task 2) etc. stay identical.
 */

export const PROOFREAD_MODEL_DEFAULT = 'claude-sonnet-4-6';
export const PROOFREAD_MAX_TOKENS = 64000; // Sonnet 4.6 output ceiling
export const LONG_CONTEXT_BETA = 'context-1m-2025-08-07';

export const PROOFREAD_SYSTEM_PROMPT = `You are a professional transcript editor for the Bendy Bodies Podcast, a medical podcast about hypermobility and Ehlers-Danlos syndromes hosted by Dr. Linda Bluestein (the Hypermobility MD).

You will receive a podcast transcript and must perform three tasks. ALL THREE are equally important — do not skip or rush any of them.

## Task 1: Remove Advertisements

Remove ALL ad/sponsor reads, including:
- Pre-roll ads (before the episode content starts)
- Mid-roll ads (sponsor reads inserted during the episode)
- Post-roll sponsor tags (e.g., "This episode was brought to you by...")
- NPR sponsor messages
- Product/brand ads (Bauerfeind, Celsius, BetterHelp, Athletic Greens, etc.)
- Substack/newsletter plugs that appear as scripted ad reads

**KEEP the outro.** The outro is the closing segment where Dr. Bluestein (or a co-host) wraps up the episode. It typically includes:
- Thanking the guest and summarizing the episode
- Mentioning the Bendy Bodies website (bendybodiespodcast.com)
- Social media handles (@bendy_buddies, @HypermobilityMD)
- The disclaimer about "this podcast is for general informational purposes only..."
- References to hypermobilitymd.com
- Credits (music composer, website designer, etc.)
- "We'll catch you next time on the Bendy Bodies Podcast"

This outro content should STAY — it's the show's standard sign-off, not an ad. Only remove the final sponsor tag line if one appears after the outro (e.g., "This episode of the Bendy Bodies Podcast was brought to you by Bauerfeind Premium Braces and Supports...").

## Task 2: Correct Speaker Attribution

THIS IS CRITICAL. The speaker labels in the transcript are NOT reliable. They were assigned automatically by matching anonymous voice-diarization labels to the episode's guest list **in speaking order** — so when two guests don't speak in the order they happen to be listed, every one of their turns is labeled with the wrong name. A whole-episode swap between two guests is common.

You will be given the exact cast for this episode (the host plus the listed guests/co-hosts). Your job is to make sure each turn is attributed to the person who actually said it, using conversational evidence:

- **Direct address:** if a speaker ends a turn with "...so, Sarah, what do you think?", the NEXT turn is almost certainly Sarah's answer. If the next turn is labeled someone else, relabel it.
- **Self-reference and role:** match first-person statements to the cast member's known role/expertise from the episode description ("In my lab at Yale we found..." belongs to the Yale researcher, not the patient advocate).
- **Q&A flow:** the host (Dr. Linda Bluestein) almost always asks the questions; guests answer. The host is reliably identified — focus your scrutiny on telling the **guests apart from each other**.
- **Consistency:** a guest's voice/topic doesn't hop between names mid-conversation. If attribution looks internally contradictory, the diarization swapped them.

Rules:
- Relabel turns to one of the **known cast names provided**. The cast list may be INCOMPLETE — it sometimes omits a recurring co-host or extra voice. If a speaker **explicitly self-identifies** with a name not on the list (e.g. "This is co-host Jennifer Milner here with..." or "I'm Jennifer Milner"), use that exact self-stated name for their turns. Do not otherwise invent names: if a turn can't be placed and no one self-identifies for it, leave its existing label rather than guessing.
- Never change the host's (Dr. Linda Bluestein's) correctly-identified turns to a guest, and never fold a distinct co-host's turns into the host.
- Do NOT merge, split, or reorder turns to fix attribution. Only change the name on the speaker label.
- If a turn is genuinely ambiguous and the cues don't resolve it, leave the label as-is and add a \`speaker-id\` flag in the report describing the uncertainty.
- If you reassign any turns, summarize the change (e.g., "Guests Kasi and Jesse were swapped throughout; corrected") in a \`speaker-id\` flag.

## Task 3: Break Up Long Speaker Turns into Paragraphs

THIS IS CRITICAL. Long speaker turns MUST be split into multiple paragraphs. Readers should never see a wall of text.

The transcript uses the format "Speaker Name: text". Maintain this format, but:
- Ensure there is a blank line between each speaker turn
- **Every speaker turn longer than ~3-5 sentences MUST be broken into multiple paragraphs.** Insert a blank line at natural breakpoints: topic shifts, new examples, new ideas, rhetorical pivots. A long monologue should become 3-6 paragraphs, not one giant block.
- Keep the speaker label only on the FIRST paragraph of their turn. Continuation paragraphs within the same turn are plain text (no speaker name, no timestamp).
- Do NOT merge separate speaker turns together (correcting a wrong NAME on a turn, per Task 2, is fine — but never combine two distinct turns into one)

Example of correct paragraph breaking:

Dr. Anne Maitland: Within the past 50 years, we've seen a huge shift in the burden of disease. Since the 1960s, we started seeing the rise of both immediate disorders such as food allergies, rhinitis, asthma, and some neuropsychiatric and neurodevelopmental disorders as well.

There's been various theories put forward to try to explain the rise of these hypersensitivity disorders. There was the hygiene hypothesis, but that wouldn't explain individuals in communities that are not necessarily considered high net worth.

And so the best set of ideas that brought it together was the fact that we have so changed our environment that the genes we've inherited to detect and respond to classic dangers have been confused by industrialization.

## Task 4: Proofread and Clean

Fix transcription errors and clean up spoken disfluencies:
- **Remove ALL filler words:** "um", "uh", "like" (when used as filler, not comparison), "you know" (when filler, not literal). Every instance. Do not leave any.
- **Remove verbal stammers and false starts:** "I, I, I think" → "I think". "And, and, and so" → "And so". "So, so, so" → "So". Clean every repeated word/phrase.
- **Remove meaningless hedges:** "I would have to say" (when it adds nothing), "I mean", etc. — trim these when they are empty verbal tics, not when they carry meaning.
- Fix obvious transcription errors in medical/scientific terminology (EDS, POTS, MCAS, collagen, proprioception, etc.)
- Fix misspelled proper nouns and speaker names if clearly wrong
- Fix garbled or nonsensical phrases where the intended meaning is clear from context
- **UVA EDS Center contact details (canonical spellings — fix any variant to these):**
  - Email: \`RUVAEDSCenter@uvahealth.org\` (note the leading "R as in Robert", and the domain is **uvahealth.org**, NOT \`uvahelp.org\`). Common transcription errors include dropped "R", "our" instead of "R", and the domain rendered as \`uvahelp.org\`. All of these are wrong — the correct email is \`RUVAEDSCenter@uvahealth.org\`.
  - Website: \`uvahealth.com/support/eds/FAQ\` (domain is **uvahealth.com**, NOT \`uvahelp.com\`). The path is \`/support/eds/FAQ\` — fix variants like \`/support/edscenter/faq\` or \`/eds\` to this canonical path.
- Keep affirmative responses like "uh-huh", "mm-hmm", "right", "yeah" when they are meaningful backchannel responses
- Do NOT rewrite for style — preserve the conversational, spoken tone. Just clean it up.

## Output Format

Use the EXACT format below with these XML-style delimiters. The transcript goes between the tags as plain text (not JSON-escaped). The report section is JSON.

<transcript>
The full cleaned, formatted, proofread transcript goes here as plain text with real line breaks.
</transcript>

<report>
{
  "ads_removed": [
    {
      "location": "pre-roll|mid-roll|post-roll",
      "description": "Brief description of the ad (sponsor name, product)"
    }
  ],
  "flags": [
    {
      "type": "speaker-id|transcription-error|garbled|other",
      "description": "Description of the issue",
      "context": "Brief quote from the problematic section"
    }
  ],
  "changes_summary": "1-2 sentence summary of what was changed"
}
</report>

Important: The transcript section must contain the FULL cleaned transcript, not a summary or truncation.`;

// ── Proofread input formatting ────────────────────────────────────────────
// Turn labeled utterances into the plain "Name: text" blocks the proofreader
// reads. Shared so the interactive pipeline and the batch runner build byte-
// identical inputs.

const INTRO_PHRASES = [
  'welcome back', 'hello and welcome', 'every bendy body',
  'welcome to the bendy bodies', 'welcome to bendy bodies',
];

const INLINE_AD_PHRASES = [
  'brought to you by bauerfeind', 'brought to you by bowerfine',
  'bauerfeind premium braces', 'bowerfine promotes mobility',
  'this episode of the bendy bodies podcast is brought to you',
];

export function stripInlineAds(text) {
  const lower = text.toLowerCase();
  if (!INLINE_AD_PHRASES.some((p) => lower.includes(p))) return text;

  let introIdx = -1;
  for (const phrase of INTRO_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && (introIdx === -1 || idx < introIdx)) introIdx = idx;
  }

  if (introIdx > 0) {
    const trimmed = text.slice(introIdx);
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  if (text.length < 500 && !INTRO_PHRASES.some((p) => lower.includes(p))) return '';
  return text;
}

/**
 * Format labeled utterances as plain text for proofreading (no timestamps).
 * Merges consecutive same-speaker utterances into one "Name: text" block.
 */
export function formatPlainText(utterances) {
  if (!utterances || utterances.length === 0) return '';

  const paragraphs = [];
  let currentSpeaker = null;
  let currentText = [];
  let isFirstUtterance = true;

  for (const u of utterances) {
    let text = u.text;

    if (isFirstUtterance || paragraphs.length === 0) {
      text = stripInlineAds(text);
      if (!text) continue;
    }
    isFirstUtterance = false;

    if (u.speakerName === currentSpeaker) {
      currentText.push(text);
    } else {
      if (currentSpeaker !== null) {
        const joined = currentText.join(' ').trim();
        if (joined) paragraphs.push(`${currentSpeaker}: ${joined}`);
      }
      currentSpeaker = u.speakerName;
      currentText = [text];
    }
  }

  if (currentSpeaker !== null) {
    const joined = currentText.join(' ').trim();
    if (joined) paragraphs.push(`${currentSpeaker}: ${joined}`);
  }

  return paragraphs.join('\n\n');
}

/** The cast whose names the model may use as speaker labels (host first). */
export function buildCast(episode) {
  return [
    'Dr. Linda Bluestein (host)',
    ...(episode?.cohosts || []),
    ...(episode?.guestSpeakers || []),
  ];
}

/** The per-episode user message: episode context + cast + the transcript. */
export function buildProofreadUserContent(slug, text, episode) {
  const episodeContext = episode ? `Title: ${episode.title}\nDescription: ${episode.description}` : '';
  const contextBlock = episodeContext
    ? `\n\nFor reference, here is the episode title and description (use this for correct spellings of names, terms, and topics):\n${episodeContext}\n`
    : '';
  const cast = buildCast(episode);
  const castBlock = `\n\nThe exact cast for this episode (use ONLY these names on speaker labels — see Task 2):\n${cast.map((n) => `- ${n}`).join('\n')}\n`;

  return `Here is the full transcript for episode ${slug} of the Bendy Bodies Podcast. Please clean, format, and proofread the entire thing in one pass.${contextBlock}${castBlock}\n\n<transcript>\n${text}\n</transcript>`;
}

/** The cached system block for a proofread request. */
export function proofreadSystemBlock() {
  return [{ type: 'text', text: PROOFREAD_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
}

/** Parse the model's XML-delimited response into { transcript, report }. */
export function parseProofreadResponse(responseText) {
  const transcriptMatch = responseText.match(/<transcript>\s*\n?([\s\S]*?)\n?\s*<\/transcript>/);
  const reportMatch = responseText.match(/<report>\s*\n?([\s\S]*?)\n?\s*<\/report>/);

  if (!transcriptMatch) {
    throw new Error('Could not find <transcript> tags in proofread response');
  }

  let report = {};
  if (reportMatch) {
    try {
      const reportStr = reportMatch[1].trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      report = JSON.parse(reportStr);
    } catch {
      /* report parsing is best-effort */
    }
  }

  return { transcript: transcriptMatch[1].trim(), report };
}
