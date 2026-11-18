# ADR 0038: A small router decides which source answers each chat question

- Status: Proposed (2026-11-18). Owner requirement taken in chat. Not reviewed. Builds on ADR 0031 (chat v1), ADR 0034 and ADR 0036 (insurer tier), ADR 0037 (FSS handoff). FOR LEGAL REVIEW: every source label and every fixed sentence below.

**Context.** A 60-question stress test on prod (v39) shows where chat fails. The model answers well when it is called (22 answers checked against the PDF were accurate), but it is called too rarely:
1. Intent and topic are fixed keyword rules (`chat-intent.js`). Typos, Hinglish and Hindi script ("premimum kitna dena hai", "room rent ki limit") match nothing and get a 0.4 s "not found".
2. Scenario questions (cataract next month, five days of room at 8,000 a day) fail because procedure planning needs facts that are not facts (room rent "At Actuals" is text).
3. Claims how-to, network and exclusion questions need the insurer wording, which is empty for the holding.
4. Questions about the holding itself (which insurer and plan, policy number) go to generic help or fail, though the holding knows the answer.
5. Questions about the conversation ("what did I ask earlier") ignore the turn history.
6. Off-topic or injection text is answered "not in your documents".
7. Three parallel threads of one household took 76 to 261 s; the same questions alone took 5 to 14 s. `CHAT_GATEWAY_LIMITS.maxConcurrentCalls` is 2 per process, so calls queue behind each other and each waits up to its own 30 s timeout.

**Decision.**
1. **A router step runs first.** Input: the question, the last few turns (ids and text of this thread only), and a **memory summary** built by code: the fact keys of the holding with their status only (`user_confirmed`, `reviewed_reference`, `extracted_unverified`, `conflicting`, `unknown`), no values; `wordingState`; the kinds of documents attached; whether FSS data exists for the confirmed product. No name, number, quote or value goes in. It passes the household privacy gate and needs the same chat consent as an answer turn.
2. **Output is a closed schema, validated by code.** `{ canonical_question, topics: [{ text, source }] }`, at most three topics, `source` one of: `memory_fact` (own schedule facts), `own_clauses` (passages of the person's own PDF), `insurer_terms` (FSS facts of the confirmed product, ADR 0037), `holding_record` (insurer and plan names the person confirmed, policy period, and other fields the holding record already holds), `planner` (arithmetic by code, procedure planning), `history` (the thread's earlier turns), `out_of_scope`. Anything else, a bad shape or a model failure falls back to today's keyword path unchanged. `canonical_question` is plain English (typos fixed, Hindi and Hinglish translated); it is used for retrieval and is never shown as the person's words.
3. **Code calls only the allowed source.** The router names a source; code checks that the source is possible (a fact key exists, wording is attached, FSS data exists) and calls it. The model never receives a source it was not routed to, and never decides a fact, an eligibility, a money amount or a consent outcome. A routed source that has nothing returns a typed "none", and the code tries the next allowed source in this fixed order: `memory_fact`, `own_clauses`, `insurer_terms`, then the not-found sentence. This is the fallback chain the owner asked for.
4. **Every answer block carries its source label** from a fixed table, chosen by code from the source actually used: "from your policy schedule" (memory facts, own PDF), "from your policy wording" (own clauses), "from the insurer's published terms" (FSS, with ADR 0036's "not checked" wording for unchecked facts), "from the plan you confirmed" (holding record), "worked out by us from your details, an estimate" (planner), "from this conversation" (history). An insurer fact is never presented as the person's own cover.
5. **Scope line.** `out_of_scope` and injection-looking text get a fixed short sentence: what this chat can answer and what it cannot; no "not in your documents".
6. **Cost control.** The router uses the cheapest model of the chat provider list, a small output cap (about 150 tokens), no history beyond 3 turns, and runs only when the deterministic classifier is unsure: no fact key matched, or the message is not plain English, or it has more than one topic. A clear single-topic English question keeps the current free path. A per-household daily budget stays shared with answer turns.
7. **Concurrency.** The chat gateway limit becomes a setting (`CHAT_MAX_CONCURRENT_CALLS`, default 4, hard cap 8) and a queued call that cannot start within 5 s answers with a typed "busy, try again" instead of waiting out its 30 s timeout. The per-process counter is documented as per machine.
8. **Holding questions.** Insurer name, product name, policy period and sum insured are answered from `holding_record` with no model call at all (names are the ones the person confirmed; the UIN never leaves the server).
9. **Erasure.** The router stores nothing beyond the existing turn trace (topics and sources as codes). Revocation and holding deletion erase it with the thread, as now.

**Consequences.** More questions reach the model and the right source, and every answer says where it came from. The cost is one extra small model call on the uncertain minority of questions and a new closed schema to maintain. Because the router sees only keys and statuses, a wrong route costs a not-found line, never a wrong fact. The insurer-terms source stays empty until ADR 0037 lands and the UIN and product mapping is filled; until then the chain stops at the not-found sentence, and the label table is ready for it.

**Build order (each step shippable).**
1. Holding questions answered from the holding record, with tests (no model). Scope line for out-of-scope.
2. Source labels on every block; the fixed-order fallback chain over `memory_fact`, `own_clauses`, `insurer_terms` (stub returns none).
3. Router call behind `CHAT_ROUTER_ENABLED`, schema validation, fallback to keywords, and an eval over the 60-question set (checked answers kept as the expected sources).
4. Concurrency setting and the typed busy answer.
5. Wire `insurer_terms` to FSS facts when ADR 0037 step 3 lands.

**Alternatives rejected.**
- Let the model see the facts and pick freely: it could state a fact it was not given, and the label would be a guess.
- More keyword rules for Hinglish: never ends, and each language needs its own list.
- Always call the router: it adds cost and latency to questions the free path already answers well.
