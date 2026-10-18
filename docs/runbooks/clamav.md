# Runbook: ClamAV for document scanning

Scope: the clamd daemon that `DOCUMENT_SCAN_MODE=clamd` uses (ADR 0005). Synthetic documents only until real-document handling is approved.

## Why the settings matter

clamd answers `stream: OK` for files it did not fully scan when they exceed its size or recursion limits, unless `AlertExceedsMax` is on. The scanner treats `OK` as clean, and a clean document becomes eligible for OCR. These settings make "clean" mean "fully scanned":

```text
TCPSocket 3310
TCPAddr 127.0.0.1
StreamMaxLength 16M
MaxScanSize 100M
MaxFileSize 16M
MaxRecursion 16
AlertExceedsMax yes
AlertEncrypted yes
AlertBrokenExecutables yes
ScanPDF yes
```

`StreamMaxLength` must be at least the 15 MiB upload cap. A larger upload is refused by clamd with an error, which the worker treats as a deferral, not as clean.

## Local (Homebrew)

```bash
brew install clamav
```

Copy `clamd.conf.sample` and `freshclam.conf.sample` from `$(brew --prefix)/etc/clamav/`, remove the `Example` lines, apply the settings above, then:

```bash
freshclam
```

```bash
clamd --foreground
```

Run the API with `DOCUMENT_SCAN_MODE=clamd`, `CLAMD_HOST=127.0.0.1`, `CLAMD_PORT=3310`. At startup the server logs `document_scanner_unreachable` if clamd does not answer `PING`.

## Azure

Run clamd as a container in the same virtual network as the App Service, listening only on the private interface, with the settings above and a scheduled `freshclam`. Never expose port 3310 publicly. This is not provisioned yet.

## Checks

- A synthetic EICAR test file must be reported as `FOUND`.
- Pending documents with a growing `scan_attempts` mean clamd is unreachable or misconfigured; they resume automatically once it is fixed.

Not verified in this repository: a real clamd run. Tests use a fake clamd server.
