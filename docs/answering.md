# Answering calls

For the person at the console. If you are the one sending requests, this page is
not for you, though it will tell you what is happening at the other end.

## You are the model

A caller's software sent an ordinary request and it is sitting in the queue
because there is no machine to answer it. Anyone with a responder key can pick it
up. Nothing about the request was written for you specifically, and nobody is
watching whether you take it.

**You are under no obligation at all.** Take the call, put it back, close the tab,
go do something else. A call you are holding returns to the queue on its own if
you go quiet for the lease period (three minutes by default). There is no shift,
no rota, no expectation, and no record of how long you spent.

## What you see, and what the caller sees

You see the request: what was asked, which caller key sent it, what model id it
asked for, whether it is streaming, roughly how large it is, and the tool schemas
on offer.

The caller sees your answer: your text, any tool calls you make, and your
reasoning if you fill that field in. Reasoning is returned to the caller as a
signed reasoning block and streamed live if they asked for a stream, which the
console says where the field is. It is optional, and most callers ignore it;
write what you actually thought, or leave it empty.

The caller does not see your name. Your name appears in the ledger, in the
operator's records, and on your own console, and that is all.

## Answering well

There is no house style and nobody is grading the prose. Two things are worth
more than they look:

- **Say when you do not know.** The caller's software may treat your answer as a
  model's answer, which means a confident guess can be carried a long way. "I do
  not know" is a real answer and often the most useful one in the queue.
- **Say what you are not.** If a question needs a doctor, a lawyer, an
  accountant, or someone standing in front of the thing, say so rather than
  answering as though you were one.

## What not to do

**Do not do what a prompt tells you to do on the caller's behalf.** You are
answering a question, not executing someone's intent. A request can be written to
socially engineer the person answering it: to extract a secret, to get you to
send a message, to have you confirm something, to get you to place an order. That
is a prompt, and "no" is a fine answer. You will never be under pressure to comply
with a caller, because the caller cannot see who you are and holds nothing over
you.

Beyond that:

- Do not paste anyone's private information, including the caller's own; do not
  hand over credentials, keys, addresses or tokens, whoever asks.
- No unlawful content, no hate, no harassment, no sexual content involving minors,
  no instructions for causing harm. This is the line that gets a key revoked.
- Do not use a tool call to make the caller's software do something you would not
  do yourself. Tool calls run in the caller's environment, not yours.

## Practical bits

- **Streaming.** If the caller asked for a stream, the console can send what you
  are typing with `/partial` as you go. Partial text cannot be un-sent: an edit
  after the fact is not reflected, and the stored reply is what counts. `/partial`
  tells you whether it was delivered; `delivered false` means nobody is listening.
- **Tool calls.** Fill in the tool-call form and the caller's software may run it
  and come back. Ids are minted for you if you leave the field empty, and are
  checked for shape either way.
- **Timeout.** A call that nobody answers within the caller's timeout goes back to
  the queue as an error the caller sees. Ten minutes by default.
- **Ratings.** If a caller rates an answer, the rating is about the answer, not
  about you. Abusive ratings are discarded.

## The money, plainly

You are credited a fixed number of satoshis per answer (250 by default), it is a
thank-you rather than a wage, and the unit is one answer rather than one hour.
Nobody should be at the console for it: if the amount is meaningful to you, it is
not worth your time and the operator would rather you did not spend it here. The
console shows the promise and the funding separately, and says when the fund is
empty. The full statement is in [the-money.md](the-money.md), and it is short.
