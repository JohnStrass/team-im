# team-im protocol v2.1 — file attachments

**Status:** spec for implementation, 2026-08-09.
**Author:** client-author. **Server implementation:** server-owner (owns `server.py`).
**Clients:** client-author (Electron + browser). **Gate:** reviewer-a. **Independent
verification:** second-impl / reviewer-b.

Additive to v2. A v1 or v2.0 client ignores the new field and keeps working.

---

## 1. The four constraints this design answers

Read these before the wire format; every odd-looking choice below comes from one
of them.

1. **The room has no authentication.** `from` is a caller-asserted label. Anything
   that can reach port 8765 can upload. So every limit has to be a server-side
   limit, not a client-side one.
2. **`chat-log.jsonl` is the permanent record and must stay text.** Attachments are
   referenced by hash and never inlined as base64. Inlining would bloat the log
   past the point where a client can load it and would put binary in the one file
   that has to stay greppable.
3. **Uploads are served from the same origin as the web client.** An uploaded
   `.html` or `.svg` opened inline executes script against the room. This is the
   single most dangerous part of the feature.
4. **A filename is attacker-controlled input.** It never touches the filesystem.

---

## 2. Storage

Content-addressed, and the stored name is derived entirely from the bytes:

```
<server dir>/files/<sha256>.bin
```

Always `.bin`, for every upload, whatever it is. The filesystem therefore never
sees a user-supplied extension, which removes extension-confusion and traversal
as a class rather than filtering for them. The display name lives in the message
record, where it is data.

Deduplication is free: the same bytes are the same path.

`files/` must be excluded from the GitHub publish path and from any scrub
tooling, alongside `chat-log.jsonl`.

---

## 3. `POST /upload`

**Raw body, not multipart.** Python 3.13 removed `cgi`, and hand-rolling a
multipart parser is a larger attack surface than the feature deserves.

| Header | Required | Meaning |
|---|---|---|
| `Content-Length` | yes | Reject if absent. Enforce before reading the body. |
| `Content-Type` | no | Advisory only. Never trusted, never stored, never echoed on download. |

**There is no `X-Filename`, as of revision 2.** The first draft had one, sanitised
it, and then never stored or returned it — server-owner and second-impl both
caught that independently. Worse than dead code: the display name would then have
been carried and validated in *two* places, across four independent
implementations, with nothing saying which wins when they disagree.

**One carrier, one validation: the name lives only in `attachments[].name` on
`POST /send`.** Upload is purely bytes in, hash out.

**Server behaviour**

1. Reject a missing, malformed or negative `Content-Length`, and any transfer
   encoding you are not prepared to handle. Reject `Content-Length` >
   `MAX_UPLOAD_BYTES` (**25 MiB**) with **413**, **without reading the body**.
2. **Do NOT reserve the declared bytes against the committed-store quota.**
   Account in-flight temp bytes under a **separate** bounded
   `MAX_INFLIGHT_BYTES` budget; reject with **507** when that is exhausted.

   **A sequential check is not a guarantee** (reviewer-a): revision 2 compared
   `files/` total + this upload with no reservation, so two concurrent uploads
   could both observe the same free space, both pass, and jointly exceed the cap.
   Sequential 507 tests cannot falsify that.

   **But revision 3's fix contradicted its own duplicate rule**, and that one was
   mine: it permitted reserving declared bytes against `MAX_FILES_BYTES` *before*
   hashing, while also requiring a duplicate upload to succeed at capacity. Both
   cannot hold — at 100% the pre-hash reservation returns 507 before the server
   can compute the digest and discover the upload adds zero bytes. Two rules
   added in the same revision, mutually exclusive, and I did not notice.

   Separating the two budgets makes the concurrency guarantee and the
   duplicate-at-capacity rule satisfiable at the same time.
3. Stream the body in **bounded chunks** to a temp file in the same directory,
   hashing as you go. Read exactly `Content-Length` bytes; trust neither a short
   nor a long stream. **Remove the temp and release the reservation on short
   read, disconnect, or any exception** — a leaked reservation shrinks the quota
   permanently.
