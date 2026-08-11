---
title: "LLM Gateway"
sidebar_position: 4
supplementary: true
---

An LLM gateway is a proxy layer placed in front of one or more large
language model providers, centralizing API-key management, provider
routing and fallback, cost tracking, prompt/response logging, and
per-caller rate limiting.

![LLM Gateway diagram](/img/patterns/llm-gateway.svg)

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

## Technical architecture & implementation

**Request path.** Calling services send requests to the gateway using a
single internal API — a stable request/response shape the gateway
controls — rather than talking to each provider's SDK directly. The
gateway holds the actual provider credentials and injects them
per-request, so individual services never possess a provider API key at
all; a key rotation or provider swap changes one place instead of every
calling service's configuration. The gateway resolves the request
against a caller's quota and rate limit *before* forwarding anything
upstream — quota is enforced by the gateway, not left to each provider's
own rate-limit response, so one caller's burst can't consume a shared
provider quota that every other caller also depends on.

**Routing and failover.** The gateway maintains an ordered preference
list of providers or models for a given request class and walks it in
order, forwarding to the first provider it currently considers healthy.
If the primary provider returns a rate-limit response, a 5xx, or times
out, the gateway retries against the next provider in the list —
critically, without the calling service ever being aware a failover
happened, since the gateway's response contract to callers is provider-
agnostic. This is exactly the pattern documented on the general
[Failover](/docs/patterns/reliability/failover) page, specialized to
LLM providers: health here is usually judged from recent response
codes and latency rather than a dedicated health-check endpoint, since
most LLM providers don't expose one, and "unhealthy" typically means a
provider is actively rejecting or timing out requests rather than
being unreachable at the network level.

**Observability and metering.** Because every request and response
passes through a single choke point, the gateway is where prompt and
completion logging, token metering, and per-caller cost attribution
naturally live — each request's token counts are already visible to the
gateway as part of routing it, so metering doesn't require any
cooperation from the calling service. This centralization is also
where the pattern's biggest operational risk sits: if the gateway logs
full prompts and completions for auditing, it becomes the single place
holding every sensitive request the system makes to an LLM, and a
retention or access-control mistake in the gateway now exposes
everything routed through it, not just one service's traffic.

**Failure modes.** The gateway is a single logical dependency for every
LLM-calling service in the system, so its own availability and latency
become a shared bottleneck — a gateway outage takes down LLM access for
every caller simultaneously, not just one. A second, subtler failure
mode is **quota starvation between callers**: if per-caller quotas
aren't enforced, or aren't enforced correctly under concurrent load, one
caller's burst can exhaust a shared provider-level rate limit and cause
unrelated callers' requests to fail even though those callers never
went over their own budget — the isolation the gateway is supposed to
provide breaks down exactly under the load spikes it exists to guard
against.

**LLM gateway vs. semantic caching.** These two patterns are frequently
deployed together but solve different problems. The gateway's job is
routing, credentialing, and metering — it decides *which provider*
handles a request and *whether the caller is allowed* to make it at
all; it says nothing about whether the request needs to reach a
provider in the first place. [Semantic Caching](/docs/patterns/ai-infra/semantic-caching)
is the piece that can avoid the provider call entirely for a
semantically repeated prompt. Because the gateway already sees every
prompt before it's forwarded, it's the natural place to implement
semantic caching as a policy — check the cache first, and only run the
routing/failover logic above if the cache misses — rather than building
caching separately into each calling service.

## Code example

```rust
use std::collections::HashMap;

#[derive(Debug, PartialEq)]
enum GatewayError {
    QuotaExceeded,
    AllProvidersUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ProviderHealth {
    Available,
    Down,
}

struct Provider {
    name: &'static str,
    health: ProviderHealth,
}

struct CallerQuota {
    tokens_used_this_window: u64,
    token_limit: u64,
}

struct LlmGateway {
    // Ordered by preference — first available provider wins.
    providers: Vec<Provider>,
    quotas: HashMap<String, CallerQuota>,
}

#[derive(Debug)]
struct RoutedRequest {
    provider_name: &'static str,
    fell_back: bool,
}

impl LlmGateway {
    // Enforces the caller's quota first — a caller already over budget
    // shouldn't consume provider capacity at all — then walks the
    // provider list in preference order and returns the first healthy
    // one, recording whether this was a fallback away from the primary.
    fn route(&mut self, caller_id: &str, estimated_tokens: u64) -> Result<RoutedRequest, GatewayError> {
        let quota = self.quotas.get_mut(caller_id).ok_or(GatewayError::QuotaExceeded)?;
        if quota.tokens_used_this_window + estimated_tokens > quota.token_limit {
            return Err(GatewayError::QuotaExceeded);
        }

        for (index, provider) in self.providers.iter().enumerate() {
            if provider.health == ProviderHealth::Available {
                quota.tokens_used_this_window += estimated_tokens;
                return Ok(RoutedRequest { provider_name: provider.name, fell_back: index > 0 });
            }
        }

        Err(GatewayError::AllProvidersUnavailable)
    }
}
```

`route` checks the caller's quota before touching the provider list at
all, so an over-budget caller is rejected without consuming any
provider capacity — and `fell_back` is derived from the winning
provider's position in the preference list, giving the caller a signal
that a failover happened without ever having to specify a provider
itself.

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

## Use-case scenarios

**Enterprise SaaS platform with per-customer LLM features.** A B2B SaaS
product exposes AI-assisted features (summarization, drafting
suggestions) across several product surfaces, each built by a different
internal team. The gateway enforces a token quota per paying customer
rather than per calling service, so a single customer's heavy usage on
one feature is correctly counted against that customer's plan limit
regardless of which internal service happened to make the call — a
constraint that would be nearly impossible to enforce consistently if
each team called the provider directly with its own logic.

**Multi-provider redundancy for a customer-support chatbot.** A support
chatbot embedded in a company's product needs to stay available even
during a single LLM provider's regional outage, since a support
channel going down during an incident is reputationally costly. The
gateway is configured with a primary provider and a secondary provider
from a different vendor entirely; when the primary starts returning
elevated error rates, the gateway fails over automatically, and the
chatbot's own code never branches on which provider actually answered
the request.

**Regulated-industry audit trail for AI-assisted decisions.** A
healthcare or financial-services company uses an LLM to draft
suggested responses that a human reviews before anything reaches a
customer, and compliance requires a durable record of every prompt and
generated draft for later audit. Because every request from every
internal service already passes through the gateway, prompt/response
logging is implemented once at the gateway layer with a single
retention and access-control policy, rather than trusting each of the
company's several AI-feature teams to independently implement
compliant logging correctly.

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
