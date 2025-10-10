//! True Modules — Port traits (scaffold)

use std::path::{Path, PathBuf};

pub struct DiffSpec {
    pub paths: Vec<PathBuf>,
}

pub struct DiffResult {
    pub summary: String,
}

pub trait DiffPort {
    fn diff(&self, spec: DiffSpec) -> Result<DiffResult, String>;
}

pub trait IndexPort {
    fn stage(&self, paths: &[PathBuf]) -> Result<(), String>;
    fn unstage(&self, paths: &[PathBuf]) -> Result<(), String>;
}

pub struct WorktreeRef {
    pub root: PathBuf,
}

pub trait WorktreePort {
    fn create(&self, base: &Path, name: &str) -> Result<WorktreeRef, String>;
    fn cleanup(&self, wt: WorktreeRef) -> Result<(), String>;
}

pub trait SafetyPort {
    fn normalize_path(&self, p: &Path) -> Result<PathBuf, String>;
    fn is_safe(&self, p: &Path) -> bool;
}
