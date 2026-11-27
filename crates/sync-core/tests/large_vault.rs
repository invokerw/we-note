//! Driver for tests/performance/sync.py. All paths belong to the temporary fixture.
use anyhow::Result;
use std::{env, path::PathBuf, time::Instant};
#[test]
#[ignore = "run tests/performance/sync.py"]
fn measure_sync() -> Result<()> {
    let dir = PathBuf::from(env::var("WENOTE_BENCH_DIR")?);
    let start = Instant::now();
    let report = wenote_sync::synchronize(
        &env::var("WENOTE_BENCH_ORIGIN")?,
        "test",
        "vault",
        &dir.join("notes"),
        &dir.join("state"),
    )?;
    println!(
        "SYNC_MS={} DOWNLOADS={} SCAN_BODY_BYTES={}",
        start.elapsed().as_millis(),
        report.downloaded,
        report.scan_bytes
    );
    Ok(())
}
