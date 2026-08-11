---
title: "Design YouTube (or a Video-Sharing Platform)"
sidebar_position: 12
---

A video platform's defining constraint is different from a photo or text feed: the content itself isn't servable the moment it's uploaded. A raw video file has to go through a processing pipeline before it can be watched by anyone, and once it can be watched, delivering it efficiently dominates the system's total cost and traffic far more than any single photo or message ever would.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design YouTube" module, including a dedicated "TikTok System Design (Mock Interview)" sub-lesson.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** uploads a video with a title, description, and thumbnail
* **Service** processes the upload into multiple resolutions/bitrates so it can be streamed to different devices and network conditions
* **User** watches a video, with playback that adapts to their connection speed
* **User** views a channel's list of uploaded videos
* **User** searches for videos by keyword
* **Service** tracks view counts
* **Service** has high availability; video playback should degrade gracefully (lower quality) rather than fail outright under poor network conditions

#### Out of scope

* Recommendation/personalized ranking (worth naming as a large system of its own, not designed here)
* Live streaming (fundamentally different pipeline — no "process before serving" step; mentioned briefly as a talking point)
* Comments, likes, subscriptions beyond a brief mention
* Monetization/ads

### Constraints and assumptions

#### State assumptions

* 50 million daily active viewers, plus a much smaller population of uploaders — this is an extremely upload-light, view-heavy system, more skewed than a typical social feed
* Average viewer watches 5 videos/day; a small fraction of users (1 in ~2,000 daily viewers) uploads a video on a given day
* Average uploaded video: 10 minutes long, ~500 MB as originally uploaded (varies hugely in practice, but a fixed average is fine for estimation)
* Each uploaded video needs to be transcoded into several resolution/bitrate renditions (for example, a handful of resolution tiers) to support adaptive playback across devices and network conditions
* Processing a video (transcoding into all renditions) is expected to take meaningfully longer than real-time relative to the video's length, and is explicitly NOT expected to complete synchronously with upload — a short delay between "upload finished" and "video is watchable" is acceptable
* Playback should start within roughly one to two seconds of pressing play, and should degrade in quality under poor network conditions rather than stall
* View counts do not need to be exact in real time; approximate, eventually-accurate counts are fine

#### Calculate usage

* Uploads/day: 50,000,000 daily viewers / 2,000 ≈ **25,000 uploads/day** → 25,000 / 86,400 ≈ **~0.3 uploads/sec average** — genuinely low volume; uploads are not the bottleneck anywhere in this design
* Raw upload storage: 25,000 uploads/day × 500 MB ≈ **~12.5 TB/day** of raw uploaded video, **~4.6 PB/year** before any transcoded renditions are counted
* Transcoded storage multiplier: producing several rendition tiers per video typically adds up to roughly 1.5-2x the size of the original file in total (lower resolutions are much smaller, but there are several of them) — so total stored video (original + all renditions) is conservatively **~2x raw upload volume**: ~4.6 PB/year raw × ~2 ≈ **~9.2 PB/year total stored video**
* View/playback volume: 50,000,000 viewers × 5 videos/day = **250 million video plays/day** → 250,000,000 / 86,400 ≈ **~2,900 plays/sec average**, peaking (evenings, weekends) at perhaps 4-5x average, so **~12,000-15,000 plays/sec at peak**
* Bandwidth is the number that actually matters most here, not request count: even at a conservative ~2 Mbps average per active stream (mixed resolutions, most viewers not on the highest tier), 15,000 concurrent-ish plays at peak implies tens of gigabits/sec of sustained egress bandwidth at peak — this single number is why CDN delivery isn't an optimization for this system, it's a structural requirement from day one
* Metadata per video (`video_id`, `title`, `description`, `uploader_id`, `duration`, `rendition_urls`, `view_count`, `created_at`) is on the order of 1-2 KB — utterly dwarfed by the video bytes themselves and never the storage bottleneck

## Step 2: Create a high-level design

![YouTube high-level architecture](/img/case-studies/youtube-overview.svg)

