# Capture integrity (fixture)

Sample: 1 synthetic session, 31 tape events, 4 snapshots, 9 snapshot files.

Coverage: 12/14 pass; missed states: rapid edit/revert, torn tail.

Capture quality `partial` persisted by ingest, identical to a direct finalizeMuseSession call on the same inputs.

Raw-secret scan over tape, shadow blobs, spool, SQLite, logs, and demo bundle: 0 findings (zero tolerance).

Caveats: synthetic fixture, single session, no real Muse build; intermediates asserted absent on artifacts, not proven for the filesystem.

Not measured here (need real tapes, stay manual): citation support, refusal rate, check pass rate, time to first check, hunk selection, attempt tree.

Echo commit: add2c5f126a97d153e1c5725f23bcad40fcd6def
