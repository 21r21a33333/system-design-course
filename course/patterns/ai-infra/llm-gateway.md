---
title: "LLM Gateway"
sidebar_position: 4
supplementary: true
---

An LLM gateway is a proxy layer placed in front of one or more large
language model providers, centralizing API-key management, provider
routing and fallback, cost tracking, prompt/response logging, and
per-caller rate limiting.

## Problem it solves

Applications that call LLM APIs directly from many services accumulate
the same problems that any un-gatewayed set of external API calls does,
plus a few specific to LLMs. API keys for one or more providers end up
scattered across services, making rotation and revocation hard. Every
caller has to implement its own retry and fallback logic for provider
outages or rate limits. Nobody has a single view of spend, because
usage-based LLM billing means cost is a function of token volume spread
across every calling service. And prompt/response pairs — often the
most operationally and legally sensitive data a system handles — get
logged inconsistently or not at all. An LLM gateway centralizes all of
this in one place instead of duplicating it into every caller.

## How it works

Calling services send requests to the gateway using a single internal
API, rather than talking to each provider's SDK directly. The gateway
holds the actual provider credentials and injects them, so individual
services never need provider API keys at all. It can route a request to
a specific provider or model based on configuration, and — critically
— fail over to a backup provider or model automatically if the primary
is down or rate-limited, which calling code doesn't need to know about.
Every request and response passes through the gateway, so it's a
natural place to log prompts/completions for auditing, meter token
usage per caller for cost attribution, and enforce rate limits or
quotas per caller so one team's usage spike can't exhaust a shared
provider quota for everyone else.

## When to use it

- More than one internal service calls LLM providers, and consistent
  cost tracking, rate limiting, or logging across them matters.
- Provider outages or rate limiting need to fail over automatically
  without every calling service reimplementing retry/fallback logic.
- Provider API keys need to be centrally managed and rotated rather
  than distributed to every service that calls an LLM.

## When not to use it

- A single service makes all the LLM calls in the system — the
  gateway's centralization benefit doesn't apply if there's only one
  caller to begin with.
- Ultra-low added latency is critical and even a thin proxy hop is
  unacceptable; direct provider calls avoid that extra hop at the cost
  of losing centralized control.

## Real-world example

Open-source projects like LiteLLM and hosted services like Portkey
implement this pattern as a unified API in front of multiple LLM
providers, adding routing, fallback, logging, and cost tracking. Cloud
providers offer the equivalent as a managed capability: Azure API
Management's AI gateway features add token rate limiting, prompt/
completion logging, and load balancing across multiple language model
backends in front of an application.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — an LLM gateway is
  a specialized instance of the same edge-proxy pattern, applied to
  LLM-provider traffic specifically.
- [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) — commonly
  implemented as a policy inside the gateway, since the gateway already
  sees every prompt and response passing through it.

## Further reading

- [AI gateway capabilities in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities)
- [Throttle requests to your REST APIs — Amazon API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
