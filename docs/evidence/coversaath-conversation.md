# Coversaath — the idea, as a conversation

*Rishav and Aman, Sunday evening, a chai stall near Aman's office. Aman spent four years in claims operations at a TPA before moving to a fintech. Rishav is building Coversaath.*

---

**Aman:** Okay so last time you showed me that card thing. The physical emergency card, and the whole "second person has to pass a drill" idea. Where's that now?

**Rishav:** Killed both.

**Aman:** That was fast.

**Rishav:** No, it was slow, that's the problem. I sat with it for three weeks and kept trying to defend them. The card was me solving for a moment — the 2 a.m. moment where someone's at a hospital counter with no idea what to hand over. Real moment. But a card is a piece of plastic. It doesn't know anything. And the drill — where I was going to make a second family member prove they could handle a claim — that was me testing my users. Nobody signs up for a product that gives them a test.

**Aman:** People barely open their policy PDF, forget passing an exam on it.

**Rishav:** Exactly. And once I dropped both, the actual thing became obvious. It's not a card and it's not a quiz. It's a single place where a household can see every bit of health protection it already has, understand what each one can actually do, and get told what to do when money is about to be spent.

**Aman:** Say that in one line, like you'd say it to my dad.

**Rishav:** One dashboard for a family's whole health insurance. Every policy from every source in one place. It explains what each one actually covers, it plans the cheapest and least painful route for a hospital bill, and when there's an emergency it puts a real human on the line who already knows your entire situation.

**Aman:** Okay. Now the annoying question. What's in it for the 25-year-old? Because that's who you keep saying you're building for, and that guy doesn't get hospitalised.

**Rishav:** He doesn't. His parents do. That's the whole thing. Take a typical guy, 25, first or second job in Bangalore or Gurgaon. Sit down and count what he's actually sitting on. His father bought a family floater in 2016 — ten lakh, covers all four of them, and the father is the proposer so the renewal notice goes to the father's email which nobody checks. Then his employer gave him a group health policy — five lakh, covers him and technically his parents if he paid the top-up premium during enrolment window, which he didn't because he didn't read the mail. Then he bought his own retail policy last year because a friend said you should. Then there's a super top-up his uncle sold him. And then his credit card — the premium one with the annual fee — that has some hospitalisation cash benefit and an accident cover he has genuinely never once thought about.

**Aman:** That's five sources.

**Rishav:** Five sources, and if you ask him "what's your coverage," he'll say "uh, we have insurance." That's the honest answer. He has five things and zero understanding.

**Aman:** So you show him a big number. Thirty lakh total cover.

**Rishav:** No. That's the trap, and I almost built it. Adding sum insured across policies is a lie, and it's a dangerous lie because it makes people feel safe.

**Aman:** Go on. I want to hear you say why, because in ops I saw this go wrong constantly.

**Rishav:** Because coverage isn't a pool of money, it's a set of conditions. That ten-lakh family floater is shared — if his mother has a two-lakh procedure, the floater has eight lakh left for everyone else that year. The employer's five lakh only covers him, unless he actively added parents. The retail policy has a two-year waiting period on his mother's thyroid condition, and it's been fourteen months, so right now that policy does nothing for that particular problem. The super top-up has a five-lakh deductible, which means it contributes nothing at all until five lakh has already been spent from somewhere else. And the credit card thing pays a fixed daily cash amount, it's not indemnity, it doesn't touch the hospital bill.

**Aman:** So of the "thirty lakh," for the specific thing that's most likely to happen to his mother next year —

**Rishav:** — the number is much closer to eight lakh, and that's before you get into the room-rent cap on the old floater, which was written when a single AC room cost four thousand a night and now costs eleven. Cross that cap and the insurer proportionately deducts across the whole bill, not just the room charge. That's how people end up paying forty percent of a "fully covered" claim.

**Aman:** Proportionate deduction is the one nobody sees coming.

**Rishav:** Nobody. So mode one of the dashboard isn't a total. It's per person. You pick your mother, and you see which policies actually cover her, what each one's sum insured is and whether it's shared, the deductible, the co-pay, the room-rent and ICU limits, the waiting periods with dates on them so you know when they clear, the specific exclusions and disease sub-limits, whether restoration benefit exists and whether it's once a year or unlimited, the no-claim bonus she's built up, the renewal date, and what happens the day I leave my job and the group cover vanishes.

