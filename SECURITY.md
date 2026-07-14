# Security policy

## Supported versions

Until 1.0, security fixes are released on the latest minor version only.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisory form](https://github.com/knapcio/resilient-webcam/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include the affected version, browser or Electron version, a minimal
reproduction, and the impact. Please avoid including camera images, access
tokens, device labels, or other personal data. You should receive an
acknowledgement within seven days.

## Scope

This library requests a local video stream and can return a caller-owned
`Blob`. It does not upload, persist, or transmit frames, and it includes no
telemetry. Applications remain responsible for permission prompts, consent,
storage, transport, Electron permission handlers, and response headers.
