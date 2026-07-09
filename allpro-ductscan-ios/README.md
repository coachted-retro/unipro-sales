# AllPro Duct Scan (iOS)

Native LiDAR app used only for the AllPro duct-run scan step. Everything else
in Termac One stays in the browser — this exists because LiDAR is not
reachable from a web page on any platform, only through ARKit in a native app.

Requires iPhone 12 Pro or later Pro model, or iPad Pro 2020+. No other device
will run the scan (the app will show a message and disable the scan button
on unsupported hardware).

## What it does

1. Rep enters the Termac One project ID for the job (the `APR-...` id from
   the AllPro Project Planner).
2. Rep taps the top of the hood collar in the live camera view (point 1),
   then taps the underside of the deck directly above it (point 2). Both
   taps hit-test against the real LiDAR mesh, so these are true 3D points,
   not screen guesses.
3. The app scans mesh geometry between those two points and flags anything
   in the way as `unknown_obstruction` — it does not attempt to identify
   *what* the obstruction is (joist vs. pipe vs. conduit). That's a real
   limitation, not an oversight; classifying obstacle type from raw mesh
   data needs trained object detection, which is a follow-up project.
4. On Finish Scan, the result (deck height, run length, obstacle list)
   posts straight to the same `termac-d1-api` Worker every other part of
   the platform uses, into that project's record.

## What's still needed before this can ship to a phone

- **An Apple Developer Program account** ($99/yr). Without it, Xcode can
  sideload a build for free, but it expires and needs reinstalling every
  7 days.
- **CI signing secrets** in the repo's GitHub Actions settings:
  `IOS_TEAM_ID`, `IOS_P12_BASE64`, `IOS_P12_PASSWORD`,
  `IOS_PROVISIONING_PROFILE_BASE64`. Until these exist, the workflow only
  does an unsigned compile check on every push — useful for catching
  syntax errors early, but it won't produce an installable file.
- **This code has not been compiled or run.** Writing it required no Mac,
  no Xcode, no LiDAR device — so treat this as a first draft to build and
  test on an actual iPhone 13 Pro before trusting it on a real job. Expect
  to find and fix real bugs the first time it actually runs against LiDAR
  hardware, especially the obstacle-clustering radius and tap hit-testing
  feel, both of which are easier to tune by hand on-device than to guess
  correctly from code alone.
- **Confirm which Worker URL is actually live.** `termac-d1-sync.js` on the
  web side points at `unipro-ai-proxy.termac-one.workers.dev`, while other
  memory notes reference `termac-d1-api.termac-one.workers.dev` directly.
  `TermacAPIClient.swift` is set to the latter — verify that's correct
  before this talks to production data.
