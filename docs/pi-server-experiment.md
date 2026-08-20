# Experimental Pi server runtime

The dashboard has a bounded experiment for an externally supervised
`@earendil-works/pi-server` Unix socket. It is **off by default**. Enable it
only with both:

```sh
PI_DASHBOARD_EXPERIMENTAL_PI_SERVER=1
PI_DASHBOARD_PI_SERVER_SOCKET=/path/to/pi-server.sock
```

The dashboard does not start or implement `PiServerService`; the upstream
server host remains responsible for that service. Durable runs use
`pi-server` as their default provider while this flag and socket are present.
Explicit `extension-bridge` and legacy/manual launches remain tmux-backed.
Read-mode runs also stay on tmux because PiClient 0.84.1 cannot enforce Pi's
read-only tool allowlist. Native connect/create/acquire failures are cleaned up and fall back to tmux;
once an exclusive lease is established, failure is fail-closed rather than
starting a second runtime. The actual runtime snapshot therefore exposes the
managed Pi session ID, while a tmux fallback is observable as a tmux placement.

The virtual bridge is intentionally narrow. It maps authoritative Pi session
snapshots and prompt, steer, abort, model, and thinking commands to the
existing bounded `RuntimeRegistry` protocol. Protocol v1 requires a positive
`pid`, but pi-server does not expose one; the compatibility snapshot uses the
daemon PID and the manager never signals it. It advertises no extension
capabilities. PiClient has no automatic reconnect, so a
native disconnect interrupts the run. Daemon restart recovery is unsupported:
the daemon does not relaunch a Pi session or duplicate its prompt.

| Concern | Result |
| --- | --- |
| reconnect | Unsupported; disconnect interrupts and cleans up the lease |
| extension compatibility | Unsupported in this experiment; no capabilities are faked |
| memory scope | Upstream Pi session memory, isolated by an exclusive lease |
| isolation | One provider context and bounded virtual queue per runtime |
| daemon restart | Fail-closed; no relaunch/re-prompt |
| multi-session correctness | Exclusive acquire plus per-runtime context |
| transcript fidelity | Pi snapshots are authoritative and retained as protocol entries; extension/live detail is not projected |
