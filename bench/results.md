# Missed edges, measured

repo-atlas 0.6.0. Written by `pnpm bench`; do not edit by hand.

For each repository, at the commit in [`repos.json`](repos.json), every call and every cross-file use that a compiler resolves to a declaration inside the repository is looked up in the graph. A call counts as found when the graph has a `calls` edge from the calling file to that function, method or class. "Calls to symbols" leaves out the targets the graph never makes a symbol of by design (a function inside a function, a method of an object literal, an interface method in Go). Nothing in the repositories is installed, built or run, so a call the compiler cannot resolve without the dependencies is not in the count.

## TypeScript / JavaScript

Against the TypeScript compiler (typescript 6.0.3).

| Repository | Commit | Files | Imports | Calls | Calls to symbols |
| --- | --- | ---: | ---: | ---: | ---: |
| [express](https://github.com/expressjs/express) | `43fca52` | 142 | 154 / 154 (100.0%) | 147 / 178 (82.6%) | 147 / 150 (98.0%) |
| [got](https://github.com/sindresorhus/got) | `6b5aafc` | 96 | 308 / 309 (99.7%) | 534 / 791 (67.5%) | 534 / 627 (85.2%) |
| [hono](https://github.com/honojs/hono) | `75ff8e3` | 458 | 1,049 / 1,049 (100.0%) | 1,243 / 1,724 (72.1%) | 1,243 / 1,405 (88.5%) |
| [swr](https://github.com/vercel/swr) | `8148ef0` | 262 | 279 / 279 (100.0%) | 381 / 528 (72.2%) | 381 / 381 (100.0%) |
| [trpc](https://github.com/trpc/trpc) | `596d03d` | 1,461 | 3,260 / 3,265 (99.8%) | 4,005 / 5,240 (76.4%) | 4,005 / 4,316 (92.8%) |
| [umami](https://github.com/umami-software/umami) | `aad2c4c` | 1,514 | 5,177 / 5,177 (100.0%) | 5,922 / 6,381 (92.8%) | 5,922 / 6,007 (98.6%) |
| [full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) | `77e550a` | 108 | 294 / 294 (100.0%) | 429 / 470 (91.3%) | 429 / 430 (99.8%) |
| **All** | | 4,041 | 10,521 / 10,527 (99.9%) | **12,661 / 15,312 (82.7%)** | 12,661 / 13,316 (95.1%) |

## Java

Against javac (openjdk version "21.0.11" 2026-04-21).

| Repository | Commit | Files | Class uses | Calls | Calls to symbols |
| --- | --- | ---: | ---: | ---: | ---: |
| [commons-lang](https://github.com/apache/commons-lang) | `5a1545b` | 647 | 1,763 / 1,784 (98.8%) | 5,149 / 5,395 (95.4%) | 5,149 / 5,376 (95.8%) |
| [gson](https://github.com/google/gson) | `7fc4d18` | 268 | 1,332 / 1,344 (99.1%) | 2,820 / 2,901 (97.2%) | 2,820 / 2,873 (98.2%) |
| [jsoup](https://github.com/jhy/jsoup) | `d90d575` | 216 | 1,416 / 1,432 (98.9%) | 4,945 / 5,327 (92.8%) | 4,945 / 5,316 (93.0%) |
| [spring-petclinic](https://github.com/spring-projects/spring-petclinic) | `500158f` | 50 | 91 / 92 (98.9%) | 169 / 172 (98.3%) | 169 / 172 (98.3%) |
| **All** | | 1,181 | 4,602 / 4,652 (98.9%) | **13,083 / 13,795 (94.8%)** | 13,083 / 13,737 (95.2%) |

## Go

Against the Go type checker (go version go1.27.4 darwin/arm64).

| Repository | Commit | Files | Package uses | Calls | Calls to symbols |
| --- | --- | ---: | ---: | ---: | ---: |
| [gin](https://github.com/gin-gonic/gin) | `0f09c3a` | 99 | 48 / 48 (100.0%) | 823 / 951 (86.5%) | 823 / 893 (92.2%) |
| [cobra](https://github.com/spf13/cobra) | `adbc881` | 36 | 13 / 13 (100.0%) | 466 / 516 (90.3%) | 466 / 516 (90.3%) |
| [miniflux](https://github.com/miniflux/v2) | `eea1ec7` | 441 | 1,116 / 1,116 (100.0%) | 3,436 / 3,715 (92.5%) | 3,436 / 3,706 (92.7%) |
| [pocketbase](https://github.com/pocketbase/pocketbase) | `7f2773e` | 461 | 1,155 / 1,155 (100.0%) | 3,956 / 5,212 (75.9%) | 3,956 / 4,503 (87.9%) |
| **All** | | 1,037 | 2,332 / 2,332 (100.0%) | **8,681 / 10,394 (83.5%)** | 8,681 / 9,618 (90.3%) |

Rust, Ruby and Python have no such measurement: a compiler's answer for them needs the dependencies built or a type checker installed. The README gives hand-read samples for Rust and Ruby.
