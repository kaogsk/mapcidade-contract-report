/**
 * "Cloud storage in use" — the disks of the city's VM: the system disk (`/`) and the data disks
 * (`/opt/disk01`, `/data2`…), with total, used and free space.
 *
 * Earlier versions printed the size of the database, which is not what the contract means by
 * storage. The VM is the city's database server (same address), reached over SSH, and the only
 * command ever sent is `df`: the RemoteShell is handed one fixed, read-only command line.
 */
import type { Disk } from "../report.js";
import type { RemoteShell } from "./types.js";

/** The only command this module runs. `-l`: local disks only (network shares stay out). */
export const DF_COMMAND = "df -B1 -P -l";

const GIB = 1024 ** 3;
const gb = (bytes: number) => Math.round((bytes / GIB) * 10) / 10;

/** Mount points that go into the report besides `/`. */
const DATA_MOUNT = /^\/(?:opt\/)?disk\d+$|^\/(?:opt\/)?data\d*$/;

export function diskName(mount: string): string {
  if (mount === "/") return "System disk (OS)";
  const n = mount.match(/(\d+)$/)?.[1];
  return n ? `Data disk ${n.padStart(2, "0")}` : `Data disk (${mount})`;
}

/** Output of `df -B1 -P` → report disks (system first, then data disks by mount point). */
export function parseDf(output: string): Disk[] {
  const disks: Disk[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/).slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 6) continue;
    const [dev, total, used, free] = c as [string, string, string, string];
    const mount = c.slice(5).join(" ");
    if (!dev.startsWith("/dev/") || seen.has(mount)) continue;
    if (mount !== "/" && !DATA_MOUNT.test(mount)) continue;
    seen.add(mount);
    disks.push({ name: diskName(mount), mount, totalGb: gb(Number(total)), usedGb: gb(Number(used)), freeGb: gb(Number(free)) });
  }
  return disks.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount)));
}

export async function readVmDisks(shell: RemoteShell, host: string, signal: AbortSignal): Promise<Disk[]> {
  const out = await shell.exec(host, DF_COMMAND, signal);
  const disks = parseDf(out);
  if (!disks.length) throw new Error(`df on ${host} listed no recognizable disk`);
  return disks;
}

// ── fake ────────────────────────────────────────────────────────────────────

export interface FakeVm {
  /** Canned `df -B1 -P -l` output. */
  df?: string;
  /** "refuse" = connection refused at once; "hang" = never answers (the deadline cuts it). */
  behavior?: "ok" | "refuse" | "hang";
  latencyMs?: number;
}

/**
 * Stands in for SSH. Like the real one it only knows how to run `df`, takes a moment to log in,
 * and can be unreachable or silent. Unknown host = connection refused.
 */
export class FakeRemoteShell implements RemoteShell {
  constructor(private readonly vms: Record<string, FakeVm>) {}

  exec(host: string, command: string, signal: AbortSignal): Promise<string> {
    if (command !== DF_COMMAND) return Promise.reject(new Error(`command not allowed: ${command}`));
    const vm = this.vms[host];
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const timer = vm?.behavior === "hang" ? undefined : setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        if (!vm || vm.behavior === "refuse") reject(new Error(`SSH ${host}: connect ECONNREFUSED ${host}:22`));
        else resolve(vm.df ?? "");
      }, vm?.latencyMs ?? 50);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error(`SSH ${host}: aborted`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
