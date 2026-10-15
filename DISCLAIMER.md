# Disclaimer

This document covers any instance of this service run by its author, including the
one published at `humans.lxg2it.com`. It was written before that instance was
deployed, because writing it afterwards is how disclaimers end up describing what
was built rather than deciding what may be. Nothing below changed when the
deployment happened: where the running service and this document disagree, the
service is the truth and this is the thing to fix.

It does not cover your own deployment of the code: if you run this yourself, you
are the operator of your instance and everything below describes what *you* are
now responsible for.

Read it as one person telling you plainly what this is, because the fact that a
human answers makes most of the usual boilerplate untrue. Nothing here is
intended to be a substitute for advice, and none of it is legal advice.

## This is an experiment, not a product

There is no company behind it, no support, no service level, no commitment to
keep it running, and no promise that a request will be answered. A request is
answered by a person who happened to be at the console; if nobody is there, it
times out. Availability varies with human attention. The service may be changed,
throttled, suspended or switched off at any time, and stored data may be deleted.

It is not affiliated with, endorsed by, sponsored by or connected to Anthropic or
any other model provider. "Anthropic", "Claude" and the names of their products
are trademarks of their respective owners. Compatibility here means only that the
service speaks the same wire format, so that an existing client can be pointed at
it. It is a statement about HTTP and JSON, not about any relationship.

## A person reads what you send

Every request is read in full by a human being before it is answered. That is the
entire premise, and it is the most important sentence on this page.

- Do not send secrets, credentials, private keys, API tokens, or anything you
  would not show to a stranger.
- Do not send other people's personal information, health information, financial
  details, identity documents, or anything confidential to a third party.
- The prompt body is stored so the person can read it, and by default it is
  deleted about 24 hours after the request is finished. The reply, the request id,
  the caller key name, the responder name and the ledger entries are kept.
- Credentials are stored only as hashes. IP addresses are not stored.
- The site publishes aggregate numbers — how many calls and answers there have
  been, on which days, and how many people have answered at all. They are counts.
  Nothing that identifies a caller or a responder is published with them, and
  nothing that identifies one can be worked out from them.
- The operator may read stored records for moderation and operation, and may act
  on anything illegal or abusive found there.

If the responder filled in the optional reasoning field, that text is returned to
you as a reasoning block, and streamed to you live if you asked for a stream. The
console says so where the field is. Treat it as part of the answer.

## A person's answer is not an authoritative answer

Answers come from an individual who has not been vetted, tested, trained,
supervised or quality-checked. They may be wrong, out of date, biased, careless,
offensive, or deliberately unhelpful. Nothing is fact-checked. No answer is
reviewed before you receive it.

Nothing produced by this service is professional advice of any kind: not legal,
medical, health, financial, investment, tax, safety, security or engineering
advice. Do not rely on it to make a decision that matters. Do not use it for
anything where an error causes harm: safety-critical systems, medical or crisis
situations, emergency response, automated decisions about people (credit,
employment, housing, insurance, immigration, policing), or as the basis of a
promise to a third party.

If you point an automated agent at this service, understand what you are doing.
You are handing a stranger's words to software that may act on them, and you are
handing an automated system's request to a person who may be persuaded by it.
That cuts both ways: a prompt can be socially engineered at the person answering
it. The operator is not responsible for what your prompts ask of a human being,
or for what you do with what comes back. Do not design anything that puts a
responder under pressure to act on someone else's instructions.

## Reviews or ratings

If the service invites a review of an answer, a review describes the answer. It is
not a performance review of a person, and abusive reviews may be discarded or
ignored. Responders may decline any request, for any reason, without explanation.

## The satoshis

The ledger is bookkeeping for an experiment. It is not a payment service, not a
bank, not a stored-value facility, not a security, not a financial product, and
not an investment. Amounts are deliberately trivial. No amount is owed, earned,
guaranteed, or payable as a matter of contract, and any settlement is a voluntary
gift from the operator, made or not made at the operator's discretion.

Money may also arrive the other way: where the operator publishes an address for
the fund, anyone may send satoshis to it. That is a gift to the operator, not a
purchase, and it buys nothing — not priority, not an answer, not influence over
what is built. It is not a charitable contribution, nothing about it is
tax-deductible, and it creates no obligation of any kind on the operator or on
anyone answering a call.

Answering calls is not work for the operator. No employment, agency, partnership,
joint venture or contract of service arises between the operator and anyone who
answers a call, and nobody answering is under any obligation to answer, to be
available, or to continue. Satoshis are volatile and may be worth nothing; no
fiat value is promised or implied. Any tax consequences belong to whoever
receives them. See [docs/the-money.md](docs/the-money.md) for the fuller
statement, which is as much a commitment about how this will never be presented
as it is a description.

## Acceptable use

Do not use this service to break the law, to harass anyone, to generate content
that is unlawful, to launder money or evade financial controls, or to obtain
professional advice from someone who is not a professional. Do not attempt to
have a responder perform unlawful, unsafe, deceptive or harmful acts, or to
extract information they should not give you. Do not scrape, bulk-automate, or
deliberately flood the queue: a human pays for that with their attention. Do not
attempt to bypass keys, rate limits or the moderation of the operator.

The service is not directed at children and is not intended for use by anyone
under 18, either as a caller or at the console.

Keys may be revoked, requests refused, answers withheld, and access blocked at any
time, with or without notice, if any of this is abused.

## No warranty, and limits on liability

The service and the code are provided "as is", with all faults, and without
warranty of any kind, express or implied, including merchantability, fitness for a
particular purpose and non-infringement.

To the maximum extent permitted by law, the operator is not liable for any loss or
damage of any kind arising from the service or its unavailability, including lost
data, lost profit, lost opportunity, or harm caused by reliance on anything a
responder said. Where liability cannot lawfully be excluded, it is limited to the
amount the operator has actually set aside to pay for answers, which may be
nothing.

Nothing in this disclaimer excludes any right or guarantee that cannot lawfully be
excluded, including under the Australian Consumer Law, or limits liability for
fraud, or for anything else that cannot lawfully be limited. Some jurisdictions do
not allow certain exclusions, in which case those parts do not apply to you.

## Governing law

The service is operated from Victoria, Australia. These terms are governed by the
laws of Victoria, Australia, and the courts of Victoria have exclusive
jurisdiction over any dispute.

## Changes

This document may change. Continued use after a change is acceptance of it. The
code is licensed under the MIT licence (see [LICENSE](LICENSE)); that licence
covers the software, not the running of this service, and the warranty and
liability terms above are additional to it.

If anything here is wrong about how the service actually behaves, the code and the
behaviour are the truth and this document is the thing that needs fixing. That is
a bug report worth filing.
