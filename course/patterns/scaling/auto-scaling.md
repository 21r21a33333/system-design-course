---
title: "Auto-Scaling"
sidebar_position: 3
supplementary: true
---

Auto-scaling automatically adjusts the number of running instances of a
service in response to a measured signal — CPU utilization, queue depth,
request rate — compared against defined thresholds, instead of an
operator manually resizing the fleet.

## Problem it solves

A fleet sized for peak load wastes money running idle capacity most of
the time; a fleet sized for average load falls over during traffic
spikes. Manually watching dashboards and adding or removing instances by
hand doesn't scale (literally) — it's too slow to react to sudden
spikes and too labor-intensive to do continuously. Auto-scaling closes
that loop: the system observes its own load and adjusts capacity itself,
within bounds an operator sets once.

## How it works

A controller continuously (or periodically) evaluates a chosen metric
against a target or threshold — for example, "keep average CPU at 60%"
or "keep queue depth under 1,000 messages." When the metric crosses the
threshold, the controller changes the desired instance count: launching
new instances to add capacity, or terminating instances to shed excess
capacity, within a configured minimum and maximum. Most implementations
also apply cooldown periods or stabilization windows so a single noisy
metric reading doesn't trigger repeated flapping between scale-up and
scale-down.

There are two broad strategies. Reactive (metric-threshold) scaling
responds to what's happening right now — it's simple and requires no
forecasting, but by definition it can't add capacity until load has
already risen, so there's a lag between demand increasing and new
capacity coming online. Predictive scaling instead forecasts expected
load (from historical patterns or scheduled events) and provisions
capacity ahead of time, trading forecasting complexity and the risk of a
bad prediction for the ability to have capacity ready before it's needed.

## When to use it

- Load is variable — daily/weekly traffic cycles, unpredictable spikes,
  or batch workloads with bursty queue depth — and a fixed fleet size
  would mean either wasted spend or under-provisioning.
- The workload is horizontally scalable (stateless, or backed by a
  partitioned store), so adding or removing instances is safe and
  effective.
- Cost efficiency matters and there's tolerance for a short ramp-up
  delay while new capacity comes online.

## When not to use it

- The workload can't shed or gain capacity quickly enough to matter —
  instances that take many minutes to boot and warm up (e.g. loading a
  large in-memory dataset) may finish scaling up only after the spike
  that triggered it has already passed, this cold-start latency
  cost being the main risk of reactive auto-scaling.
- Load is flat and predictable — a fixed, right-sized fleet is simpler
  and has one less moving part to misconfigure.
- The service isn't horizontally scalable at all (a single stateful
  primary), in which case auto-scaling the instance count doesn't apply;
  vertical scaling or a different architecture is needed instead.

## Real-world example

AWS EC2 Auto Scaling Groups let an operator define a minimum, maximum,
and desired instance count, plus scaling policies tied to metrics like
average CPU utilization; the group launches or terminates instances to
track the target. The Kubernetes Horizontal Pod Autoscaler applies the
same idea at the pod level inside a cluster, adjusting the replica count
of a Deployment based on observed CPU, memory, or custom metrics against
a target value.

## Related patterns

- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) —
  auto-scaling is the automated mechanism for growing and shrinking a
  horizontally scaled fleet; it assumes the fleet is already stateless
  or partitioned enough to add and remove instances safely.

## Further reading

- [What is Amazon EC2 Auto Scaling? — AWS documentation](https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html)
- [Autoscaling guidance — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/auto-scaling)