An upload goes to an **ingest service**, which stores the raw file in **blob storage** and immediately hands off to an asynchronous **transcoding pipeline** — the video is not watchable yet at this point, and the design deliberately does not try to make it watchable synchronously. The pipeline produces multiple resolution/bitrate renditions, writes them back to blob storage, and once at least one rendition is ready, marks the video as watchable in the **video metadata store**. Playback requests never go anywhere near the transcoding pipeline or the origin blob storage directly in the common case — they're served through a **CDN**, with the origin only involved on a cache miss. A separate **search/discovery service** indexes video metadata for keyword search, and a **view-count service** handles the high-frequency, low-value-per-event work of counting plays.

The structural difference from a photo feed is worth stating plainly up front: Instagram's design (elsewhere in this course) is dominated by a fan-out problem — getting a lightweight reference to already-servable content into the right feeds. This design's hardest problem happens *before* fan-out or feed concerns even apply — a video is unwatchable, full stop, until an asynchronous, resource-intensive pipeline finishes with it. Delivery, once a video is ready, is dominated by raw bandwidth economics rather than by the read-fanout-to-many-followers problem a feed has.

## Step 3: Design core components

### Use case: User uploads a video

* Client uploads the raw file, typically chunked/resumable given file sizes and mobile network reliability, to **blob storage**
* The **ingest service** writes an initial metadata row with status `processing` and publishes a "video uploaded" event
* The transcoding pipeline (below) consumes that event
* Once processing completes (or, better, once the first usable rendition is ready), the metadata row is updated to status `ready`, and the video becomes visible to the uploader's channel and to search

Returning success to the uploader as soon as the raw bytes are durably stored — not once processing finishes — matters for the same reason it mattered in the Instagram design: the slow, resource-heavy part of the pipeline shouldn't sit on the critical path of the interaction the user is actually waiting on. Unlike Instagram's image resizing, though, this asynchronous gap is not a cosmetic few-hundred-millisecond delay — a 10-minute video's transcoding can reasonably take minutes, so the product experience has to explicitly account for "your video is processing" as a real, visible state, not something papered over by a fast background job.

### Use case: Service transcodes an uploaded video

The hard problem: a single 10-minute upload transcoded serially into several renditions could take longer than the video itself to process — the pipeline needs to parallelize the work of *one* video across many machines, not just parallelize across different videos.

**Core spec: batch/pipeline — DAG-based parallel chunked transcoding**

The key idea is to split the source video into independent time-segments *before* transcoding, so each segment's work can be scheduled onto a different worker and run concurrently, then reassembled after. The dependency graph is a DAG: many independent chunk-encode tasks fan out from one "split" step, then fan back into one "stitch" step per rendition.

```python
class TranscodingCoordinator(MRJob):
    """Splits an uploaded video into fixed-length chunks, transcodes
    each chunk independently (in parallel, across workers) for every
    target rendition, then reassembles each rendition from its chunks.

    This is structured as a map/reduce-shaped DAG rather than a single
    long-running per-video job specifically so a 10-minute upload's
    transcoding wall-clock time is bounded by one chunk's processing
    time, not the full video's length.
    """
    CHUNK_SECONDS = 600  # 10-minute chunks
    RENDITIONS = ["1080p", "720p", "480p", "240p"]

    def split_into_chunks(self, video_id, duration_seconds):
        """Emit one independent unit of work per (chunk, rendition) pair.

        Example: a 32-minute upload -> 4 chunks (0-10, 10-20, 20-30,
        30-32 min) x 4 renditions = 16 independent tasks, all schedulable
        in parallel across the worker fleet with no cross-task ordering
        dependency.
        """
        num_chunks = (duration_seconds + self.CHUNK_SECONDS - 1) // self.CHUNK_SECONDS
        for chunk_index in range(num_chunks):
            start = chunk_index * self.CHUNK_SECONDS
            end = min(start + self.CHUNK_SECONDS, duration_seconds)
            for rendition in self.RENDITIONS:
                yield (video_id, rendition), (chunk_index, start, end)

    def mapper(self, _, chunk_task):
        """One worker's unit of work: encode a single time-segment into
        a single rendition. Independent of every other chunk/rendition
        pair, which is exactly what makes it safe to run in parallel.

        (video_id, "720p"), (chunk_index=2, start=1200, end=1800)
          -> (video_id, "720p"), (chunk_index=2, chunk_uri="s3://.../chunk_2_720p.ts")
        """
        (video_id, rendition), (chunk_index, start, end) = chunk_task
        chunk_uri = self.encode_segment(video_id, rendition, start, end)  # invokes ffmpeg
        yield (video_id, rendition), (chunk_index, chunk_uri)

    def reducer(self, key, chunk_results):
        """Reassemble one rendition from its completed chunks, once
        every chunk for that rendition has finished. Reduction is
        per-rendition, not per-video, so a 1080p rendition being slow
        never blocks the 240p rendition from finishing and becoming
        watchable first.

        (video_id, "720p"), [(0, uri0), (1, uri1), (2, uri2)]
          -> (video_id, "720p"), "s3://.../video_full_720p.mp4"
        """
        video_id, rendition = key
        ordered_chunks = [uri for _, uri in sorted(chunk_results)]
        final_uri = self.concatenate_segments(ordered_chunks)
        yield (video_id, rendition), final_uri
```

