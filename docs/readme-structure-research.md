# README structure research

How to structure a technical GitHub README for a published TypeScript library, per primary sources.
Researched 2026-07-10 for the future `viem-tx-sim` README. Sources listed at the end; every claim is cited inline.

## Who says what (source map)

| Source | Authority | Core position |
|---|---|---|
| [GitHub docs: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) | Platform owner | READMEs should say: what the project does, why it's useful, how to get started, where to get help, who maintains it |
| [GitHub docs: community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories) | Platform owner | README is one of five health files (README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY) — the others live *outside* the README |
| [Standard Readme spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md) | Community spec (Richard Littauer) | Formal required section order: Title → short description → ToC → Install → Usage → Contributing → License |
| [Make a README](https://www.makeareadme.com/) | **Personal site by Danny Guo** — widely cited but one person's guidance, not an institutional spec | Similar order, adds Badges/Visuals/Support/Roadmap/Project Status; "a README is crucial but basic" — bigger projects move docs out |
| [Readme Driven Development](https://tom.preston-werner.com/2010/08/23/readme-driven-development.html) (Tom Preston-Werner, 2010) | Origin essay | The README defines the public API and project scope; "the single most important document in your codebase" |
| [Diátaxis](https://diataxis.fr/) (Daniele Procida, per [source repo](https://github.com/evildmp/diataxis-documentation-framework)) | Documentation-theory framework | Four doc types — tutorials (learning), how-to guides (tasks), reference (information), explanation (understanding) — and "crossing or blurring the boundaries … is at the heart of a vast number of problems in documentation" |

## Recommended structure

### Above the fold (first screen — the three-question test)

A reader landing cold must be able to answer *what is it*, *is it for me*, and *how do I start* without scrolling far. GitHub's own five questions ([About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)) front-load the first three. All three exemplar libraries (below) follow this empirically.

1. **Title** — must match the npm package name ([Standard Readme: Title](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)). No cleverness; searchability wins.
2. **One-line description** — no heading, ≤120 characters, and it **must match the npm/GitHub description fields** so package page, repo page, and README all say the same thing ([Standard Readme: Short Description](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)). Say what it does, not what it is built with. Exemplar taglines: viem "TypeScript Interface for Ethereum"; zod "TypeScript-first schema validation with static type inference".
3. **Badges** (optional, one row, no heading) — CI, npm version, license ([Standard Readme: Badges](https://github.com/RichardLitt/standard-readme/blob/master/spec.md); [Make a README](https://www.makeareadme.com/)). Keep to ~5; badges are metadata, not content.
4. **2–4 sentence long description** — the "why is this useful / what's the trick" paragraph. Preston-Werner: this is where you state scope and the idea, before any code ([RDD](https://tom.preston-werner.com/2010/08/23/readme-driven-development.html)). For viem-tx-sim this is where the ghost-contract/`msg.sender` trick belongs — it is the differentiator.
5. **Install** — one code block, one command ([Standard Readme: Install, required](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)). Peer-dependency and runtime constraints (e.g. "viem is a peer dependency", "ESM only", "Node 20+") go here, not buried later — this is the first constraints surface.
6. **Minimal usage example** — one copy-pasteable code block showing the happy path end to end, with expected output ([Standard Readme: Usage](https://github.com/RichardLitt/standard-readme/blob/master/spec.md); Make a README: "use examples liberally, and show the expected output if you can"). This is Diátaxis's *how-to* slice — task-oriented, minimal explanation inline.

**Constraints and caveats surface early, not in a dumping-ground section at the bottom.** Standard Readme's mechanism for this is the optional **Security** section placed immediately after Usage-relevant material ([spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)); GitHub's mechanism is a SECURITY.md health file ([community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)). Practical rule: a caveat that changes whether someone should adopt the library (RPC provider must support state overrides; preview ≠ guarantee; pre-1.0 semver policy) belongs above or immediately after the first usage example. A caveat that only matters once you're already a user (edge-case token layouts) can live in linked docs.

### Below the fold

7. **How it works / Background** — a short *explanation* section (Diátaxis: understanding-oriented): the mechanism, the design decision that makes it different, motivation. Standard Readme calls this **Background**: "motivation, abstract dependencies, intellectual provenance" ([spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)). Keep it to a few paragraphs; the full story links out (for this repo: `docs/motivation.md`).
8. **API** — either a compact reference (exported functions, signatures, return types — [Standard Readme: API](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)) or a single link to a generated/hosted reference. Rule of thumb from the exemplars: inline it while the API fits on ~2 screens (zod-style), link out once it doesn't (viem-style).
9. **Extra sections** — Standard Readme explicitly slots custom sections *between Usage and API* ([spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)). For a library like this: "Token overrides", "Requirements estimation", benchmarks, comparison tables.
10. **Contributing** — required by Standard Readme, but its content rule is mostly *pointers*: where to ask questions, whether PRs are accepted, link to CONTRIBUTING.md ([spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)). GitHub's community-profile checklist expects CONTRIBUTING as a separate file anyway ([community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)); Make a README agrees ("extract contributing guidelines into separate CONTRIBUTING.md files").
11. **License** — required, **must be the last section**, name the license and owner, link the LICENSE file ([Standard Readme: License](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)).

### Sections to skip (and why)

- **Hand-written Table of Contents** — Standard Readme requires one for READMEs over 100 lines ([spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)), but GitHub now auto-generates a ToC from headings via the "Outline" menu on every rendered Markdown file ([About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)). The spec predates that feature. None of the three exemplars carries a hand-written ToC. Verdict: skip it; keep headings clean so the auto-outline works.
- **Roadmap / Project Status** — Make a README suggests them ([makeareadme.com](https://www.makeareadme.com/)); no other source does, and they rot. A pre-1.0 stability note in the description or a one-liner near Install covers the real need.
- **Tutorials** — Diátaxis: tutorials are learning-oriented and long-form; stuffing them into a README blurs types ("writers … overload their tutorials with distracting and unhelpful explanation" — [diataxis.fr/start-here](https://diataxis.fr/start-here/)). Link them out.

## How deeper docs hang off the README (Diátaxis mapping)

The README is the *front door*, not the documentation. Map each Diátaxis quadrant ([diataxis.fr](https://diataxis.fr/)) to a location:

| Diátaxis type | In the README | Linked out |
|---|---|---|
| How-to (task) | The quick-start example; one or two focused recipes | Recipe/how-to pages for secondary workflows |
| Reference (information) | Export list or compact API table at most | Full API reference (typedoc / docs site) |
| Explanation (understanding) | 2–4 paragraph "How it works" | Design docs — for this repo, `docs/motivation.md`, architecture notes, invariants (already partly in CLAUDE.md; the human-facing version belongs in `docs/`) |
| Tutorial (learning) | Nothing | Guides/walkthroughs, if ever needed |

Design decisions and constraints get one honest paragraph each in the README (enough to make an adoption decision) plus a link to the full write-up in `docs/`. This keeps the README a *map with samples* rather than the territory — consistent with Diátaxis's warning against blurred types and with Make a README's "a README is crucial but basic" escalation advice ([makeareadme.com](https://www.makeareadme.com/)).

GitHub-specific placement notes: README is recognized in `.github/`, root, or `docs/` (precedence in that order); rendered content truncates past 500 KiB; section headings get anchor links automatically ([About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)).

## What the exemplars actually do (fetched 2026-07-10)

**viem** ([src/README.md](https://github.com/wevm/viem/blob/main/src/README.md) — root README is a symlink):
logo → tagline "TypeScript Interface for Ethereum" → 5 badges → **Features** (~10 bullets) → **Overview** (one complete runnable code example) → **Documentation** (single link to viem.sh) → Community/Support/Sponsors/Contributing/Authors/License. **No install command in the README at all** — everything operational lives on the docs site. This is the "docs-site-first" pattern: README is a brochure.

**zod** ([packages/zod/README.md](https://github.com/colinhacks/zod/blob/main/packages/zod/README.md)):
logo → heading → tagline "TypeScript-first schema validation with static type inference" → badges → nav links (Docs/Discord/X) → **What is Zod?** (intro + inline code) → **Features** (bullets: zero deps, 2kb, etc.) → **Installation** (one command) → **Basic usage** (substantial inline: parsing, error handling, type inference), with sparing links to zod.dev/api. This is the "README-is-the-docs-entry" pattern: real usage inline, deep reference linked.

**fastify** ([README.md](https://github.com/fastify/fastify/blob/main/README.md)):
logo → badges → value-proposition tagline → **Quick Start** (~150 words) → **Install** (one command) → **Example** (two code samples) → **Core Features** (5 bullets, with numbers: "76+ thousand requests per second") → **Benchmarks** (comparison table) → **Documentation** (24 links out) → Ecosystem/Support/Contributing/Team/License. Middle pattern: operational quick start inline, everything deep linked.

Empirical takeaways: all three put tagline + differentiator bullets + one code block on the first screen; none has a hand-written ToC; all end with License; badge rows are universal; the amount of inline usage scales *inversely* with how good the external docs site is.

## Disagreements between sources

- **Install section**: Standard Readme *requires* it; viem omits it entirely in favor of its docs site. For a library without a docs site (viem-tx-sim today), follow the spec — inline Install/Usage.
- **Table of Contents**: Standard Readme requires it >100 lines; GitHub's auto-generated Outline makes it redundant, and no exemplar has one. Spec loses to platform reality here.
- **How much usage inline**: zod inlines a lot; viem inlines almost nothing; Diátaxis would push everything beyond the how-to slice out. Resolution: inline exactly one happy-path example per major capability, link the rest.
- **Roadmap/Status sections**: only Make a README (a personal site, worth remembering when weighing it against GitHub's docs or a community spec) recommends them.
- **Where "why" goes**: Preston-Werner puts the idea/scope front and center (README written *before* the code); Standard Readme demotes Background to optional. For a library whose whole value is one non-obvious trick, side with Preston-Werner: the mechanism sentence goes in the opening paragraph.

## Concrete order for viem-tx-sim

1. `# viem-tx-sim` + one-liner (≤120 chars, mirrored to package.json/GitHub description): what it previews and for whom.
2. Badges (npm, CI, license).
3. 3-sentence pitch including the ghost-contract/`msg.sender` trick and "RPC-only, viem is the only dependency".
4. Constraints callout: RPC must support `eth_call` state overrides (+ `eth_createAccessList` for discovery helpers); simulation ≠ guarantee; pre-1.0 minor versions may break.
5. Install (`pnpm add viem-tx-sim`, peer dep note, Node/ESM note).
6. Quick start: one `simulate()` + `balanceQueries.forUser()` example with printed balance deltas.
7. How it works (short; link `docs/motivation.md`).
8. Feature sections: token overrides, requirements estimation — one example each.
9. API surface list (exports from `src/index.ts`) or link when a reference exists.
10. Contributing (pointer) → License (last).

## Sources

- GitHub Docs — About READMEs: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes
- GitHub Docs — About community profiles for public repositories: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
- Standard Readme spec (Richard Littauer): https://github.com/RichardLitt/standard-readme/blob/master/spec.md
- Make a README (Danny Guo, personal site): https://www.makeareadme.com/
- Tom Preston-Werner — Readme Driven Development (2010): https://tom.preston-werner.com/2010/08/23/readme-driven-development.html
- Diátaxis (Daniele Procida): https://diataxis.fr/ and https://diataxis.fr/start-here/ ; authorship: https://github.com/evildmp/diataxis-documentation-framework
- viem README: https://github.com/wevm/viem/blob/main/src/README.md
- zod README: https://github.com/colinhacks/zod/blob/main/packages/zod/README.md
- fastify README: https://github.com/fastify/fastify/blob/main/README.md