**Aman:** And where you don't know?

**Rishav:** It says so. That's not a small feature, that's a design principle. Every field is one of three states — confirmed, uncertain, or missing. Confirmed means it's in the policy wording and we've read it. Uncertain means the wording is ambiguous or it depends on the hospital's own agreement with the insurer, and we're telling you it needs written confirmation. Missing means we don't have that document, and here's whose phone number you need to call to get it.

**Aman:** People will hate the uncertain ones.

**Rishav:** They'll hate them less than they'd hate a confident wrong answer at a hospital counter. That's the rule I'm holding — admit first, optimise later. If I fake certainty to look polished, the one time it matters I've made things worse than doing nothing.

**Aman:** Fine. Second mode.

**Rishav:** Plan an expense. This is the one I actually care about. Say the knee replacement his father has been putting off for two years. He opens it and enters five things — who the patient is, what the procedure is, which hospital, roughly when, and the hospital's estimate if he has one. Say the estimate is 3.4 lakh at a hospital in Delhi.

**Aman:** And you tell him what.

**Rishav:** Which policies can apply to this, in what order. Which one to approach first — usually the floater, sometimes the employer policy because group policies often have waiting periods waived, which almost nobody knows. Whether the hospital is in that insurer's cashless network, because a hospital can be network for one insurer and not another, and being in a preferred provider network changes the negotiated rate. Then the actual pre-authorisation process — which form, which TPA desk, how many days ahead, what the hospital's insurance desk will ask for. The document list. Then the money: what the room-rent cap does to this specific bill, what the co-pay pulls out, whether the super top-up's deductible gets crossed and therefore whether it's even in play, and the number he actually needs to arrange in cash on admission day.

**Aman:** That last number is the one people want.

**Rishav:** That's the whole product for a lot of people. "How much cash do I need to have on Tuesday morning." Nobody answers that today. The hospital gives you an estimate, the insurer gives you a policy document, and you're supposed to do the math yourself between the two while your father is nervous about surgery.

**Aman:** And you're careful about what you promise.

**Rishav:** Very. I optimise the route — administrative and financial. I do not guarantee cashless approval and I do not guarantee final settlement. Those are the insurer's and the TPA's calls, and anyone who tells you otherwise is selling. What I say is: this is the best route based on what's written, here's what's still unconfirmed, and here's exactly what to get in writing before admission.

**Aman:** Third.

**Rishav:** Buy or renew. And this one exists because of a bad habit the whole industry has. Someone thinks about buying a policy and the entire internet's answer is "here are twelve policies, sorted by premium, click to buy." No one asks what you already have.

**Aman:** Because nobody knows what you already have.

**Rishav:** Right, and I will. So when he's considering a five-lakh top-up, Coversaath checks it against the full dashboard first and tells him: this adds real protection here, it duplicates this thing you're already paying for, and by the way after all this your mother is still the exposed one because her condition sits in a waiting period on the only policy that would cover it. Here's the premium now and here's roughly what it looks like at forty-five, because health premiums step up hard with age and people sign up for something they'll quietly drop in a decade. Here's what changes the day you leave your job. Here's whether it's actually reasonable to keep the old floater or whether it's a sentimental expense.

**Aman:** And sometimes the answer is don't buy.

**Rishav:** Sometimes the answer is wait. "Don't decide this yet — you don't know whether your employer covers your parents, and that one fact changes the recommendation completely. Go find out, come back." That's a real output. A product that only ever says "buy this" isn't advising anybody.

**Aman:** Okay, fourth. This is the one I'm going to poke holes in.

**Rishav:** I know. Emergency help. One button, always visible. Someone presses it and they get a human being on the line, fast.

**Aman:** Everyone says that. Then it's a chatbot, and then it's a form.

**Rishav:** The difference is what the human sees. When they pick up, the household dashboard is already open in front of them — authorised, so only what the family has permitted. They know who the policies belong to, who's insured, which hospital the family is at, which TPA to call, what the room-rent limit is going to do to this bill, and which details are still unconfirmed. They're not asking "sir, please tell me your policy number." That question, at that moment, is the thing that breaks people.

**Aman:** And the AI?