* A **coordinator** runs `split_into_chunks` and places every `(chunk, rendition)` task onto a work queue — for the earlier back-of-envelope's average 10-minute video, that's already one chunk per rendition tier; a 40-minute video becomes 4x that many independent, schedulable units
* A fleet of **transcoding workers** pulls tasks and runs the `mapper` step — this is compute-intensive, and unlike almost everything else in this design, it's CPU/GPU-bound rather than I/O-bound, so the worker fleet scales on a completely different axis (compute capacity) than the rest of the system. [FFmpeg](https://ffmpeg.org/) is the widely-used real-world tool for the actual encode step underlying a worker like this, and its wide codec and container support is a large part of why it's such a common building block for this exact stage of a video pipeline
* The `reducer` step runs once all of a rendition's chunks are done, stitching them into that rendition's final file; the video becomes watchable as soon as *one* rendition (typically the lowest tier) finishes reducing, not once every rendition is done

**Data structures:**
* `transcode_tasks`: `video_id`, `chunk_index`, `rendition`, `status` (`pending`/`in_progress`/`done`/`failed`), `worker_id`, `chunk_uri` — the DAG's per-task state, queryable to know exactly how much of a video is done
* `video_renditions`: `video_id`, `rendition`, `status`, `final_uri` — one row per rendition, updated by the reducer step

**Trade-offs:**
* **The gotcha:** chunking a video for parallel transcoding isn't free — most modern video codecs compress *between* frames (a frame is encoded as a delta from nearby frames), so an arbitrary byte-offset split can cut through the middle of a dependent frame sequence and produce a corrupt or visually broken chunk boundary. The fix is to only split at existing keyframe boundaries (frames that don't depend on neighboring frames), which means chunk length isn't perfectly uniform — it's "the next keyframe after the target chunk boundary," not an exact wall-clock cut. This is the detail that separates "will this actually produce a correct video when reassembled" from a naive fixed-offset split that looks fine until playback hits a chunk seam.
* If a worker crashes mid-task, the task needs to be retried by another worker rather than lost — a natural fit for [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) pulling from a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue), where an unacknowledged task becomes visible again for another worker to pick up. Because tasks are chunk-scoped, not video-scoped, a retry only redoes a few minutes of work, not the whole video.
* Structuring the whole thing as [Pipes and Filters](/docs/patterns/building-blocks/pipes-and-filters) — independent, composable stages (split, per-chunk encode, per-rendition stitch, thumbnail extraction) rather than one monolithic job — makes it possible to retry or scale one stage without re-running the others, and to add a new rendition tier later without redesigning the pipeline.
* This pipeline is also the part of the system where cost is most directly proportional to work done (compute-seconds per video, roughly proportional to video length and rendition count), which is worth mentioning as a real operational concern distinct from the storage and bandwidth costs elsewhere in the design.

### Use case: User watches a video

