# How websites capture signups and user data: research for Knowvia

13 October 2026. Every claim below was checked against a page the researcher opened. X/Twitter, Reddit and Indie Hackers blocked automated reading, so forum evidence comes from Hacker News (HN) and Product Hunt. Numbers are labelled self-reported or vendor-reported where that applies. This is not legal advice.

## Rules that shape every choice

- **DPDP Act 2023, s.6:** consent must be "free, specific, informed, unconditional and unambiguous with a clear affirmative action", limited to the stated purpose. Withdrawing consent must be as easy as giving it ([s.6](https://www.dpdpa.com/dpdpa2023/chapter-2/section6.html)).
- **DPDP Act, s.9:** verifiable parental consent for children's data. No tracking, behavioural monitoring or targeted ads aimed at children ([s.9](https://dpdpa.com/dpdpa2023/chapter-2/section9.html)). This matters because family policies include children.
- **DPDP Rules 2025:** notified 14 November 2025, with an 18-month phased start. They require a separate, plain-language notice of purpose. Penalties reach Rs 200 crore ([PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)).
- **CCPA Dark Patterns Guidelines 2023:** 13 named patterns, including false urgency, confirm shaming, forced action and interface interference. Orders have gone to Zepto, SpiceJet, IndiGo and others ([Bar & Bench](https://www.barandbench.com/law-firms/view-point/from-nudge-to-notice-what-indias-dark-pattern-orders-mean-for-digital-business)).
- **IRDAI:** fined a corporate agent partly for buying leads from unregistered lead generators ([Cafemutual](https://cafemutual.com/news/insurance/31511-irdai-imposes-rs2-crore-fine-on-a-corporate-agent-for-fraudulent-sales-practices)). Passing leads to insurers or brokers is regulated activity.
- **TRAI TCCCPR, second amendment (February 2025):** stricter consent rules for commercial calls and SMS ([Khaitan & Co](https://khaitanco.com/thought-leadership/Efforts-to-Curb-Spam-Continue-TRAI-Releases-Second-Amendment-to-the-TCCCPR-2018)).

## The tactics at a glance

| Tactic | Example | Fit for Knowvia | Main risk |
|---|---|---|---|
| Referral waitlist with queue position | Robinhood | Possible | Fake scarcity; position gaming |
| Short qualifying survey after the email | Superhuman | **Good** | Over-collection if it asks about health |
| Build-in-public waitlist updates | Resend | **Good** | Bot signups |
| Product Hunt teaser page | PH makers | Possible | Global tech audience, not Indian families |
| Fake door / smoke test | Buffer | Possible | Misleading if never built; never take payment |
| Free calculator with no personal data | ManipalCigna SahiCover | **Good** | Gating results behind a phone OTP |
| Quiz funnel | Prose | Possible | Health questions become sensitive data |
| One question at a time / multi-step form | Typeform | **Good** | Hiding the total ask |
| Progressive profiling | HubSpot smart fields | **Good** after signup | Purpose creep |
| Try before signup | Duolingo, Twitter | **Good** | Low |
| Upload a policy, get an answer | Coverfox COVER AI, EzPolicy | Later | Health and children's data before safeguards exist |
| Voice or video answers | VideoAsk, Voiceform | Optional only | Low uptake; voice is personal data |
| AI chat widget | Drift | Avoid pre-launch | Liability for wrong coverage answers (Air Canada case) |
| Google One Tap on click | Reddit | **Good** | Auto-prompt feels "creepy" |
| Magic link / email code | Many SaaS | Possible | Friction in in-app browsers |
| WhatsApp click-to-chat and opt-in | Ditto, Max Life, Jugalbandi | **Good** | Bundled or pre-ticked opt-in |
| Missed-call capture | Exotel clients | Possible, offline | Low intent; TRAI rules on callbacks |
| Truecaller one-tap verification | ixigo, Times Internet | Later | Truecaller's own consent controversy |
| Phone + OTP gate | Policybazaar | **Avoid** at waitlist | Spam-call reputation; lower conversion |
| Exit-intent popup | HN founders | Possible | Nagging; confirm shaming |
| Content upgrade / lead magnet | Backlinko | **Good** | Low |
| Free human advisor call | Ditto | Possible | Becomes regulated if it advises or sells |
| Person-level de-anonymisation | RB2B | **Avoid** | Identifies people without consent |
| Capturing typed fields before submit, pixel auto-matching | Meta, TikTok pixels | **Avoid** | Data taken before consent |
| Session replay, browser fingerprinting | FullStory, Hotjar, ad networks | **Avoid** on forms | Keystroke capture; covert tracking |

## What the forums said, with sources

- **Referral queues.** Robinhood's waitlist is the classic case: figures of about 1M signups circulate, but no primary source was found. HN users traded codes and self-referred with fake emails ("from 51k to 11k") ([HN](https://news.ycombinator.com/item?id=7313816)). Others called it "artificial scarcity", likened to MLM ([HN](https://news.ycombinator.com/item?id=28845877)). Use a share link, never ask people to type in friends' emails, and never fake the queue position.
- **Qualifying survey.** Superhuman sent about 20 Typeform questions after signup, scored the answers, and invited good-fit users to book onboarding ([Typeform](https://www.typeform.com/blog/superhuman-product-market-fit), [First Round](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit)).
- **Build in public.** Resend reached 6,338 signups in 7 weeks (self-reported, from an author with about 39k followers). Lessons: validate emails early, and qualify people with a short survey ([Zeno Rocha](https://zenorocha.com/lessons-learned-from-growing-a-6338-people-waitlist-in-7-weeks)). HN is sceptical of "waitlist launches" ([HN](https://news.ycombinator.com/item?id=36835054)), and one founder found their list was mostly bots ([jrhizor](https://jrhizor.dev/posts/building-a-waitlist-the-wrong-way/)).
- **Try before signup.** Duolingo asks for signup only after a lesson ([Appcues](https://goodux.appcues.com/blog/duolingo-user-onboarding)). Twitter's longer signup, with a topic-picking step, raised signups 29% ([LukeW](https://www.lukew.com/ff/entry.asp?1128)).
- **Google One Tap.** Reddit saw +90% new signups on desktop, but this is Google's own case study ([Google](https://developers.google.com/identity/sign-in/case-studies/reddit)). HN users called the auto-prompt creepy ([HN](https://news.ycombinator.com/item?id=33143442)).
- **WhatsApp in India.** Meta requires a clear opt-in that names the business ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in)). Ditto pairs a free advisor call with WhatsApp ([Zerodha](https://zerodha.com/z-connect/featured/introducing-ditto-insurance-made-easy)). Jugalbandi answers in 10 Indian languages by text or voice ([TechCrunch](https://techcrunch.com/2023/05/24/microsoft-ai-chatgpt-reaches-rural-india/)).
- **Phone gates.** HubSpot's study of more than 40,000 landing pages found that phone, age and address fields lower conversion ([HubSpot](https://blog.hubspot.com/blog/tabid/6307/bid/6748/3-form-fields-that-kill-landing-page-conversion-rates.aspx)). One Policybazaar user reported 15 to 20 telecaller calls after entering a number ([complaint](https://www.consumercomplaints.in/policy-bazaar-big-thieves-unwanted-calls-and-bad-behavior-c2126522)).
- **Covert capture.** The Leaky Forms study (USENIX 2022) found emails sent to trackers before the form was submitted, on 1,844 EU and 2,950 US sites ([USENIX](https://www.usenix.org/conference/usenixsecurity22/presentation/senol)). HN's reaction: "it's a keylogger" ([HN](https://news.ycombinator.com/item?id=31338282)). The Meta Pixel sent appointment details from 33 of the top 100 US hospital sites ([The Markup](https://themarkup.org/pixel-hunt/2022/06/16/facebook-is-receiving-sensitive-medical-information-from-hospital-websites)). Session replay leaked prescriptions from Walgreens ([Princeton CITP](https://blog.citp.princeton.edu/2017/11/15/no-boundaries-exfiltration-of-personal-data-by-session-replay-scripts)). RB2B-style de-anonymisation was called "pretty scary" ([HN](https://news.ycombinator.com/item?id=41166644)).

## Voice notes on signup forms

- **Uptake is low.** In one US research-on-research study, only 4% recorded anything and 1% gave a usable spoken answer, against 90% usable typed answers. People cited habit, wanting to edit, background noise and privacy ([Greenbook](https://greenbook.org/insights/research-methodologies/are-people-ready-for-voice-surveys)).
- **Indian languages are the opportunity.** Google reported 270% growth in voice search and expected 9 in 10 new users to use Indian languages (2019, search, not forms) ([Inc42](https://inc42.com/buzz/most-of-india-prefers-using-hindi-for-search-says-google)). Sarvam's speech-to-text covers 22 Indian languages plus English ([Sarvam](https://docs.sarvam.ai/api-reference-docs/speech-to-text/apis/overview)).
- **Privacy.** Browser speech recognition sends audio to a server by default ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)).
- **So:** keep voice optional and typing always available, get explicit consent, delete raw audio on a stated schedule, and measure how many people use it. The designed "Say it" tab follows this, and the website ships it switched off until legal sign-off.

## Short multi-step form or a single email field

- HubSpot found extra fields cost little; textareas, phone, age and address cost the most.
- On HN, practitioners said multi-step works better on mobile, while others called it less honest about the total ask ([HN](https://news.ycombinator.com/item?id=20239521)).
- Typeform's "3.5x completion" claim is vendor marketing and unverified.
- **Takeaway:** capture the email first, keep the extra questions optional, and show the whole ask. The redesigned closing card does this.

## Recommended for Knowvia, in order

1. **Email first, then 2 or 3 optional questions:** who is covered, employer or retail policy, insurer, and language. Each question gets a purpose line. No health conditions and no phone number.
2. **A sample-policy demo and a coverage checker that needs no personal data,** to show the value before asking for anything.
3. **A separate, unticked WhatsApp opt-in plus click-to-chat,** in the user's language.
4. **Plain-language checklists as content upgrades** (room-rent caps, co-pay, waiting periods). They are good for search too.
5. **Google One Tap on click, double opt-in email, and build-in-public updates.** Run the optional voice note as a measured experiment.

## Avoid

- De-anonymisation tools, browser fingerprinting, and pixel "automatic advanced matching". They identify people before notice and consent.
- Third-party pixels or session replay on signup or policy pages.
- A mandatory phone number and OTP at the waitlist stage.
- Fake counters, countdowns or queue positions; confirm-shaming popups; pre-ticked or bundled consent.
- Policy uploads or an AI chatbot explaining cover before launch safeguards exist.
- Sharing or selling leads to insurers or brokers.

**Could not verify:** Robinhood's exact referral numbers, HubSpot Website Grader figures, Drift's "no forms" results, the GESIS voice study, and anything on X, Reddit or Indie Hackers.