**Rishav:** Runs behind. Pulling the pre-auth form fields, extracting facts from the discharge summary as it comes, tracking where the case is, flagging what the hospital hasn't sent yet. The human talks. The AI does the paperwork. Nobody in a hospital corridor at 2 a.m. wants to type into a chat window.

**Aman:** Doesn't scale though. Humans are expensive.

**Rishav:** It doesn't scale cheaply, and I'm not pretending it does. But emergencies are rare per household and enormous per household. That's exactly the shape where a human is worth paying for. And the reason it can work at all is that the context is already built — the human isn't spending forty minutes discovering the family's situation, because mode one did that months ago on a calm Tuesday.

**Aman:** Alright, let me ask the thing I've been sitting on. This is a dashboard. Policybazaar can build a dashboard. Every insurer has an app. Employer benefits platforms already show you your group cover.

**Rishav:** Yeah, and I want to be honest about this because I spent a while thinking the dashboard was the product. It isn't. The dashboard is table stakes. Anyone can build one, and the aggregators have more data and more distribution than I ever will.

**Aman:** So?

**Rishav:** So the actual thing — the part that's hard, and the part nobody currently does — is three things. One, understanding how multiple policies from *different sources* interact for one specific person. Not listing them. Working out the interaction: which one goes first, what the deductible does to the top-up, what the waiting period on this policy means given that other policy exists, what breaks when the group cover disappears. Two, recommending the best route for a *specific* expense — this patient, this procedure, this hospital, this date. And three, giving a human that same verified context at the exact moment it matters.

**Aman:** And an aggregator won't build that because —

**Rishav:** Because their business is the transaction. Their incentive is to sell you the next policy, and "you already have this covered, don't buy" is not a sentence their model wants to produce. An insurer won't build it because they can only see their own policy. An employer platform only sees the group plan. Nobody is structurally positioned to look at all five sources at once and be indifferent about which one you use.

**Aman:** Where does claim settlement ratio fit? Everybody leads with CSR.

**Rishav:** It sits in the corner as secondary comparison information. Available, not decisive.

**Aman:** Say why. Because that'll get pushback.

**Rishav:** Because an aggregate ratio is a fact about a company's whole book, and it tells you nothing about whether Ravi's specific claim gets paid. A ninety-eight percent settlement ratio can sit next to a policy that excludes exactly the thing Ravi's mother has. Meanwhile the wording, the sub-limits, the room-rent cap and the hospital's network status determine his outcome almost entirely. Leading with CSR feels rigorous and is actually a way of not reading the policy.

**Aman:** Fair. So what does someone actually do on day one? Because if the drill and the card are gone, what's the onboarding?

**Rishav:** Onboarding is just collection. Nothing clever. Upload the policy documents — the PDFs, or a photo of the physical booklet if that's what exists. Add the employer benefits, which usually means one screenshot from the HR portal. Add the relevant credit card benefits. Confirm who's in the household and who's allowed to see what — that permissions step matters, because a father may not want his son seeing his medical history, and that has to be his choice. And then the last one, which is the real work: resolve the missing policies through whoever holds them.

**Aman:** Meaning "call your dad."

**Rishav:** Meaning we generate the specific ask. Not "get your documents." More like: "Your father's floater renews on 14 March and we don't have the current year's policy schedule. Ask him for the PDF from the renewal email — subject line will have the insurer's name. Here's a message you can forward." Because "go collect your family's insurance documents" is a task nobody does, and "forward this one email" is a task people do.

**Aman:** No exam.

**Rishav:** No exam. No mandatory backup-person drill. No separate physical card. Those all came from me trying to force preparedness onto people. You can't. What you can do is make the prepared state the default, quietly, by holding the context for them.

**Aman:** What do you call this internally? Because "insurance dashboard" undersells it and also sounds boring.

**Rishav:** Household Health Insurance Command Centre. With the Household Health Treasury sitting underneath it — that's the layer that actually holds and reconciles the money side: what's available, from where, under what conditions, in what order.

**Aman:** Command centre is a bit much.

**Rishav:** It's a bit much. But it's accurate about the job. It's the one place you go when something health-related is about to cost money, and you leave knowing what to do next.

**Aman:** Alright. I'd use it for my parents. That's not nothing.

**Rishav:** That's the whole market, honestly. It's you, for your parents.
