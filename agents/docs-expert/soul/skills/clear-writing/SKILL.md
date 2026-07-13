---
name: clear-writing
description: >-
  Style rules for writing clear, human-readable documentation and prose.
  Use before writing or editing any doc, README, guide, or long-form text.
  Covers sentence length, plain words, punctuation discipline (avoid colons
  and semicolons), paragraph size, and when to use sections, bullets, tables,
  and bold. Triggers: "write docs", "improve this doc", "make this readable",
  "review this text", "documentation style".
---

# Clear writing

Write for a tired reader. Every rule here serves one goal. The reader gets
the point on the first pass.

Sources this distills: plainlanguage.gov guidelines, the Google developer
documentation style guide, and Diátaxis. When in doubt, their common ground
is the rule.

## Sentences

- **Keep sentences short.** Aim under 20 words. One idea per sentence. If a
  sentence has two ideas, make two sentences.
- **Prefer subject-verb-object.** Put the actor first. "The hook creates the
  files" beats "the files are created by the hook".
- **Use active voice.** Passive voice hides who does what. Allowed only when
  the actor truly does not matter.
- **Use present tense.** "The kernel runs hooks", not "the kernel will run
  hooks".
- **Read it aloud.** Where you stumble or take a breath mid-sentence, split
  or rewrite. Sentences should flow into each other. Vary length a little so
  the text does not sound robotic.

## Punctuation discipline

- **Avoid colons inside sentences.** A colon usually welds two sentences
  together. Split them instead. Colons are fine before lists and code blocks.
- **Avoid semicolons entirely.** A semicolon is always two sentences in a
  trench coat. Use a period.
- **Avoid dash asides where possible.** If the aside matters, give it its own
  sentence. If it does not matter, cut it.
- Exclamation marks almost never. Question marks only in FAQs.

## Words

- **Prefer the plain word.** Use, not utilize. Start, not initiate. Also,
  not additionally. Before, not prior to.
- **Cut filler.** "In order to" is "to". "It should be noted that" is
  nothing. "Very" is usually nothing.
- **Define jargon on first use, or link to where it is defined.** Never
  assume the reader shares your context. Expand acronyms once per doc.
- **Say "you".** Address the reader directly. Avoid "the user" when you mean
  the person reading.
- Contractions are fine. They sound human.

## Paragraphs and structure

- **Keep paragraphs short.** Three to five sentences. One topic per
  paragraph. A wall of text loses the reader before the content can.
- **Front-load the point.** First sentence of a paragraph carries its
  message. First paragraph of a section carries the section.
- **Use sections with descriptive headings.** A reader scanning only the
  headings should grasp the shape of the doc. Prefer sentence case.
- **Use bullets for parallel items** — options, rules, steps that do not
  depend on each other. Use numbered lists only for ordered steps. Keep list
  items grammatically parallel.
- **Use tables when the reader will compare.** Three or more items with the
  same two or three attributes each want a table, not prose.
- **Bold the terms that anchor scanning.** The first use of a key concept,
  the rule inside a paragraph. Never bold whole sentences. If everything is
  bold, nothing is.

## Honesty in docs

- Write only what you verified. Run the command. Resolve the config. Check
  the path.
- If behavior is planned but not built, label it clearly as planned.
- Dates and version markers beat "currently" and "new". "New" rots.

## Quick self-check before submitting

1. Any sentence over ~25 words? Split it.
2. Any semicolon? Remove it.
3. Any colon mid-sentence? Split or restructure.
4. Any paragraph over 5 sentences? Break it.
5. Do headings alone tell the story? If not, retitle.
6. Did you verify every command, path, and claim? If not, verify or flag.
