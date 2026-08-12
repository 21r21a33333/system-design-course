---
title: "Operating Systems"
sidebar_position: 0
description: An interview-focused operating-systems track — virtualization, concurrency, and persistence — with the must-know algorithms implemented in C, conceptual interview questions, and the coding problems interviewers actually ask.
---

# Operating Systems

An operating system does three things, and everything else is detail: it **virtualizes** the hardware (so each program thinks it has its own CPU and memory), it manages **concurrency** (so many things can happen at once without corrupting each other), and it provides **persistence** (so data survives crashes and power loss). This track is organized around exactly those three pieces — the framing of Remzi and Andrea Arpaci-Dusseau's freely available [_Operating Systems: Three Easy Pieces_](https://pages.cs.wisc.edu/~remzi/OSTEP/) — plus **distribution** (how OS ideas extend across a network) and **security**.

:::note How this track is built
These notes are original explanations grounded in OSTEP (free online) and primary sources (Linux `man` pages, classic papers). Every page is written for **interview preparation**, so each carries three things beyond the concept:

- **Must-know algorithms** — the classic OS algorithms (schedulers, page-replacement policies, allocators, lock designs, disk scheduling, sync primitives) implemented as complete, compile-tested **C** programs.
- **Interview questions** — the conceptual "explain X" questions asked in systems and MAANG-style interviews, with concise model answers.
- **Coding problems** — the algorithmic problems interviewers actually give (LRU cache, producer–consumer, dining philosophers, thread-safe structures, …) with links and reference code.
:::

## The three pieces (and two more)

- **Virtualization · CPU** — processes and the process API, limited direct execution, and CPU scheduling (FIFO/SJF/STCF/RR, MLFQ, lottery/stride, multiprocessor).
- **Virtualization · Memory** — address spaces, translation, segmentation, free-space management, paging, TLBs, multi-level page tables, and swapping (page-replacement policies).
- **Concurrency** — threads, locks, lock-based data structures, condition variables, semaphores, deadlock, and event-based concurrency.
- **Persistence** — I/O devices, disks and disk scheduling, RAID, files and directories, file-system implementation, FFS, journaling & crash consistency, LFS, SSDs, and data integrity.
- **Distribution** — distributed systems and RPC, NFS, and AFS.
- **Security** — authentication, access control, and cryptography.

Start with **Processes** under Virtualization · CPU, or jump to any topic from the sidebar.
