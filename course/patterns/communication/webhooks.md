---
title: "Webhooks"
sidebar_position: 3
supplementary: true
---

A webhook is an HTTP callback: a consumer registers a URL with a
producer ahead of time, and the producer sends an HTTP POST to that URL
whenever a relevant event occurs, instead of the consumer having to ask.

## Problem it solves

Without webhooks, a consumer that wants to know about a change in
another system has to poll it repeatedly — "has anything happened yet?"
— which wastes requests, adds latency (you only find out at the next
poll interval), and scales badly with many consumers polling the same
producer. Webhooks invert this: the producer pushes the event the moment
it happens, so the consumer only does work when there's actually
something to do.

## How it works

The consumer registers a callback URL with the producer, usually via a
dashboard or API, along with a shared signing secret. When the event
occurs, the producer builds a payload describing it and issues an HTTP
POST to the registered URL. Because this is a plain HTTP request over
the public internet, two concerns dominate the design:

- **Delivery reliability** — the consumer's endpoint might be down or
  slow. Producers typically retry failed deliveries with backoff for a
  bounded period, and expect the consumer to respond quickly (often just
  a `200 OK` acknowledging receipt) and do any slow processing
  afterward, asynchronously.
- **Authenticity** — anyone who learns the callback URL could POST fake
  events to it. Producers sign each payload (typically an HMAC over the
  raw body using the shared secret) in a request header, and the
  consumer must verify that signature before trusting the payload.

## When to use it

- The consumer wants near-real-time notification of events in a
  third-party or otherwise external system it doesn't control.
- The event volume and consumer count don't justify running a shared
  message broker between two organizations.
- The consumer can expose a public, reachable HTTPS endpoint.

## When not to use it

- The consumer is behind a firewall or NAT with no reachable public
  endpoint — polling or a broker-based push (e.g. pub-sub with a
  client-side subscription) is more practical.
- Guaranteed, ordered, exactly-once delivery is required — webhook
  delivery is typically at-least-once and unordered, so the consumer
  must handle retries and out-of-order arrival idempotently.
- Very high event volume to a single consumer, where a persistent
  streaming connection or a queue the consumer polls at its own pace
  scales more predictably than inbound HTTP bursts.

## Real-world example

Stripe and GitHub both deliver events (payment succeeded, pull request
opened) as signed HTTP POSTs to a URL the developer registers, and both
retry failed deliveries on a backoff schedule while expecting the
receiving endpoint to verify the request signature before acting on it.

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the internal analogue; webhooks are pub-sub's delivery mechanism extended across organizational boundaries.
- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — how producers handle a consumer endpoint that's temporarily unreachable.

## Further reading

- [Webhook — Wikipedia](https://en.wikipedia.org/wiki/Webhook)
- [HMAC — Wikipedia](https://en.wikipedia.org/wiki/HMAC)
