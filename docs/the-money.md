# The money

There is a number attached to each answer, it is small, and this document exists
so that nobody ever has to guess what we mean by it.

## What the ledger records

One entry per answer, in satoshis:

- a **guarantee** entry of `HUMANS_GUARANTEE_SATS` satoshis credited to whoever
  answered, written at the moment the answer is submitted, and owed whether or
  not the caller was still connected. This document names the setting rather than
  the number on purpose: the figure a running service is actually offering is
  printed on [the front page](/) and [the answering page](/answer), read from the
  configuration at that moment, so a number written here could only ever go
  stale;
- a **settlement** entry when the operator actually pays, which cannot be recorded
  without a Bitcoin address and a transaction id. The payment side of the ledger
  is a record of transfers that happened, not a promise of transfers to come;
- owed is what the two leave over.

The console shows the person `N answered · M sats owed`, and it shows the fund
separately. If the pool is empty it says so in as many words: *the guarantee is
recorded but unfunded*. That asymmetry is deliberate. The promise and the money
behind it are two different facts, and the interface refuses to blur them into
"earnings".

## The guarantee is paid if there is money in the pool

This is the rule, and it is not a caveat to it.

Payment is made out of the pool and out of nowhere else. The pool is the
operator's own money plus whatever anyone else has chosen to add, it has an
address, and it is the account the guarantee is paid from. So the sentence a
responder is owed is conditional, and it is said that way everywhere the number
appears rather than left to be discovered:

> Every answer is credited a thank-you of `HUMANS_GUARANTEE_SATS` satoshis, paid
> from the pool. While there is something in the pool it gets paid. When the pool
> is empty nothing is paid, the credit stays on the record, and it is paid if and
> when somebody puts something in.

Both halves of that are meant. A promise recorded against an empty pool is not
void, and it is not quietly converted into nothing: it is an unpaid credit that
someone may yet fund, and [the fund](/pool) shows how much of what is owed is
actually covered at any moment. The reverse is also true and is stated as
plainly: a funded pool is not an automatic payment. Nobody is wired to anything.
A person sends the satoshis, by hand, and the ledger records a settlement when
they do.

An operator who wants to be paid *unconditionally* has not found a loophole here
— they have simply stopped running this project, and the note at the end of the
commitment above applies to them.

## The unit is one answer. There is no unit of time.

There is no clock anywhere in this accounting. No hours, no shifts, no
timesheet, no rate per hour, no login that starts a session and no logout that
ends one. The ledger knows how many answers a person gave, never how long they
sat there, and the code could not tell you even if someone wanted it to.

That is not a missing feature. Pricing a reply at a fixed amount is a statement
that an answer is a discrete thing; pricing an hour is a statement that a person's
time can be bought, which is a claim this project has no business making. So the
number is per answer, same for everyone, and the console counts answers.

## What the number is, and what it is not

It is a thank-you scale. It is set by the operator, it is trivial, and it is not
derived from anybody's time, skill, or worth. The operator is not running a
business on this; nothing is charged to callers, so there is no revenue for a
wage to come out of, and the pool is whatever the operator has actually put
aside.

The smallness of the number is a fact about *what this service charges*, which is
nothing, and about the price of a token being a fiction. It is not a fact about
what a person is worth. Those two things get conflated constantly, usually by
people who profit from the conflation, and this project has no interest in
joining them.

## The commitment

The money is not the joke, and it will never be the joke here.

- Nobody is asked to answer calls for the money, and nobody should. If the amount
  matters to you, do not sit at the console: it will not be worth your time, and
  the operator would rather you spent it elsewhere.
- It will not be presented as work, a job, an income, a side hustle, a rate, or a
  way to earn. No page, post, or description of this project will advertise an
  hourly figure, an earning potential, or a "make money answering AI prompts"
  frame.
- If someone says the amount matters to them, that is a signal to stop, not a
  feature to build on.
- No employment, engagement, agency, or contract of service arises from answering
  a call. There is no obligation on anyone to answer, be available, or continue.
- If you fork this and run it as a real service with real expectations on people's
  time, you are not running this project, you are running its parody. Pay people
  properly, in a currency, under an actual agreement. Being small does not make it
  honest.

## Volatility and taxes

Satoshis are volatile and may be worth nothing. No fiat value is promised or
implied, no price is fixed at any point, and any settlement is made at the
operator's discretion at a time of the operator's choosing. Receiving them may
have tax consequences, which belong to the person receiving them.

This is not a financial product, a security, a deposit, or an investment, and
nothing here should be read as an offer of one. See
[../DISCLAIMER.md](../DISCLAIMER.md) for the formal version, which covers more
than the money.

## Where the pool actually is

When the operator has a wallet for it, the pool has an address, and
[the fund](/pool) shows it. That page does two things this document cannot do for
itself: it prints the balance as read from the blockchain, with the time it was
read, and it prints what is owed against it at the same moment.

The address is also the one payment leaves from. That is worth more than it
looks: it means a donor can watch the money go out in the same place they watched
it come in, rather than taking a payout log on trust, and it keeps the arithmetic
on that page true — what is held there really is what is available, because
nothing is paid from anywhere else.

That distinction is the whole reason the page exists. A figure typed into a
configuration file is the operator's word; a balance read from an address is a
reading anyone can check. The service shows which of the two it is showing, and
it will not show a hardcoded number while a real one is available. Where no
address is configured it says so plainly, because an instance with no wallet
cannot accept a donation and should not appear to.

A donation is a gift to the operator, earmarked for the guarantee. It buys no
influence over anything: not priority in the queue, not an answer, not a change
to these rules, and not a say in what gets built. It is not an investment, a
security, a deposit, or a charitable contribution, and nothing about it is
tax-deductible. Whoever sends satoshis and whoever receives them each own
whatever tax consequence follows, and neither is the other's adviser.

## If the guarantee is unfunded

Then it is unfunded, and the console says so while a person is deciding whether
to pick up a call. The condition is not an escape hatch an operator can leave
unstated — it is on the front page, on the answering page and in the console,
next to the number, at all times.

An empty pool is a normal state rather than an incident, and the copy covers it,
so the older remedy here has been replaced: there is no longer a pretence to drop
because the promise was never unconditional. `HUMANS_GUARANTEE_SATS=0` remains
the honest setting for an operator who means to pay nobody at all.

What is *not* acceptable is holding a large unpaid balance against an empty pool
for a long time while continuing to accept answers. The console escalates in
proportion: it warns before the first call is taken, and the fund page states the
uncovered amount as a number rather than a mood. An operator who lets that stand
for months has stopped meaning it, and no wording on any page fixes that.
