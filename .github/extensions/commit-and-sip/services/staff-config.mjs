import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, requireValue, validateStaffConfig } from "../domain.mjs";

// Call writes only under the shared provisioning ledger lock. Staff must pause
// intake and external config editors; rename is atomic, not a filesystem CAS.
export class StaffConfigFile {
  constructor(path) { this.path = path; }

  async read() {
    requireValue((await lstat(this.path)).isFile(), "invalid_config", "Use a regular staff configuration file, not a symbolic link.");
    this.original = await readFile(this.path, "utf8");
    return validateStaffConfig(JSON.parse(this.original));
  }

  async write(config) {
    const temporary = join(dirname(this.path), `.staff-config-${randomUUID()}.tmp`);
    try {
      requireValue(await readFile(this.path, "utf8") === this.original, "config_changed",
        "Staff configuration changed concurrently. Retry the same run; no assignment was overwritten.");
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
        await file.sync();
      } finally { await file.close(); }
      requireValue(await readFile(this.path, "utf8") === this.original, "config_changed",
        "Staff configuration changed concurrently. Retry the same run.");
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("config_write_failed",
        "Staff configuration could not be durably saved. The issue binding is preserved in the journal. Restore storage and retry the exact run; do not create a new issue.");
    } finally { await rm(temporary, { force: true }); }
  }
}