4. **After hashing**, enter the §6a lifecycle critical section and decide there:
   if the digest already exists, **renew its grace lease** and return
   `existing: true`; otherwise enforce
   `committed_total + actual_size <= MAX_FILES_BYTES`, then rename and commit.
   The quota is enforced against the **actual** size, which is only known after
   hashing — that is why the decision cannot happen before the read.

   `fsync` the temp, atomically rename to `files/<sha256>.bin`, then **`fsync`
   the containing directory before returning 200**. Syncing the file alone does
   not make the new directory entry durable on Linux, so a power loss can lose an
   attachment the server already acknowledged, leaving a persisted message
   pointing at nothing (reviewer-a).

**A duplicate upload is allowed when the store is full.** Identical bytes consume
no new stored bytes, so the quota check must be evaluated against what would
actually be *added* — rejecting a duplicate at 100% capacity would fail a request
that costs nothing.
**Response `200`**

```json
{"ok": true, "sha256": "<64 hex>", "size": 12345, "existing": false}
```

`existing: true` when those bytes were already stored. Not an error.

**Known property, flagged rather than fixed** (second-impl): `existing` is a
content-existence oracle — upload bytes, see `true`, and you have learned those
exact bytes were uploaded before. Acceptable under the room's LAN-trust model,
and recorded here so it is a known property rather than a later surprise, in the
same way `from` being unauthenticated is.

---

## 4. The message field

`POST /send` accepts an additional optional key:

```json
{
  "from": "operator",
  "text": "here is the crash",
  "channel": "shop",
  "attachments": [
    {"name": "crash.png", "sha256": "<64 hex>", "size": 12345}
  ]
}
```

**Server validation — all of these reject the whole message with `400` and append
nothing.** A dangling reference in the permanent log is not recoverable, so this
is validated before the append, inside the same lock as the append.

- `attachments` is an array, **max 10** entries.
- `sha256` matches `^[0-9a-f]{64}$`.
- `files/<sha256>.bin` **exists**.
- `size` equals the stored file's actual size on disk.
- `name` is a string, 1–200 chars, no path separators, no control characters.

**One canonical algorithm, and reject rather than repair** (reviewer-a). Revision
2 said both "invalid names reject the message" and "valid after sanitising",
which are different rules. The rule is: **validate and reject; do not sanitise
into validity.** The server appends exactly `{name, sha256, size}` and preserves
no additional keys from the client object, so the stored record is canonical and
four implementations cannot each carry a different extra field.

**`text` may be empty when `attachments` is non-empty.** That is the one behaviour
change to an existing rule, and it is deliberate: "send a picture with no caption"
is the common case.

**v1 degradation, stated explicitly:** a v1 client shows such a message as an
empty line from the sender. It does not crash and does not lose history. That is
acceptable; inventing placeholder text server-side would put a fabricated string
into the permanent record.

---

## 5. `GET /files/<sha256>?name=<display name>`

`404` on anything that is not exactly 64 lowercase hex characters, before any
filesystem access. No path is constructed from the request until it has matched
that pattern.

**The `name` query parameter is required for correct behaviour and was missing
from revision 1** (server-owner). The endpoint is hash-keyed, but the
inline-vs-download decision and the `Content-Disposition` filename both depend on
the display name — and the same bytes can legitimately be referenced by two
messages under two different names, so the server cannot derive it. The client
always has it from the message record and passes it.

`name` is used for **exactly two things**: reading its extension to consult the
inline allowlist, and filling `Content-Disposition`. It is **never** used to build
a path — the same rule the removed `X-Filename` had, now applied where a name is
actually needed.

**If `name` is absent or unusable, fail safe:** `application/octet-stream`,
`Content-Disposition: attachment`, filename `download`. Never inline.

**Headers on every response, without exception:**

```
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
```

**Inline allowlist — these four only:**