The hard problem here isn't computing anything — it's a wire-format problem: the client needs to know which renditions exist and where their segments live, in a format it can adapt against in real time as network conditions change.

**Core spec: adaptive bitrate manifest (HLS)**

* Client requests the video's manifest from the metadata/playback service
* [HLS](https://en.wikipedia.org/wiki/HTTP_Live_Streaming) (or [MPEG-DASH](https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP)) is the real, widely-deployed wire format that defines exactly this segmented-rendition-plus-manifest shape; a master `.m3u8` playlist lists each available rendition and its bandwidth, and each rendition has its own child playlist listing that rendition's individual segment files:

```
# master.m3u8 -- lists every available rendition
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480
480p/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=426x240
240p/rendition.m3u8

# 720p/rendition.m3u8 -- lists that rendition's individual segments
#EXTM3U
#EXT-X-TARGETDURATION=10
#EXTINF:10.0,
segment_000.ts
#EXTINF:10.0,
segment_001.ts
#EXTINF:10.0,
segment_002.ts
#EXT-X-ENDLIST
```

* The client parses the master playlist, starts at a lower-bitrate rendition to minimize start-up delay, and switches which child playlist it pulls segments from as it observes its own download speed — this adaptive-bitrate decision logic lives entirely client-side; the server's job is only to have every rendition correctly segmented and the manifests accurate
* Segments are fetched from the **CDN** edge nearest the viewer; only on a cache miss does the request fall through to origin blob storage

**Data structures:** no new server-side storage beyond the `video_renditions` table above — the manifest is generated (or regenerated once, then cached) from that table's rows, one `#EXT-X-STREAM-INF` line per completed rendition.

**Trade-offs:**
* This is the delivery-side counterpart to the transcoding pipeline's production-side complexity: because the pipeline already did the expensive work of producing multiple renditions and correctly segmenting them ahead of time, playback itself is a comparatively simple, mostly-static-file-serving problem, which is exactly what makes it so effectively cacheable. See [CDN](/docs/patterns/building-blocks/cdn) for the general mechanism — the key point specific to video is that popular content's *entire working set* (all renditions of a small number of very popular videos) can often be kept resident at CDN edges, since video traffic tends to follow a strong popularity skew where a small fraction of the catalog accounts for a large fraction of total plays.
* A manifest listing a rendition that isn't actually finished yet would cause playback to fail mid-switch — the manifest generation step has to only include renditions the `video_renditions` table marks as `done`, which is a small but easy-to-miss correctness dependency between the transcoding pipeline's write path and the playback manifest's read path.

### Use case: User searches for videos, service tracks view counts

Search indexes title, description, and (optionally) transcript text against an inverted index — the same general mechanism described in [Distributed Search](/docs/patterns/building-blocks/distributed-search), of the kind Elasticsearch or OpenSearch implement as off-the-shelf systems — updated asynchronously off the same "video uploaded / video ready" event stream the transcoding pipeline already consumes, rather than being a separate ad hoc integration. Same REST shape as any keyword search: `GET /api/v1/search?q=...&limit=20`, returning a ranked list of `video_id`/title/thumbnail results — a "same shape as X" case, not worth a separate example here.

View counts follow the same reasoning as Instagram's like counts: extremely high write frequency concentrated on a small number of popular videos, tolerant of a brief lag before the displayed number is exact. A [Sharded Counter](/docs/patterns/building-blocks/sharded-counters) absorbs concurrent increments without one row becoming a bottleneck on a video that's currently trending, with the displayed count refreshed from a periodic aggregate rather than summed on every single page view.

## Step 4: Scale the design

![YouTube scaled architecture](/img/case-studies/youtube-scaled.svg)

**Delivery bandwidth, not request count, is the dominant scaling concern**, and it's addressed almost entirely by the [CDN](/docs/patterns/building-blocks/cdn) layer rather than by scaling application servers — this is a meaningfully different scaling story than most of this course's other case studies, where the application/database tier is usually the thing under the most pressure. Given this design's back-of-envelope tens-of-gigabits/sec peak egress figure, the origin infrastructure only ever needs to sustain a small fraction of total traffic — cache-miss traffic for unpopular or newly-published content — as long as CDN cache hit rates stay high for the popular-content majority.

**The transcoding pipeline scales on compute capacity, independently of everything else**, since it's CPU/GPU-bound rather than I/O-bound. [Auto-Scaling](/docs/patterns/scaling/auto-scaling) the worker fleet based on queue depth (how many pending transcoding tasks are waiting) rather than a fixed pool size matters because upload volume is genuinely bursty (this design's ~0.3 uploads/sec average hides real peaks around, for example, creator posting patterns) and idle transcoding capacity is pure wasted cost, unlike a stateless web tier that's cheap to over-provision.

