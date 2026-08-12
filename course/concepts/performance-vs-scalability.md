---
title: "Performance vs Scalability"
sidebar_position: 4
---

A service is **scalable** if it results in increased **performance** in a manner proportional to resources added. Generally, increasing performance means serving more units of work, but it can also be to handle larger units of work, such as when datasets grow.<sup><a href="http://www.allthingsdistributed.com/2006/03/a_word_on_scalability.html">1</a></sup>

Another way to look at performance vs scalability:

* If you have a **performance** problem, your system is slow for a single user.
* If you have a **scalability** problem, your system is fast for a single user but slow under heavy load.

### Source(s) and further reading

* [A word on scalability](http://www.allthingsdistributed.com/2006/03/a_word_on_scalability.html)
* [Cascading Failures](/docs/patterns/reliability/cascading-failures) — this course's condensed walkthrough of Google's SRE book chapter on exactly this failure mode: how a system that's fast for one user degrades under load, and the load-shedding, queue-management, deadline-propagation, and circuit-breaking techniques that prevent it.
* [CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html) — Martin Fowler's canonical explanation of the circuit-breaker pattern for containing failures instead of letting them cascade under load.