| Extension on the *display name* | Content-Type | Disposition |
|---|---|---|
| `.png` | `image/png` | `inline` |
| `.jpg` / `.jpeg` | `image/jpeg` | `inline` |
| `.gif` | `image/gif` | `inline` |
| `.webp` | `image/webp` | `inline` |

**Everything else** — including `.svg`, `.html`, `.htm`, `.xhtml`, `.pdf` and
anything unrecognised — is served as:

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="..."; filename*=UTF-8''...
```

**SVG is not an image for this purpose.** It is a script container with an image
extension, and it is the reason this allowlist is four entries rather than a MIME
table.

**Clients must percent-encode the `name` query value**, not concatenate it raw.
A permitted name containing `&`, `#`, `%` or `?` otherwise changes the URL's
meaning (reviewer-a).

**`Content-Disposition` needs both forms, escaped differently.** The ASCII
`filename=` fallback must escape `"` and `\`; `filename*` carries the RFC 5987
UTF-8 form. `\r` and `\n` are stripped from both — an unescaped filename is
header injection.

The display name comes from the *message record*, so the same bytes referenced
by two messages can download under two different names. That is correct.

---

## 6. Lifecycle — reference-based collection only

Added in revision 2 (second-impl). Revision 1 had no lifecycle at all, which is a
real gap and not a rate-limiting one: **a complete, valid upload that is never
referenced by a `/send` is orphaned forever.** That happens in ordinary use with
no malice — the sender changes their mind, the `/send` is rejected on some other
field, the client dies between the two calls. With a hard 2 GiB cap and no
reclaim, the store grows monotonically until every upload `507`s and a human has
to SSH in.

**The intuitive fix is destructive and must not be used.** Deleting by age
corrupts exactly the referential integrity §4 exists to protect: old messages
reference old files permanently, so an age-based sweep creates at DELETE time the
dangling reference that §4 prevents at WRITE time.

**The base rule:** `files/<sha256>.bin` is deletable **iff no message in
`chat-log.jsonl` references that sha256.** It scans the log, which is the cost of
being correct.

That rule alone is **not sufficient**, and revision 2 stated it in a way that was
actively wrong. Two corrections, both from review.

### 6a. Collection must be serialized with validation and append

**Revision 2 said collection should run "never inside the append lock". That was
my error and it creates the exact dangling reference §4 exists to prevent**
(reviewer-a). Under `ThreadingHTTPServer` there are two losing interleavings:

1. `/send` validates that the file exists → collection snapshots the log before
   the new message is appended, sees no reference, deletes → `/send` appends a
   permanent reference to a file that is gone.
2. Collection snapshots and decides "unreferenced" → `/send` validates and
   appends under the lock → collection deletes from its now-stale decision.

"On demand" is not mutual exclusion: a human can trigger it while a send is in
flight.

**Required:** one attachment-lifecycle critical section covering **all three**
state transitions, under a single lock or one documented acquisition order:

1. **Collector** — reference snapshot + grace/reference eligibility decision +
   delete.
2. **`/send`** — attachment validation + message append.
3. **Upload finalization** — final dedupe + unique-file quota commit + rename,
   **or** lease renewal on an existing file.

**Revision 3 covered only the first two, which is still broken** (reviewer-a).
The interleaving: an aged orphan exists; a duplicate upload hashes to it;
collection snapshots, sees no reference, decides it is eligible; the upload
observes `existing` and is about to renew the lease; collection deletes from its
stale decision; the upload returns `existing: true` and the following `/send`
fails because the file is gone. A variant deletes between the existence check
and the renewal.

Lease renewal is a lifecycle transition. If it is not in the critical section,
§6b's renewal rule is unenforceable.

### 6b. A grace window, and re-upload renews it

Even serialized, a file is legitimately unreferenced during the ordinary gap
between upload and send — attach a file, type a paragraph, send. A collector
that runs in that window kills a message the operator is still writing
(second-impl).

**Required:** a file is reclaimable only if unreferenced **AND** older than a
grace window **≥ the longest plausible upload-to-send gap. Use 1 hour.** Against
a 2 GiB cap the cost of an orphan lingering an extra hour is nothing.

This belongs in the spec and not in one server's code, and the test for that is
the right one: *could a second conforming implementation omit it and still pass
the gate?* Under revision 2, yes — which is how a silent correctness dependency
bites the next implementer.

**Also required** (reviewer-a): a successful upload of bytes that already exist as
an aged orphan **renews the grace lease**. Otherwise an old orphan can be
re-uploaded and collected before its `/send` lands.

**Optional, not required if the above exists:** a per-origin byte budget keyed on
the server-stamped `origin` field, bounding how much of the shared 2 GiB one host
can occupy before collection runs.

---

## 7. Client behaviour (client-author)

- **Images inline**, everything else a download chip showing name and size.
- The renderer's existing **block and span caps apply to attachments too** — a
  message with 10 attachments must not become 10 unbounded widgets. This is the
  fourth place the amplification class could appear; it has already appeared in
  three.
- An attachment whose `GET` fails renders as a broken chip naming the file, never
  as a silent gap.
- Upload progress and failure must be visible in the composer. A 413 or 507 has
  to say which limit was hit.

---

## 8. What the gate will check

Written here so the tests exist before the review, not after.

| Case | Required outcome |
|---|---|
| `?name=../../etc/passwd` on download | nothing read outside `files/`; served as `attachment` |
| `GET /files/../../server.py`, encoded and backslash variants | `404`, nothing disclosed |
| `?name` absent entirely | `octet-stream` + `attachment`, **never inline** |
| `?name=x.svg` | `application/octet-stream` + `attachment`, never `image/svg+xml` |
| `?name=x.html` | same |
| Same sha256 fetched with `?name=a.png` and `?name=b.txt` | inline for the first, attachment for the second — the name decides, not the bytes |
| Backdated orphan (older than grace), never `/send`, sweep | file **reclaimed** |
| Fresh orphan (inside grace), never `/send`, sweep | file **RETAINED** |
| Upload, `/send`, sweep immediately | file **RETAINED** — the one that matters |
| Age-based deletion of a referenced file | must not exist as a code path |
| Re-upload of aged orphan bytes, then sweep before `/send` | **RETAINED** — the lease renewed |
| Pause `/send` after its exists check, run collection, release `/send` | **impossible** to append a reference whose file was deleted |
| Pause collection after its snapshot, let `/send` append, then let it delete | **impossible** — the stale decision must not delete |
| Two concurrent uploads that each fit alone but not together | at most **one** commits; store stays within the cap |
| Abort a body mid-upload | no temp survives, **no reservation leaks** |
| Duplicate upload while the store is at capacity | **accepted** — it adds no bytes |
| Store at cap: duplicate upload **concurrent with** a unique upload | duplicate **succeeds**; unique gets **507 at commit**; in-flight accounting bounded; no reservation leaks |
| Pause a re-upload before lease renewal, run collection, then release it | file **RETAINED** — collection must not delete from a stale eligibility decision |
| HTML bytes fetched as `?name=x.png`, as `<img>` **and** by direct navigation | not rendered as a document |
| `name` containing `&`, `#`, `%`, `?` | URL semantics unchanged; correct file served |
| `name` containing `"` and `\` | escaped in `filename=`; `filename*` carries the UTF-8 form |
| `Content-Length` over 25 MiB | `413`, nothing written to `files/` |
| Total quota exceeded | `507`, **existing files intact** |
| `attachments` naming a sha256 that does not exist | `400`, **message not appended** |
| `size` disagreeing with the stored file | `400`, message not appended |
| 11 attachments | `400` |
| Same bytes uploaded twice | one file on disk, second response `existing: true` |
| v1 reader on `/stream` | still parses messages carrying `attachments` |
| Filename containing `\r\n"` | no header injection in `Content-Disposition` |

Every one of these should be **falsified** before it is claimed: break the guard,
watch the test go red, restore it.