**Popularity skew argues for tiered rendition strategy, not just tiered storage.** A video that never gets watched twice doesn't need every resolution tier pre-generated eagerly — a reasonable refinement is to always produce a couple of baseline renditions synchronously-enough-to-publish, and generate higher tiers or alternate formats lazily, on first request, for the long tail of rarely-watched content. This trades a slightly slower first play of an unpopular video for meaningfully less wasted transcoding compute and storage across the full catalog — worth raising explicitly as a cost-vs-latency tradeoff rather than transcoding everything eagerly by default.

**The video metadata store scales conventionally** — sharded by `video_id`, with [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) for the read-heavy metadata lookups that accompany every playback request (fetching the manifest, checking availability) — this part of the design looks similar to the metadata stores in the other case studies in this course, since metadata itself is small and not the bottleneck here.

**Multi-region placement is driven by both compute and delivery locality.** Transcoding can reasonably happen in a single region near where the raw upload landed (it's not latency-sensitive to the viewer), but CDN edge presence needs to be close to viewers globally — the two halves of this system have almost opposite geographic requirements, which is worth calling out as a deliberate asymmetry rather than an oversight.

## Additional talking points

* **The "watchable before fully processed" design decision** (making the video available once a baseline rendition is ready, rather than waiting for every rendition tier) is a genuine latency/completeness tradeoff worth defending explicitly: it gets content live faster at the cost of some viewers briefly getting fewer quality options than they'll have a few minutes later.
* **Live streaming is a fundamentally different problem, worth naming even though it's out of scope**: there's no "process before serving" step to hide latency behind, since the content doesn't exist yet — the transcoding pipeline described here becomes a real-time, low-latency pipeline instead of a batch job, and adaptive delivery has to happen against a moving target instead of a fixed set of pre-generated segments.
* **Thumbnail generation is a small piece of the pipeline but has an interesting wrinkle**: producing several candidate thumbnails (frames at different timestamps) and letting the uploader pick, or auto-selecting one, is a good example of a pipeline stage that's cheap and fast (extract a handful of frames) riding alongside stages that are expensive and slow (full transcodes) within the same job — worth mentioning as a reason not to model the whole pipeline as uniformly expensive.
* **View-count integrity vs. approximate counting** is a good tension to raise: the sharded-counter approach optimizes for throughput and tolerates eventual accuracy, but a platform also cares about *not* counting bot/replay traffic — worth a brief mention that the counting mechanism and the anti-abuse/validity-filtering logic are two separate concerns layered together, not the same problem.

## Source(s) and further reading

* [HTTP Live Streaming — Wikipedia](https://en.wikipedia.org/wiki/HTTP_Live_Streaming) — background on the HLS format this design's manifest example is drawn from
* [RFC 8216: HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216) — the formal specification defining the `.m3u8` playlist syntax used in this use case's manifest example
* [HTTP Live Streaming — Apple Developer Documentation](https://developer.apple.com/documentation/http-live-streaming) — the format's originating vendor documentation, with authoring guides for real manifests
* [Dynamic Adaptive Streaming over HTTP (MPEG-DASH) — Wikipedia](https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP) — the vendor-neutral alternative to HLS for the same segmented-rendition-plus-manifest shape
* [FFmpeg](https://ffmpeg.org/) — the widely-used real-world encoding tool underlying the transcoding workers in this design's pipeline
* [Pipes and Filters](/docs/patterns/building-blocks/pipes-and-filters) — the general pattern this design's chunked transcoding DAG is structured as
