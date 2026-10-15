# The money

There is a number attached to each answer, it is small, and this document exists
so that nobody ever has to guess what we mean by it.

## What the ledger records

One entry per answer, in satoshis:

- a **guarantee** entry of `HUMANS_GUARANTEE_SATS` (250 by default) credited to
  whoever answered, written at the moment the answer is submitted, and owed
  whether or not the caller was still connected;
- a **settlement** entry when the operator actually pays, which cannot be recorded
  without a Bitcoin address and a transaction id. The payment side of the ledger
  is a record of transfers that happened, not a promise of transfers to come;
- owed is what the two leave over.

The console shows the person `N answered · M sats owed`, and it shows the fund
separately. If the pool is empty it says so in as many words: *the guarantee is
recorded but unfunded*. That asymmetry is deliberate. The promise and the money
behind it are two different facts, and the interface refuses to blur them into
"earnings".

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
to pick up a call. An operator who lets that note go unread for a long time is
one who has stopped meaning it. Holding the record of a promise you are not
keeping is worse than never making it, so the intended remedy is to either fund
the pool or set `HUMANS_GUARANTEE_SATS=0` and drop the pretence.
