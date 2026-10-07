# WoHo AI Desktop

Windows desktop foundation for WoHo AI.

## Current step

This step provides the Tauri desktop shell and a bundled chat UI. The application is intentionally dependency-light so it does not introduce a second JavaScript runtime or an AI provider yet.

## Local development

From this directory:

```bash
cargo tauri dev
```

The next step connects `@woho/agents` to the desktop execution bridge.

## Build

```bash
cargo tauri build
```

This produces the native Windows installer/binary when run on the appropriate target environment.
