# Original PDF downloads

Choose **PDF** above the links box, paste a direct PDF address or a page containing PDF links,
then identify and download. Video/audio keeps the existing path and output preferences.
Each queue job remembers its own type, so a page can supply both a video and a PDF.
PDF jobs ignore MP4/MP3 and quality settings; their original bytes are saved as `.pdf`.

For pages requiring an account, open the page in the signed-in browser, choose **PDF** in the
Grab extension, then Send to Grab. Extension version **1.2.0** is required (repair/update from
Grab settings, then Reload the unpacked extension). Sending remains automatic and retains the
sending browser and profile. Multiple documents require a choice in Grab or the popup.

Supported sources:
- Direct HTTP(S) files, including addresses without a `.pdf` suffix when their response is PDF.
- Links ending in `.pdf`, including relative addresses and signed query strings.
- `iframe`, `embed` and `object` PDF sources and MIME/download hints.
- Extension observations of `application/pdf` responses, including frame/page responses.
- An original PDF opened in a browser PDF viewer when its tab URL or observed response is available.

The public HTTP route scans bounded HTML (4 MiB), not JavaScript execution. Use the extension for
links added by JavaScript. Browser-only `blob:`/`data:` documents, click-generated POST downloads
and pages that do not expose the original HTTP(S) document are not supported by this version.
No PDF is generated from HTML. The scanner does not crawl unrelated linked pages or click buttons.

## Integrity and privacy

Downloads stream to an allocated partial file, check the PDF signature and EOF marker and the
response length when provided, then publish a completed file without replacing an existing one.
These structural checks detect common HTML/login responses and truncated transfers; they are not
a full PDF parser or a malware scan. Maximum size: 1 GiB. Lookup deadline: 45 seconds per PDF
request sequence; transfer deadline: 30 minutes. Cancellation aborts the transfer and removes its
partial file. Resuming a paused PDF starts the file again (no HTTP range resume in this version).

Account cookies use the existing vault and per-profile lifecycle. The HTTP adapter reapplies
host-only/domain/path/secure/expiry checks at every redirect and rejects HTTPS downgrades.
Session-required PDF jobs never switch to the public adapter. A restored PDF job re-discovers its
source; original selected document URLs, cookies and headers are not persisted. A page with several
PDFs may require selection again after a restart. Completed files appear in the existing library
and PDF history entries keep the PDF type for re-download.

## Verification

Local validation: renderer build passes; 272 tests pass in the compatible suite (26 platform/tool
skips; the three existing Unix/native-host suites cannot run on this host). The full `npm test`
was attempted and is not green here because those suites cannot open Unix sockets. No production
test was disabled.

`e2e/pdf-download.cjs` covers actual PDF mode selection, paste, guarded IPC, selection among two
originals, streaming and history. It and queue-cooldown pass in real headless Electron with a
local harness replacing only the unavailable singleton-lock API; native-host integration is not
claimed by these runs. The real hidden-probe check passes independently. Before/after captures
cover downloads, history, library, settings and both dialogs; the PDF mode/choice layout was also
inspected. CI now runs the PDF UI check with the ordinary app lock on its normal Linux host.

The new regression coverage exercises the real coordinator, discovery service, runner, allocator,
file storage and cookie vault with a deterministic HTTP transport, plus the shipped extension
worker and BrowserService with controlled browser messages. It covers byte-for-byte original
files, public/embedded links, choices, cookies/redirects, cancellation, invalid/truncated bodies,
no overwrite, queue restoration and the existing direct video route.

Pending installed Windows acceptance:
1. Reload extension 1.2.0 in Chrome, Edge and Brave; check PDF Send in the sending profile.
2. Download a direct public PDF and one embedded in a page; compare SHA-256 to the original.
3. On a real signed-in page, Send PDF, choose between two documents, and verify the saved file.
4. Pause, restart Grab and resume; the original page is rediscovered and the account is preserved.
5. Confirm library open/reveal and history download-again for PDF; smoke-test normal video paste.
6. Capture before/after screenshots of every screen and the extension; verify RTL layout and no
   unrelated screen changes. Run the existing Electron queue-cooldown and hidden-probe checks.


## Loaded-document detection fix (extension 1.2.1)

PDF network observations now last for the current document rather than expiring after ten
minutes; navigation and closing the tab still discard them, and the per-tab limit is unchanged.
Fetch/XHR responses with a PDF filename in Content-Disposition are recognized even when served
as application/octet-stream. Discovery also reads the current frames' Resource Timing entries
for original PDF URLs already fetched before observation, using PDF path, response query or MIME
hints. Signed query strings are preserved without replaying arbitrary page requests.

This cannot recover an opaque URL fetched before observation if its timing entry is missing or
has no PDF hint (cross-origin timing can hide MIME). An expired signed URL still requires a fresh
original from the site. Blob/data originals remain unsupported. Reload extension 1.2.1 before
installed testing. Real signed-in Whop and installed Windows acceptance remain pending.


Targeted verification: 47 PDF/worker/session tests passed, including the shipped collector inside
the worker, pre-observed signed URLs, observation retention/navigation cleanup, Content-Disposition,
and exact-byte downloads over real local HTTP. Another 31 extension/architecture/setup tests
passed (3 platform/tool skips). Renderer build and git diff whitespace checks passed. The full
suite was attempted; native Unix socket creation returns EPERM on this host, preventing the
native-host/BrowserHub integration tests. No tests were disabled. No Windows installer or live
Whop validation is claimed.
